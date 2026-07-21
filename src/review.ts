import picomatch from "picomatch";
import type {
  DiffFile,
  Finding,
  Provider,
  PullRequestInfo,
  ReviewResult,
  Severity,
} from "./types.js";
import { severityAtLeast } from "./types.js";
import { renderFiles } from "./prompt.js";
import { validateFindings } from "./diff.js";
import { parseReviewResult } from "./validate.js";
import { withRetry } from "./retry.js";
import { PR_SAGE_MARKER } from "./github.js";

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
 * GitHub suggestion blocks replace exactly the anchored line, so a multi-line
 * suggestion would corrupt the file if committed. Demote those to a plain
 * code block in the comment body.
 */
export function sanitizeFindings(findings: Finding[]): Finding[] {
  return findings.map((f) => {
    if (!f.suggestion) return f;
    const suggestion = f.suggestion.replace(/\n+$/, "");
    if (!suggestion.includes("\n")) return { ...f, suggestion };
    const { suggestion: _dropped, ...rest } = f;
    return { ...rest, body: `${f.body}\n\n\`\`\`\n${suggestion}\n\`\`\`` };
  });
}

export async function runReview(
  provider: Provider,
  pr: PullRequestInfo,
  options: ReviewOptions,
): Promise<{ result: ReviewResult; dropped: Finding[] }> {
  const files = filterFiles(pr.files, options.exclude);
  if (files.length === 0) {
    return {
      result: {
        summary: `No reviewable files in this pull request.\n\n${PR_SAGE_MARKER}`,
        findings: [],
      },
      dropped: [],
    };
  }

  const batches = batchFiles(files, options.batchCharBudget);
  options.log(
    `Reviewing ${files.length} file(s) in ${batches.length} batch(es) with ${provider.name}:${provider.model}`,
  );

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

    const raw = await withRetry(
      () =>
        provider.review({
          prTitle: pr.title,
          prBody: pr.body,
          filesText: renderFiles(batch, contents),
          locale: options.locale,
          instructions: options.instructions,
        }),
      { log: options.log },
    );
    const result = parseReviewResult(raw, options.log);
    summaries.push(result.summary);
    findings.push(...result.findings);
  }

  const { valid, dropped } = validateFindings(sanitizeFindings(findings), files);
  if (dropped.length > 0) {
    options.log(`Dropped ${dropped.length} finding(s) referencing lines outside the diff.`);
  }

  let kept = valid;
  if (options.minSeverity) {
    kept = valid.filter((f) => severityAtLeast(f.severity, options.minSeverity!));
    const filtered = valid.length - kept.length;
    if (filtered > 0) options.log(`Filtered ${filtered} finding(s) below ${options.minSeverity}.`);
  }

  return {
    result: { summary: buildSummary(summaries, kept, provider), findings: kept },
    dropped,
  };
}

function buildSummary(summaries: string[], findings: Finding[], provider: Provider): string {
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
    summaries.join("\n\n"),
    "",
    `**Findings:** ${countLine}`,
    "",
    `<sub>Generated by [pr-sage](https://www.npmjs.com/package/pr-sage) using ${provider.name}:${provider.model}</sub>`,
    "",
    PR_SAGE_MARKER,
  ].join("\n");
}
