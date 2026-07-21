export type Severity = "critical" | "warning" | "suggestion" | "nitpick";

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
  files: DiffFile[];
}

export type ProviderName = "anthropic" | "openai" | "gemini";

export interface ReviewRequest {
  prTitle: string;
  prBody: string;
  /** Annotated patches ready to embed in the prompt. */
  filesText: string;
  locale: string;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  review(request: ReviewRequest): Promise<ReviewResult>;
}
