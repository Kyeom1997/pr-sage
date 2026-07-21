export const SEVERITIES = ["critical", "warning", "suggestion", "nitpick"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** True when `severity` is at least as severe as `threshold`. */
export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
}

export interface Finding {
  /** Repo-relative path of the file the finding is in. */
  path: string;
  /** 1-indexed line number in the NEW version of the file. */
  line: number;
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

export interface ReviewRequest {
  prTitle: string;
  prBody: string;
  /** Annotated patches ready to embed in the prompt. */
  filesText: string;
  locale: string;
  /** Project-specific review guidelines appended to the system prompt. */
  instructions?: string;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  /** Returns raw parsed JSON; callers validate with parseReviewResult. */
  review(request: ReviewRequest): Promise<unknown>;
}
