import picomatch from "picomatch";
import type {
  DiffFile,
  Finding,
  Provider,
  ReviewResult,
  Severity,
} from "./types.js";
import { severityAtLeast } from "./types.js";
import {
  REVIEW_SCHEMA,
  SUMMARY_SCHEMA,
  VERIFY_SCHEMA,
  consolidateSystemPrompt,
  renderFiles,
  systemPrompt,
  userPrompt,
  verifySystemPrompt,
  verifyUserPrompt,
} from "./prompt.js";
import { validateFindings } from "./diff.js";
import { parseReviewResult, parseSummary, parseVerdicts } from "./validate.js";
import { withRetry } from "./retry.js";
import { PR_SAGE_MARKER, shaMarker } from "./github.js";

export interface ReviewTarget {
  title: string;
  body: string;
  /** Files to review (may be an incremental subset of the full diff). */
  files: DiffFile[];
  /** Head commit recorded in the summary marker; empty for local reviews. */
  headSha: string;
}

export interface ReviewOptions {
  locale: string;
  /** Path globs (picomatch) or plain substrings to skip. */
  exclude: string[];
  /** Character budget for the diff portion of one model request. */
  batchCharBudget: number;
  log: (message: string) => void;
  /** Project-specific review guidelines appended to the system prompt. */
  instructions?: string;
  /** Drop findings below this severity. */
  minSeverity?: Severity;
  /** When set, fetches full file content (new version) for extra context. */
  fetchContent?: (path: string) => Promise<string | null>;
  /** Second model pass that rejects unconfirmed findings (halves false positives, doubles cost). */
  verify?: boolean;
  /**
   * Files whose diff lines findings must anchor to (defaults to target.files).
   * Used by incremental review: review a subset, anchor against the full PR diff.
   */
  anchorFiles?: DiffFile[];
}

export const DEFAULT_EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".min.js",
  ".map",
  "dist/",
  "build/",
  "vendor/",
];

const GLOB_CHARS = /[*?[\]{}()!]/;

export function filterFiles(files: DiffFile[], exclude: string[]): DiffFile[] {
  const matchers = exclude.map((pattern) =>
    GLOB_CHARS.test(pattern) ? picomatch(pattern, { dot: true }) : null,
  );
  return files.filter(
    (f) =>
      !exclude.some((pattern, i) => {
        const matcher = matchers[i];
        return matcher ? matcher(f.path) : f.path.includes(pattern);
      }),
  );
}

