export const SEVERITIES = ["critical", "warning", "suggestion", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** True when `severity` is at least as severe as `threshold`. */
export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
}

export interface Finding {
  /** Repo-relative path of the file the finding is in. */
  path: string;
  /** 1-indexed line number in the NEW version of the file (first line of the range). */
  line: number;
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
}

export interface DiffFile {
  path: string;
  status: string;
  patch: string;
  /** New-file line numbers that appear in the diff and can carry a comment. */
  commentableLines: Set<number>;
}

export interface PullRequestInfo {
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  files: DiffFile[];
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
