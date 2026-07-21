import type { DiffFile, Finding } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Collect the new-file line numbers that appear in a unified diff patch.
 * GitHub only accepts inline review comments on these lines (side: RIGHT).
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // old-file line only; new-file counter does not advance
    } else if (raw.startsWith("\\") || raw === "") {
      // "\ No newline at end of file" or a trailing split artifact
    } else {
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

/**
 * Prefix each right-side diff line with its new-file line number so the
 * model can reference exact lines. Left-only (deleted) lines get no number.
 */
export function annotatePatch(patch: string): string {
  const out: string[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push(raw);
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\") || raw === "") {
      out.push(raw === "" ? raw : `      ${raw}`);
    } else {
      out.push(`${String(newLine).padStart(5)} ${raw}`);
      newLine++;
    }
  }
  return out.join("\n");
}

/**
 * Drop findings that reference files or lines not present in the diff —
 * GitHub rejects the whole review if any comment targets an invalid line.
 */
export function validateFindings(
  findings: Finding[],
  files: DiffFile[],
): { valid: Finding[]; dropped: Finding[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const valid: Finding[] = [];
  const dropped: Finding[] = [];
  for (const finding of findings) {
    const file = byPath.get(finding.path);
    if (file && file.commentableLines.has(finding.line)) {
      valid.push(finding);
    } else {
      dropped.push(finding);
    }
  }
  return { valid, dropped };
}
