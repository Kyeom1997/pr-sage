import { describe, expect, it } from "vitest";
import {
  annotatePatch,
  commentableLines,
  commentableOldLines,
  rightLineTexts,
  validateFindings,
} from "../src/diff.js";
import { batchFiles, filterFiles } from "../src/review.js";
import type { DiffFile, Finding } from "../src/types.js";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " console.log(a);",
  "@@ -10,2 +11,3 @@",
  " function tail() {",
  "+  return null;",
  " }",
].join("\n");

describe("commentableLines", () => {
  it("collects right-side line numbers across hunks", () => {
    const lines = commentableLines(PATCH);
    // Hunk 1 starts at new line 1: context(1), +(2), +(3), context(4)
    // Hunk 2 starts at new line 11: context(11), +(12), context(13)
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 11, 12, 13]);
  });

  it("does not advance the counter on deleted lines", () => {
    const lines = commentableLines("@@ -1,2 +1,1 @@\n-gone\n kept\n");
    expect([...lines]).toEqual([1]);
  });
});

describe("commentableOldLines", () => {
  it("collects old-file numbers of deleted lines", () => {
    // Hunk 1 old side starts at 1: ctx(1), -(2) → deletion at old line 2
    expect([...commentableOldLines(PATCH)]).toEqual([2]);
  });
});

describe("rightLineTexts", () => {
  it("maps new-file lines to their content", () => {
    const texts = rightLineTexts(PATCH);
    expect(texts.get(2)).toBe("const b = 3;");
    expect(texts.get(4)).toBe("console.log(a);");
  });
});

describe("annotatePatch", () => {
  it("numbers right-side lines plainly and deletions with an old-number '-' marker", () => {
    const annotated = annotatePatch(PATCH).split("\n");
    expect(annotated[1]).toBe("    1  const a = 1;");
    expect(annotated[2]).toBe("    2- -const b = 2;");
    expect(annotated[3]).toBe("    2 +const b = 3;");
    expect(annotated[7]).toBe("   11  function tail() {");
  });
});

function makeFile(path: string, patch: string = PATCH): DiffFile {
  return {
    path,
    status: "modified",
    patch,
    commentableLines: commentableLines(patch),
    commentableOldLines: commentableOldLines(patch),
  };
}

describe("validateFindings", () => {
  const files = [makeFile("src/a.ts")];
  const finding = (path: string, line: number): Finding => ({
    path,
    line,
    severity: "warning",
    title: "t",
    body: "b",
  });

  it("keeps findings on commentable lines and drops the rest", () => {
    const { valid, dropped } = validateFindings(
      [finding("src/a.ts", 2), finding("src/a.ts", 99), finding("other.ts", 2)],
      files,
    );
    expect(valid).toHaveLength(1);
    expect(valid[0]?.line).toBe(2);
    expect(dropped).toHaveLength(2);
  });

  it("validates removed-side findings against deleted old-file lines", () => {
    const removedOk = { ...finding("src/a.ts", 2), side: "removed" as const };
    const removedBad = { ...finding("src/a.ts", 1), side: "removed" as const };
    const { valid, dropped } = validateFindings([removedOk, removedBad], files);
    expect(valid).toHaveLength(1);
    expect(valid[0]?.side).toBe("removed");
    expect(dropped).toHaveLength(1);
  });

  it("strips no-op suggestions that reproduce the current line", () => {
    const noop = { ...finding("src/a.ts", 2), suggestion: "const b = 3;" };
    const real = { ...finding("src/a.ts", 2), suggestion: "const b = 4;" };
    const { valid } = validateFindings([noop, real], files);
    expect(valid[0]?.suggestion).toBeUndefined();
    expect(valid[1]?.suggestion).toBe("const b = 4;");
  });
});

describe("filterFiles / batchFiles", () => {
  it("filters excluded paths by substring", () => {
    const files = [makeFile("src/a.ts"), makeFile("package-lock.json"), makeFile("dist/x.js")];
    expect(filterFiles(files, ["package-lock.json", "dist/"]).map((f) => f.path)).toEqual([
      "src/a.ts",
    ]);
  });

  it("splits batches by character budget without splitting a file", () => {
    const files = [makeFile("a"), makeFile("b"), makeFile("c")];
    const batches = batchFiles(files, PATCH.length + 1);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batchFiles(files, PATCH.length * 3 + 1)).toHaveLength(1);
  });
});
