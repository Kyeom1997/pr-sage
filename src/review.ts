import picomatch from "picomatch";
import type {
  DiffFile,
  Finding,
  IncompleteReason,
  Provider,
  ReviewCoverage,
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
import { commentableLines, commentableOldLines, validateFindings } from "./diff.js";
import { parseReviewResult, parseSummary, parseVerdicts } from "./validate.js";
import { withRetry } from "./retry.js";
import { activeMarker, findingKey, PR_SAGE_MARKER, shaMarker } from "./github.js";

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
  /** Cost guard: stop launching new batches once this many tokens are spent. */
  maxTokens?: number;
  /** Total files before path filtering, used for honest coverage reporting. */
  totalFiles?: number;
  /** Files omitted by the source API because no textual patch was available. */
  missingPatchFiles?: number;
  /** Optional provider used only for the verification pass. */
  verifier?: Provider;
  /** Behavior when verification cannot complete. */
  verifyFailure?: "abort" | "keep" | "drop";
  /** Path-specific instructions and severity policies. */
  pathRules?: PathRule[];
}

export interface PathRule {
  paths: string[];
  instructions?: string;
  minSeverity?: Severity;
  failOn?: Severity;
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

/** Keep only files matching at least one glob/substring (monorepo scoping). */
export function includeFiles(files: DiffFile[], paths: string[]): DiffFile[] {
  if (paths.length === 0) return files;
  const matchers = paths.map((pattern) =>
    GLOB_CHARS.test(pattern) ? picomatch(pattern, { dot: true }) : null,
  );
  return files.filter((f) =>
    paths.some((pattern, i) => {
      const matcher = matchers[i];
      return matcher ? matcher(f.path) : f.path.includes(pattern);
    }),
  );
}

export function matchesAnyPath(path: string, patterns: string[]): boolean {
  return includeFiles([{ path } as DiffFile], patterns).length > 0;
}

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

/** Per-file patch size cap; larger files are split into hunk-level chunks. */
export const MAX_FILE_PATCH_CHARS = 30_000;

/**
 * Split oversized file patches into multiple entries along hunk boundaries,
 * so no part of a large diff is silently truncated away from review.
 */
export function splitOversizedFiles(
  files: DiffFile[],
  maxChars: number = MAX_FILE_PATCH_CHARS,
): DiffFile[] {
  const out: DiffFile[] = [];
  for (const file of files) {
    if (file.patch.length <= maxChars) {
      out.push(file);
      continue;
    }
    const hunks = file.patch.split(/^(?=@@ )/m).filter((h) => h.length > 0);
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const hunk of hunks) {
      if (current.length > 0 && size + hunk.length > maxChars) {
        chunks.push(current.join(""));
        current = [];
        size = 0;
      }
      current.push(hunk);
      size += hunk.length;
    }
    if (current.length > 0) chunks.push(current.join(""));
    chunks.forEach((patch, i) => {
      out.push({
        path: file.path,
        status: chunks.length > 1 ? `${file.status}, part ${i + 1}/${chunks.length}` : file.status,
        patch,
        commentableLines: commentableLines(patch),
        commentableOldLines: commentableOldLines(patch),
      });
    });
  }
  return out;
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
    // GitHub suggestion blocks only apply to RIGHT-side lines.
    if ((f.side ?? "added") === "removed") {
      const { suggestion: dropped, ...rest } = f;
      return { ...rest, body: `${f.body}\n\n\`\`\`\n${dropped.replace(/\n+$/, "")}\n\`\`\`` };
    }
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
  const filtered = filterFiles(target.files, options.exclude);
  const excludedFiles = uniquePathCount(target.files) - uniquePathCount(filtered);
  const files = splitOversizedFiles(filtered);
  const targetFileCount = uniquePathCount(target.files);
  const totalFiles = options.totalFiles ?? targetFileCount + (options.missingPatchFiles ?? 0);
  const reasons: IncompleteReason[] = [];
  if (totalFiles > targetFileCount + (options.missingPatchFiles ?? 0)) reasons.push("path-filter");
  if (excludedFiles > 0) reasons.push("excluded");
  if ((options.missingPatchFiles ?? 0) > 0) reasons.push("missing-patch");
  const reviewedPaths = new Set<string>();
  let skippedBatches = 0;

