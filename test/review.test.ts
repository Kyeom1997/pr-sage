import { describe, expect, it } from "vitest";
import { filterFiles, sanitizeFindings } from "../src/review.js";
import { parseReviewResult } from "../src/validate.js";
import { severityAtLeast } from "../src/types.js";
import { isRetryable } from "../src/retry.js";
import { commentableLines } from "../src/diff.js";
import type { DiffFile, Finding } from "../src/types.js";

function makeFile(path: string): DiffFile {
  const patch = "@@ -1,1 +1,1 @@\n+x\n";
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

describe("filterFiles with globs", () => {
  const files = [makeFile("src/a.ts"), makeFile("src/gen/api.ts"), makeFile("docs/readme.md")];

  it("supports glob patterns", () => {
    expect(filterFiles(files, ["src/gen/**"]).map((f) => f.path)).toEqual([
      "src/a.ts",
      "docs/readme.md",
    ]);
    expect(filterFiles(files, ["**/*.md"]).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/gen/api.ts",
    ]);
  });

  it("still supports plain substrings", () => {
    expect(filterFiles(files, ["docs/"]).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/gen/api.ts",
    ]);
  });
});

describe("sanitizeFindings", () => {
  it("keeps single-line suggestions, trimming trailing newlines", () => {
    const [f] = sanitizeFindings([finding({ suggestion: "const x = 1;\n" })]);
    expect(f?.suggestion).toBe("const x = 1;");
  });

  it("demotes multi-line suggestions to a code block in the body", () => {
    const [f] = sanitizeFindings([finding({ suggestion: "line1\nline2" })]);
    expect(f?.suggestion).toBeUndefined();
    expect(f?.body).toContain("line1\nline2");
  });
});

describe("parseReviewResult", () => {
  it("drops malformed findings but keeps valid ones", () => {
    const logs: string[] = [];
    const result = parseReviewResult(
      {
        summary: "ok",
        findings: [finding(), { path: "x", line: "not-a-number" }, finding({ line: 5 })],
      },
      (m) => logs.push(m),
    );
    expect(result.findings).toHaveLength(2);
    expect(logs[0]).toContain("1 malformed");
  });

  it("throws on a malformed overall shape", () => {
    expect(() => parseReviewResult({ nope: true }, () => {})).toThrow(/malformed review output/);
  });
});

describe("severityAtLeast", () => {
  it("orders severities correctly", () => {
    expect(severityAtLeast("critical", "warning")).toBe(true);
    expect(severityAtLeast("warning", "warning")).toBe(true);
    expect(severityAtLeast("nitpick", "warning")).toBe(false);
  });
});

describe("isRetryable", () => {
  it("detects rate-limit errors by status and message", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe(true);
    expect(isRetryable(new Error("model overloaded, please retry"))).toBe(true);
    expect(isRetryable(new Error("invalid api key"))).toBe(false);
  });
});
