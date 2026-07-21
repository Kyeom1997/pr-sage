import { describe, expect, it } from "vitest";
import { runReview, splitOversizedFiles } from "../src/review.js";
import { commentableLines } from "../src/diff.js";
import type { DiffFile, Provider } from "../src/types.js";

function makeFile(path: string, lines = 3): DiffFile {
  const patch = `@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+l${i}`).join("\n")}\n`;
  return { path, status: "modified", patch, commentableLines: commentableLines(patch) };
}

/** Provider stub that answers by schema shape: review → verify → consolidate. */
function fakeProvider(handlers: {
  review: (user: string) => unknown;
  verify?: (user: string) => unknown;
  consolidate?: (user: string) => unknown;
}): Provider {
  return {
    name: "gemini",
    model: "fake",
    async generate(_system, user, schema: Record<string, unknown>) {
      const props = Object.keys((schema.properties as object) ?? {});
      if (props.includes("verdicts")) return handlers.verify!(user);
      if (props.includes("findings")) return handlers.review(user);
      return handlers.consolidate!(user);
    },
  };
}

const baseOptions = {
  locale: "English",
  exclude: [],
  batchCharBudget: 80_000,
  log: () => {},
};

describe("runReview end-to-end (fake provider)", () => {
  it("reviews, validates against the diff, and stamps the sha marker", async () => {
    const provider = fakeProvider({
      review: () => ({
        summary: "looks ok",
        findings: [
          { path: "a.ts", line: 2, severity: "warning", title: "real", body: "b" },
          { path: "a.ts", line: 42, severity: "critical", title: "ghost line", body: "b" },
          { path: "ghost.ts", line: 1, severity: "warning", title: "ghost file", body: "b" },
        ],
      }),
    });
    const { result, dropped } = await runReview(
      provider,
      { title: "T", body: "", files: [makeFile("a.ts")], headSha: "abc1234" },
      baseOptions,
    );
    expect(result.findings.map((f) => f.title)).toEqual(["real"]);
    expect(dropped).toHaveLength(2);
    expect(result.summary).toContain("<!-- pr-sage sha:abc1234 -->");
    expect(result.summary).toContain("1 warning");
  });

  it("verify pass drops unconfirmed findings", async () => {
    const provider = fakeProvider({
      review: () => ({
        summary: "s",
        findings: [
          { path: "a.ts", line: 1, severity: "warning", title: "keep", body: "b" },
          { path: "a.ts", line: 2, severity: "warning", title: "reject", body: "b" },
        ],
      }),
      verify: () => ({
        verdicts: [
          { index: 0, confirmed: true },
          { index: 1, confirmed: false },
        ],
      }),
    });
    const { result } = await runReview(
      provider,
      { title: "T", body: "", files: [makeFile("a.ts")], headSha: "" },
      { ...baseOptions, verify: true },
    );
    expect(result.findings.map((f) => f.title)).toEqual(["keep"]);
  });

  it("consolidates multi-batch summaries via the model", async () => {
    let consolidateInput = "";
    const provider = fakeProvider({
      review: () => ({ summary: "partial", findings: [] }),
      consolidate: (user) => {
        consolidateInput = user;
        return { summary: "MERGED" };
      },
    });
    const files = [makeFile("a.ts", 20), makeFile("b.ts", 20)];
    const { result } = await runReview(
      provider,
      { title: "T", body: "", files, headSha: "" },
      { ...baseOptions, batchCharBudget: files[0]!.patch.length + 1 },
    );
    expect(consolidateInput).toContain("Partial summary 2");
    expect(result.summary).toContain("MERGED");
  });
});

describe("splitOversizedFiles", () => {
  it("splits along hunk boundaries and keeps line numbers intact", () => {
    const hunk1 = "@@ -1,2 +1,2 @@\n+a\n+b\n";
    const hunk2 = "@@ -50,2 +50,2 @@\n+c\n+d\n";
    const file: DiffFile = {
      path: "big.ts",
      status: "modified",
      patch: hunk1 + hunk2,
      commentableLines: commentableLines(hunk1 + hunk2),
    };
    const parts = splitOversizedFiles([file], hunk1.length + 1);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.status).toBe("modified, part 1/2");
    expect([...parts[0]!.commentableLines]).toEqual([1, 2]);
    expect([...parts[1]!.commentableLines]).toEqual([50, 51]);
  });

  it("leaves small files untouched", () => {
    const file = makeFile("small.ts");
    expect(splitOversizedFiles([file])).toEqual([file]);
  });
});