  if (files.length === 0) {
    const coverage = makeCoverage(totalFiles, reviewedPaths, 0, reasons);
    return {
      result: {
        summary: buildSummary(
          "No reviewable files in this change.",
          [],
          provider,
          target.headSha,
          coverage,
        ),
        findings: [],
        coverage,
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
  const providers = options.verifier ? [provider, options.verifier] : [provider];
  const startTokens = spentTokens(...providers);
  let truncatedByBudget = false;

  for (const [i, batch] of batches.entries()) {
    if (
      options.maxTokens !== undefined
      && spentTokens(...providers) - startTokens >= options.maxTokens
    ) {
      const skipped = batches.length - i;
      options.log(
        `Token budget (${options.maxTokens}) reached — stopping before ${skipped} remaining batch(es).`,
      );
      truncatedByBudget = true;
      skippedBatches = skipped;
      if (!reasons.includes("token-budget")) reasons.push("token-budget");
      break;
    }
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

    // Later batches see earlier batches' summaries, so cross-file
    // inconsistencies have at least a summary-level chance of being caught.
    const priorContext = summaries.length > 0 ? summaries.join("\n\n") : undefined;
    let filesText = renderFiles(batch, contents);
    const pathGuidance = renderPathGuidance(batch, options.pathRules ?? []);
    if (pathGuidance) filesText = `${pathGuidance}\n\n${filesText}`;
    const estimatedInputTokens = Math.ceil(
      (
        system.length
        + userPrompt(target.title, target.body, filesText, priorContext).length
      ) / 4,
    );
    if (
      options.maxTokens !== undefined
      && spentTokens(...providers) - startTokens + estimatedInputTokens > options.maxTokens
    ) {
      skippedBatches = batches.length - i;
      truncatedByBudget = true;
      if (!reasons.includes("token-budget")) reasons.push("token-budget");
      options.log(
        `Token budget (${options.maxTokens}) would be exceeded by batch ${i + 1}; stopping before ${skippedBatches} remaining batch(es).`,
      );
      break;
    }
    const raw = await withRetry(
      () =>
        provider.generate(
          system,
          userPrompt(target.title, target.body, filesText, priorContext),
          REVIEW_SCHEMA,
        ),
      { log: options.log },
    );
    const result = parseReviewResult(raw, options.log);

    let batchFindings = result.findings;
    if (options.verify && batchFindings.length > 0) {
      batchFindings = await verifyBatch(
        options.verifier ?? provider,
        batchFindings,
        filesText,
        options.log,
        options.verifyFailure ?? "abort",
      );
    }

    summaries.push(result.summary);
    findings.push(...batchFindings);
    for (const file of batch) reviewedPaths.add(file.path);
  }

  let summaryBody =
    options.maxTokens !== undefined
    && spentTokens(...providers) - startTokens >= options.maxTokens
      ? summaries.join("\n\n")
      : await consolidateSummaries(provider, summaries, options);
  if (truncatedByBudget) {
    summaryBody += `\n\n> ⚠️ Review stopped early: the ${options.maxTokens}-token budget for this run was reached, so part of the diff was not reviewed.`;
  }

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
  if (options.pathRules?.length) {
    kept = kept.filter((finding) => {
      const rule = matchingPathRule(finding.path, options.pathRules!);
      return !rule?.minSeverity || severityAtLeast(finding.severity, rule.minSeverity);
    });
  }

  const coverage = makeCoverage(totalFiles, reviewedPaths, skippedBatches, reasons);

  return {
    result: {
      summary: buildSummary(summaryBody, kept, provider, target.headSha, coverage),
      findings: kept,
      coverage,
    },
    dropped,
  };
}

function spentTokens(...providers: Provider[]): number {
  return providers.reduce((total, provider) => {
    const usage = provider.usage;
    return total + (usage ? usage.inputTokens + usage.outputTokens : 0);
  }, 0);
}

async function verifyBatch(
  provider: Provider,
  findings: Finding[],
  filesText: string,
  log: (message: string) => void,
  failureMode: "abort" | "keep" | "drop",
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
    const message = `Verification pass failed (${(error as Error).message})`;
    if (failureMode === "keep") {
      log(`${message}; keeping all findings.`);
      return findings;
    }
    if (failureMode === "drop") {
      log(`${message}; dropping unverified findings.`);
      return [];
    }
    throw new Error(`${message}; aborting because verifyFailure is "abort".`);
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
  coverage: ReviewCoverage,
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
    `**Coverage:** ${coverage.reviewedFiles}/${coverage.totalFiles} files${
      coverage.complete ? "" : ` · partial (${coverage.reasons.join(", ")})`
    }`,
    "",
    `<sub>Generated by [pr-sage](https://www.npmjs.com/package/pr-sage) using ${provider.name}:${provider.model}</sub>`,
    "",
    headSha ? `${PR_SAGE_MARKER}\n${shaMarker(headSha)}` : PR_SAGE_MARKER,
    activeMarker(findings.map(findingKey)),
  ].join("\n");
}

function uniquePathCount(files: DiffFile[]): number {
  return new Set(files.map((file) => file.path)).size;
}

function makeCoverage(
  totalFiles: number,
  reviewedPaths: Set<string>,
  skippedBatches: number,
  reasons: IncompleteReason[],
): ReviewCoverage {
  const reviewedFiles = reviewedPaths.size;
  const skippedFiles = Math.max(0, totalFiles - reviewedFiles);
  return {
    complete: reasons.length === 0 && skippedFiles === 0,
    totalFiles,
    reviewedFiles,
    skippedFiles,
    skippedBatches,
    reasons,
  };
}

function matchingPathRule(path: string, rules: PathRule[]): PathRule | undefined {
  return rules.find((rule) => matchesAnyPath(path, rule.paths));
}

function renderPathGuidance(files: DiffFile[], rules: PathRule[]): string {
  const applicable = rules.filter(
    (rule) => rule.instructions && files.some((file) => matchingPathRule(file.path, [rule])),
  );
  if (applicable.length === 0) return "";
  return [
    "## Path-specific review rules",
    ...applicable.map(
      (rule) => `- ${rule.paths.join(", ")}: ${rule.instructions}`,
    ),
  ].join("\n");
}
