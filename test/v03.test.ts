import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/localdiff.js";
import { validateFindings, commentableLines } from "../src/diff.js";
import { sanitizeFindings } from "../src/review.js";
import { parseVerdicts, parseSummary } from "../src/validate.js";
import { toSarif } from "../src/output.js";
import { shaMarker } from "../src/github.js";
import type { DiffFile, Finding, Provider } from "../src/types.js";

const GIT_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " console.log(a);",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,1 @@",
  "+hello",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses files, skips deletions, detects added files", () => {
    const files = parseUnifiedDiff(GIT_DIFF);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.ts", "modified"],
      ["new.ts", "added"],
    ]);
    expect([...files[0]!.commentableLines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...files[1]!.commentableLines]).toEqual([1]);
  });
});

function fileWithLines(path: string, patch: string): DiffFile {
  return { path, status: "modified", patch, commentableLines: commentableLines(patch) };
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts",
  line: 1,
  severity: "warning",
  title: "t",
  body: "b",
  ...overrides,
});

describe("multi-line findings", () => {
  const file = fileWithLines("src/a.ts", "@@ -1,3 +1,3 @@\n+one\n+two\n+three\n");

  it("keeps valid ranges", () => {
    const { valid } = validateFindings([finding({ line: 1, endLine: 3 })], [file]);
    expect(valid[0]?.endLine).toBe(3);
  });

  it("downgrades ranges that leave the diff to single-line", () => {
    const { valid } = validateFindings([finding({ line: 2, endLine: 9 })], [file]);
    expect(valid[0]?.line).toBe(2);
    expect(valid[0]?.endLine).toBeUndefined();
  });

  it("allows multi-line suggestions on range findings only", () => {
    const [ranged] = sanitizeFindings([finding({ line: 1, endLine: 3, suggestion: "a\nb" })]);
    expect(ranged?.suggestion).toBe("a\nb");
    const [single] = sanitizeFindings([finding({ suggestion: "a\nb" })]);
    expect(single?.suggestion).toBeUndefined();
  });
});

describe("verdict and summary parsing", () => {
  it("parses verdicts and rejects malformed shapes", () => {
    expect(parseVerdicts({ verdicts: [{ index: 0, confirmed: true }] })).toEqual([
      { index: 0, confirmed: true },
    ]);
    expect(() => parseVerdicts({ verdicts: [{ index: -1 }] })).toThrow();
    expect(parseSummary({ summary: "ok" })).toBe("ok");
  });
});

describe("sarif output", () => {
  it("emits valid structure with mapped levels", () => {
    const provider = { name: "gemini", model: "m" } as Provider;
    const sarif = JSON.parse(
      toSarif(
        { summary: "s", findings: [finding({ severity: "critical", endLine: 2 })] },
        provider,
      ),
    );
    const result = sarif.runs[0].results[0];
    expect(result.level).toBe("error");
    expect(result.locations[0].physicalLocation.region).toEqual({ startLine: 1, endLine: 2 });
  });
});

describe("sha marker", () => {
  it("round-trips through the history regex", () => {
    expect(shaMarker("abc1234")).toBe("<!-- pr-sage sha:abc1234 -->");
  });
});
