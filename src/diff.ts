import type { DiffFile, Finding } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Collect the new-file line numbers that appear in a unified diff patch.
 * GitHub accepts side:RIGHT inline review comments on these lines.
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[2]);
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
 * Collect the old-file line numbers of deleted lines. GitHub accepts
 * side:LEFT inline review comments on these lines.
 */
export function commentableOldLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let oldLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      oldLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("-")) {
      lines.add(oldLine);
      oldLine++;
    } else if (raw.startsWith("+") || raw.startsWith("\\") || raw === "") {
      // new-file line only (or artifact); old-file counter does not advance
    } else {
      oldLine++;
    }
  }
  return lines;
}

/** Map of new-file line number → line content (without the diff prefix). */
export function rightLineTexts(patch: string): Map<number, string> {
  const texts = new Map<number, string>();
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\") || raw === "") continue;
    texts.set(newLine, raw.slice(1));
    newLine++;
  }
  return texts;
}

/**
 * Prefix each right-side diff line with its new-file line number, and each
 * deleted line with its OLD-file line number followed by a "-" marker, so
 * the model can anchor findings on both sides of the diff.
 */
export function annotatePatch(patch: string): string {
  const out: string[] = [];
  let newLine = 0;
  let oldLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push(raw);
      continue;
    }
    if (raw === "" || raw.startsWith("\\")) {
      out.push(raw);
    } else if (raw.startsWith("-")) {
      out.push(`${String(oldLine).padStart(5)}- ${raw}`);
      oldLine++;
    } else {
      out.push(`${String(newLine).padStart(5)} ${raw}`);
      newLine++;
      if (!raw.startsWith("+")) oldLine++;
    }
  }
  return out.join("\n");
}

const MAX_RANGE_LINES = 50;

/**
 * Drop findings that reference files or lines not present in the diff —
 * GitHub rejects the whole review if any comment targets an invalid line.
 * Also downgrades invalid multi-line ranges to single-line, and strips
 * suggestions that are identical to the current code (no-op suggestions).
 */
export function validateFindings(
  findings: Finding[],
  files: DiffFile[],
): { valid: Finding[]; dropped: Finding[] } {
  // Merge line sets per path — oversized files may be split into multiple
  // hunk-level DiffFile entries sharing one path.
  const rightByPath = new Map<string, Set<number>>();
  const leftByPath = new Map<string, Set<number>>();
  const patchesByPath = new Map<string, string[]>();
  for (const file of files) {
    mergeSet(rightByPath, file.path, file.commentableLines);
    if (file.commentableOldLines) mergeSet(leftByPath, file.path, file.commentableOldLines);
    const patches = patchesByPath.get(file.path);
    if (patches) patches.push(file.patch);
    else patchesByPath.set(file.path, [file.patch]);
  }

  const textCache = new Map<string, Map<number, string>>();
  const lineText = (path: string, line: number): string | undefined => {
    let texts = textCache.get(path);
    if (!texts) {
      texts = new Map();
      for (const patch of patchesByPath.get(path) ?? []) {
        for (const [n, t] of rightLineTexts(patch)) texts.set(n, t);
      }
      textCache.set(path, texts);
    }
    return texts.get(line);
  };

  const valid: Finding[] = [];
  const dropped: Finding[] = [];
  for (let finding of findings) {
    if ((finding.side ?? "added") === "removed") {
      // Deleted-line finding: anchor against old-file lines; ranges and
      // suggestions don't apply on the LEFT side.
      const lines = leftByPath.get(finding.path);
      if (!lines || !lines.has(finding.line)) {
        dropped.push(finding);
        continue;
      }
      valid.push({ ...finding, endLine: undefined });
      continue;
    }

    const lines = rightByPath.get(finding.path);
    if (!lines || !lines.has(finding.line)) {
      dropped.push(finding);
      continue;
    }
    if (finding.endLine !== undefined && !isValidRange(finding, lines)) {
      finding = { ...finding, endLine: undefined };
    }
    if (finding.suggestion !== undefined && isNoopSuggestion(finding, lineText)) {
      const { suggestion: _dropped, ...rest } = finding;
      finding = rest;
    }
    valid.push(finding);
  }
  return { valid, dropped };
}

function mergeSet(map: Map<string, Set<number>>, key: string, values: Set<number>): void {
  const existing = map.get(key);
  if (existing) {
    for (const v of values) existing.add(v);
  } else {
    map.set(key, new Set(values));
  }
}

/** A suggestion that exactly reproduces the current code fixes nothing. */
function isNoopSuggestion(
  finding: Finding,
  lineText: (path: string, line: number) => string | undefined,
): boolean {
  const end = finding.endLine ?? finding.line;
  const current: string[] = [];
  for (let n = finding.line; n <= end; n++) {
    const text = lineText(finding.path, n);
    if (text === undefined) return false;
    current.push(text);
  }
  return current.join("\n").trim() === finding.suggestion!.trim();
}

function isValidRange(finding: Finding, lines: Set<number>): boolean {
  const end = finding.endLine!;
  if (end <= finding.line || end - finding.line > MAX_RANGE_LINES) return false;
  for (let n = finding.line; n <= end; n++) {
    if (!lines.has(n)) return false;
  }
  return true;
}
