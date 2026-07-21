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

const MAX_RANGE_LINES = 50;

/**
 * Drop findings that reference files or lines not present in the diff —
 * GitHub rejects the whole review if any comment targets an invalid line.
 * Multi-line ranges whose span isn't fully in the diff are downgraded to
 * single-line findings rather than dropped.
 */
export function validateFindings(
  findings: Finding[],
  files: DiffFile[],
): { valid: Finding[]; dropped: Finding[] } {
  // Merge commentable lines per path — oversized files may be split into
  // multiple hunk-level DiffFile entries sharing one path.
  const linesByPath = new Map<string, Set<number>>();
  for (const file of files) {
    const existing = linesByPath.get(file.path);
    if (existing) {
      for (const n of file.commentableLines) existing.add(n);
    } else {
      linesByPath.set(file.path, new Set(file.commentableLines));
    }
  }

  const valid: Finding[] = [];
  const dropped: Finding[] = [];
  for (const finding of findings) {
    const lines = linesByPath.get(finding.path);
    if (!lines || !lines.has(finding.line)) {
      dropped.push(finding);
      continue;
    }
    if (finding.endLine !== undefined && !isValidRange(finding, lines)) {
      valid.push({ ...finding, endLine: undefined });
    } else {
      valid.push(finding);
    }
  }
  return { valid, dropped };
}

function isValidRange(finding: Finding, lines: Set<number>): boolean {
  const end = finding.endLine!;
  if (end <= finding.line || end - finding.line > MAX_RANGE_LINES) return false;
  for (let n = finding.line; n <= end; n++) {
    if (!lines.has(n)) return false;
  }
  return true;
}
