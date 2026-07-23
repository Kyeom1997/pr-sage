import { describe, expect, it } from "vitest";
import { activeMarker, findingKey, replaceActiveMarker } from "../src/github.js";
import { runReview } from "../src/review.js";
import { commentableLines } from "../src/diff.js";
import { resolveEvent } from "../src/event.js";
import type { DiffFile, Provider } from "../src/types.js";

const file = (path: string): DiffFile => {
  const patch = "@@ -1,1 +1,1 @@\n+x\n";
  return { path, status: "modified", patch, commentableLines: commentableLines(patch) };
};

const provider: Provider = {
  name: "gemini",
  model: "fake",
  async generate() {
    return { summary: "ok", findings: [] };
  },
};

describe("review coverage", () => {
  it("never auto-approves an incomplete review", () => {
    expect(resolveEvent("auto", [], false)).toBe("COMMENT");
    expect(resolveEvent("auto", [], true)).toBe("APPROVE");
  });

  it("reports path-scoped reviews as partial against the full change", async () => {
    const { result } = await runReview(
      provider,
      { title: "t", body: "", files: [file("packages/web/a.ts")], headSha: "abc" },
      {
        locale: "English",
        exclude: [],
        batchCharBudget: 1000,
        totalFiles: 2,
        log: () => {},
      },
    );
    expect(result.coverage).toMatchObject({
      complete: false,
      totalFiles: 2,
      reviewedFiles: 1,
      reasons: ["path-filter"],
    });
    expect(result.summary).toContain("partial");
  });

  it("reports configured exclusions instead of silently claiming full coverage", async () => {
    const { result } = await runReview(
      provider,
      { title: "t", body: "", files: [file("dist/a.js")], headSha: "" },
      {
        locale: "English",
        exclude: ["dist/"],
        batchCharBudget: 1000,
        log: () => {},
      },
    );
    expect(result.coverage?.complete).toBe(false);
    expect(result.coverage?.reasons).toContain("excluded");
  });
});

describe("path policies and verifier routing", () => {
  it("applies a per-path minimum severity", async () => {
    const findingProvider: Provider = {
      name: "gemini",
      model: "reviewer",
      async generate() {
        return {
          summary: "found",
          findings: [{
            path: "docs/a.md",
            line: 1,
            severity: "suggestion",
            title: "Minor",
            body: "minor",
          }],
        };
      },
    };
    const { result } = await runReview(
      findingProvider,
      { title: "t", body: "", files: [file("docs/a.md")], headSha: "" },
      {
        locale: "English",
        exclude: [],
        batchCharBudget: 1000,
        pathRules: [{ paths: ["docs/**"], minSeverity: "warning" }],
        log: () => {},
      },
    );
    expect(result.findings).toEqual([]);
  });

  it("can use a separate provider for verification", async () => {
    let verifierCalls = 0;
    const reviewer: Provider = {
      name: "openai",
      model: "reviewer",
      async generate() {
        return {
          summary: "found",
          findings: [{
            path: "src/a.ts",
            line: 1,
            severity: "warning",
            title: "Bug",
            body: "bug",
          }],
        };
      },
    };
    const verifier: Provider = {
      name: "gemini",
      model: "verifier",
      async generate() {
        verifierCalls++;
        return { verdicts: [{ index: 0, confirmed: false }] };
      },
    };
    const { result } = await runReview(
      reviewer,
      { title: "t", body: "", files: [file("src/a.ts")], headSha: "" },
      {
        locale: "English",
        exclude: [],
        batchCharBudget: 1000,
        verify: true,
        verifier,
        log: () => {},
      },
    );
    expect(verifierCalls).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

describe("finding lifecycle markers", () => {
  it("stores stable active finding keys in a hidden marker", () => {
    const finding = {
      path: "src/a.ts",
      title: "Bug",
      line: 1,
      severity: "warning" as const,
      body: "body",
    };
    const key = findingKey(finding);
    const marker = activeMarker([key]);
    expect(marker).toContain("<!-- pr-sage active:");
    expect(replaceActiveMarker(`${marker}\nsummary`, [])).not.toBe(`${marker}\nsummary`);
  });
});
