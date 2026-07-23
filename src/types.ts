export const SEVERITIES = ["critical", "warning", "suggestion", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** True when `severity` is at least as severe as `threshold`. */
export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
}

export interface Finding {
  /** Repo-relative path of the file the finding is in. */
  path: string;
  /**
   * 1-indexed line number. For side "added" (default) this is a NEW-file
   * line; for side "removed" it is the OLD-file line of a deleted line.
   */
  line: number;
  /** Which side of the diff the finding anchors to. Default "added". */
  side?: "added" | "removed";
  /** Optional last line of a multi-line finding; the comment spans line..endLine. */
  endLine?: number;
  severity: Severity;
  title: string;
  /** Full explanation, written as a review comment (markdown). */
  body: string;
  /** Optional replacement code for a GitHub suggestion block. */
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  /** How much of the requested change was actually reviewed. */
  coverage?: ReviewCoverage;
}

export type IncompleteReason =
  | "path-filter"
  | "excluded"
  | "missing-patch"
  | "token-budget";

export interface ReviewCoverage {
  /** False when any part of the change was intentionally or technically omitted. */
  complete: boolean;
  totalFiles: number;
  reviewedFiles: number;
  skippedFiles: number;
  skippedBatches: number;
  reasons: IncompleteReason[];
}

export interface DiffFile {
  path: string;
  status: string;
  patch: string;
  /** New-file line numbers that appear in the diff and can carry a RIGHT comment. */
  commentableLines: Set<number>;
  /** Old-file line numbers of deleted lines that can carry a LEFT comment. */
  commentableOldLines?: Set<number>;
}

export interface PullRequestInfo {
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  labels: string[];
  files: DiffFile[];
  /** Binary/oversized files for which GitHub did not return a patch. */
  missingPatchFiles: number;
}

export type ProviderName = "anthropic" | "openai" | "gemini";

export interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  /** Cumulative token usage across generate() calls, when the SDK reports it. */
  readonly usage?: ProviderUsage;
  /**
   * One structured-output call: system + user prompt constrained to a JSON
   * schema. Returns raw parsed JSON; callers validate the shape.
   */
  generate(system: string, user: string, schema: Record<string, unknown>): Promise<unknown>;
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