/** Split files into batches whose annotated patches fit the character budget. */
export function batchFiles(files: DiffFile[], budget: number): DiffFile[][] {
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.patch.length > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.patch.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * A single-line GitHub suggestion replaces exactly the anchored line, so a
 * multi-line suggestion without a matching range would corrupt the file if
 * committed. Range findings (endLine set) may carry multi-line suggestions.
 */
export function sanitizeFindings(findings: Finding[]): Finding[] {
  return findings.map((f) => {
    if (!f.suggestion) return f;
    const suggestion = f.suggestion.replace(/\n+$/, "");
    if (f.endLine !== undefined && f.endLine > f.line) return { ...f, suggestion };
    if (!suggestion.includes("\n")) return { ...f, suggestion };
    const { suggestion: _dropped, ...rest } = f;
    return { ...rest, body: `${f.body}\n\n\`\`\`\n${suggestion}\n\`\`\`` };
  });
}

export async function runReview(
  provider: Provider,
  target: ReviewTarget,
  options: ReviewOptions,
): Promise<{ result: ReviewResult; dropped: Finding[] }> {
  const files = filterFiles(target.files, options.exclude);
  if (files.length === 0) {
    return {
      result: {
        summary: `No reviewable files in this change.\n\n${PR_SAGE_MARKER}`,
        findings: [],
      },
      dropped: [],
    };
  }

  const batches = batchFiles(files, options.batchCharBudget);
  options.log(
    `Reviewing ${files.length} file(s) in ${batches.length} batch(es) with ${provider.name}:${provider.model}`,
  );

  const system = systemPrompt(options.locale, options.instructions);
  const summaries: string[] = [];
  const findings: Finding[] = [];

  for (const [i, batch] of batches.entries()) {
    if (batches.length > 1) options.log(`Batch ${i + 1}/${batches.length}: ${batch.length} file(s)`);

    let contents: Map<string, string> | undefined;
    if (options.fetchContent) {
      contents = new Map();
      for (const file of batch) {
        if (file.status === "removed") continue;
        const content = await options.fetchContent(file.path);
        if (content !== null) contents.set(file.path, content);
      }
    }

    const filesText = renderFiles(batch, contents);
    const raw = await withRetry(
      () => provider.generate(system, userPrompt(target.title, target.body, filesText), REVIEW_SCHEMA),
      { log: options.log },
    );
    const result = parseReviewResult(raw, options.log);

    let batchFindings = result.findings;
    if (options.verify && batchFindings.length > 0) {
      batchFindings = await verifyBatch(provider, batchFindings, filesText, options.log);
    }

    summaries.push(result.summary);
    findings.push(...batchFindings);
  }

  const summaryBody = await consolidateSummaries(provider, summaries, options);

  const { valid, dropped } = validateFindings(findings, options.anchorFiles ?? files);
  if (dropped.length > 0) {
    options.log(`Dropped ${dropped.length} finding(s) referencing lines outside the diff.`);
  }

  let kept = sanitizeFindings(valid);
  if (options.minSeverity) {
    const before = kept.length;
    kept = kept.filter((f) => severityAtLeast(f.severity, options.minSeverity!));
    if (before > kept.length) {
      options.log(`Filtered ${before - kept.length} finding(s) below ${options.minSeverity}.`);
    }
  }

  return {
    result: { summary: buildSummary(summaryBody, kept, provider, target.headSha), findings: kept },
    dropped,
  };
}

async function verifyBatch(
  provider: Provider,
  findings: Finding[],
  filesText: string,
  log: (message: string) => void,
): Promise<Finding[]> {
  try {
    const raw = await withRetry(
      () => provider.generate(verifySystemPrompt(), verifyUserPrompt(findings, filesText), VERIFY_SCHEMA),
      { log },
    );
    const confirmed = new Set(
      parseVerdicts(raw)
        .filter((v) => v.confirmed)
        .map((v) => v.index),
    );
    const kept = findings.filter((_, i) => confirmed.has(i));
    if (kept.length < findings.length) {
      log(`Verification rejected ${findings.length - kept.length} of ${findings.length} finding(s).`);
    }
    return kept;
  } catch (error) {
    log(`Verification pass failed (${(error as Error).message}); keeping all findings.`);
    return findings;
  }
}

async function consolidateSummaries(
  provider: Provider,
  summaries: string[],
  options: ReviewOptions,
): Promise<string> {
  if (summaries.length <= 1) return summaries[0] ?? "";
  try {
    const raw = await withRetry(
      () =>
        provider.generate(
          consolidateSystemPrompt(options.locale),
          summaries.map((s, i) => `## Partial summary ${i + 1}\n\n${s}`).join("\n\n"),
          SUMMARY_SCHEMA,
        ),
      { log: options.log },
    );
    return parseSummary(raw);
  } catch (error) {
    options.log(`Summary consolidation failed (${(error as Error).message}); joining batch summaries.`);
    return summaries.join("\n\n");
  }
}

function buildSummary(
  summaryBody: string,
  findings: Finding[],
  provider: Provider,
  headSha: string,
): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const countLine =
    findings.length === 0
      ? "No issues found."
      : ["critical", "warning", "suggestion", "nitpick"]
          .filter((s) => counts.has(s))
          .map((s) => `${counts.get(s)} ${s}`)
          .join(" · ");

  return [
    "## 🔎 pr-sage review",
    "",
    summaryBody,
    "",
    `**Findings:** ${countLine}`,
    "",
    `<sub>Generated by [pr-sage](https://www.npmjs.com/package/pr-sage) using ${provider.name}:${provider.model}</sub>`,
    "",
    headSha ? `${PR_SAGE_MARKER}\n${shaMarker(headSha)}` : PR_SAGE_MARKER,
  ].join("\n");
}
