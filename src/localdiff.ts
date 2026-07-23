import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffFile } from "./types.js";
import { commentableLines, commentableOldLines } from "./diff.js";

const execFileAsync = promisify(execFile);

/** Parse `git diff` output into per-file DiffFiles, including deleted files. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const plusLine = lines.find((l) => l.startsWith("+++ "));
    if (!plusLine) continue;
    const newPath = plusLine.slice(4).trim();
    const minusLine = lines.find((l) => l.startsWith("--- "));
    const oldPath = minusLine?.slice(4).trim();
    const rawPath = newPath === "/dev/null" ? oldPath : newPath;
    if (!rawPath || rawPath === "/dev/null") continue;
    const path = rawPath.startsWith("a/") || rawPath.startsWith("b/")
      ? rawPath.slice(2)
      : rawPath;
    const hunkStart = lines.findIndex((l) => l.startsWith("@@ "));
    if (hunkStart === -1) continue; // binary or mode-only change
    const patch = lines.slice(hunkStart).join("\n");
    files.push({
      path,
      status: newPath === "/dev/null"
        ? "removed"
        : chunk.includes("\nnew file mode")
          ? "added"
          : "modified",
      patch,
      commentableLines: commentableLines(patch),
      commentableOldLines: commentableOldLines(patch),
    });
  }
  return files;
}

/** Run `git diff` against a base ref (or the index with staged=true). */
export async function localDiffFiles(base: string, staged: boolean): Promise<DiffFile[]> {
  const args = ["diff", "--no-color", ...(staged ? ["--staged"] : [base])];
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseUnifiedDiff(stdout);
}
