import { z } from 'zod';

declare const SEVERITIES: readonly ["critical", "warning", "suggestion", "nitpick"];
type Severity = (typeof SEVERITIES)[number];
/** True when `severity` is at least as severe as `threshold`. */
declare function severityAtLeast(severity: Severity, threshold: Severity): boolean;
interface Finding {
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
interface ReviewResult {
    summary: string;
    findings: Finding[];
}
interface DiffFile {
    path: string;
    status: string;
    patch: string;
    /** New-file line numbers that appear in the diff and can carry a RIGHT comment. */
    commentableLines: Set<number>;
    /** Old-file line numbers of deleted lines that can carry a LEFT comment. */
    commentableOldLines?: Set<number>;
}
interface PullRequestInfo {
    title: string;
    body: string;
    baseRef: string;
    headRef: string;
    headSha: string;
    files: DiffFile[];
}
type ProviderName = "anthropic" | "openai" | "gemini";
interface ProviderUsage {
    calls: number;
    inputTokens: number;
    outputTokens: number;
}
interface Provider {
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
type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Hidden marker identifying comments posted by pr-sage (used for dedup). */
declare const PR_SAGE_MARKER = "<!-- pr-sage -->";
/** Marker recording which head commit a summary review covered. */
declare function shaMarker(sha: string): string;
declare class GitHubClient {
    private readonly token;
    private readonly owner;
    private readonly repo;
    private readonly baseUrl;
    private readonly fetchImpl;
    constructor(token: string, owner: string, repo: string, baseUrl?: string, fetchImpl?: typeof fetch);
    private request;
    fetchPullRequest(prNumber: number): Promise<PullRequestInfo>;
    /** Files changed between two commits (for incremental review). */
    compareFiles(baseSha: string, headSha: string): Promise<DiffFile[]>;
    /** Fetch a file's content at a given ref. Returns null for binary/oversized/missing files. */
    fetchFileContent(path: string, ref: string): Promise<string | null>;
    /** Fetch repo guideline docs (CLAUDE.md, CONTRIBUTING.md) to inject as review context. */
    fetchRepoGuidelines(ref: string): Promise<string | null>;
    /**
     * Locate previous pr-sage activity on this PR: inline-comment locations
     * (for dedup), whether any pr-sage summary review exists, and the head
     * commit the most recent one covered (for incremental review).
     */
    fetchPrSageHistory(prNumber: number): Promise<{
        /** `${path}:${SIDE}:${line}` of previously posted pr-sage comments. */
        commentedLocations: Set<string>;
        /** `${path}|${fingerprint}` of previously posted findings (line-shift-proof). */
        fingerprints: Set<string>;
        hasReview: boolean;
        lastReviewedSha: string | null;
    }>;
    postReview(prNumber: number, summary: string, findings: Finding[], event?: ReviewEvent): Promise<{
        url: string;
        event: ReviewEvent;
    }>;
}
declare function formatComment(f: Finding): string;
/** Parse "owner/repo", or fall back to the GITHUB_REPOSITORY env var (set in Actions). */
declare function resolveRepo(repoFlag?: string): {
    owner: string;
    repo: string;
};

declare function createProvider(name: ProviderName, model?: string): Provider;

interface ReviewTarget {
    title: string;
    body: string;
    /** Files to review (may be an incremental subset of the full diff). */
    files: DiffFile[];
    /** Head commit recorded in the summary marker; empty for local reviews. */
    headSha: string;
}
interface ReviewOptions {
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
declare const DEFAULT_EXCLUDES: string[];
declare function filterFiles(files: DiffFile[], exclude: string[]): DiffFile[];
/** Split files into batches whose annotated patches fit the character budget. */
declare function batchFiles(files: DiffFile[], budget: number): DiffFile[][];
/**
 * A single-line GitHub suggestion replaces exactly the anchored line, so a
 * multi-line suggestion without a matching range would corrupt the file if
 * committed. Range findings (endLine set) may carry multi-line suggestions.
 */
declare function sanitizeFindings(findings: Finding[]): Finding[];
declare function runReview(provider: Provider, target: ReviewTarget, options: ReviewOptions): Promise<{
    result: ReviewResult;
    dropped: Finding[];
}>;

/**
 * Collect the new-file line numbers that appear in a unified diff patch.
 * GitHub accepts side:RIGHT inline review comments on these lines.
 */
declare function commentableLines(patch: string): Set<number>;
/**
 * Prefix each right-side diff line with its new-file line number, and each
 * deleted line with its OLD-file line number followed by a "-" marker, so
 * the model can anchor findings on both sides of the diff.
 */
declare function annotatePatch(patch: string): string;
/**
 * Drop findings that reference files or lines not present in the diff —
 * GitHub rejects the whole review if any comment targets an invalid line.
 * Also downgrades invalid multi-line ranges to single-line, and strips
 * suggestions that are identical to the current code (no-op suggestions).
 */
declare function validateFindings(findings: Finding[], files: DiffFile[]): {
    valid: Finding[];
    dropped: Finding[];
};

/** Parse `git diff` output into per-file DiffFiles (deleted files are skipped). */
declare function parseUnifiedDiff(text: string): DiffFile[];
/** Run `git diff` against a base ref (or the index with staged=true). */
declare function localDiffFiles(base: string, staged: boolean): Promise<DiffFile[]>;

type OutputFormat = "text" | "json" | "sarif";
declare function toJson(result: ReviewResult, provider: Provider): string;
declare function toSarif(result: ReviewResult, provider: Provider): string;

declare const configSchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodEnum<{
        anthropic: "anthropic";
        openai: "openai";
        gemini: "gemini";
    }>>;
    model: z.ZodOptional<z.ZodString>;
    locale: z.ZodOptional<z.ZodString>;
    exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
    instructions: z.ZodOptional<z.ZodString>;
    minSeverity: z.ZodOptional<z.ZodEnum<{
        critical: "critical";
        warning: "warning";
        suggestion: "suggestion";
        nitpick: "nitpick";
    }>>;
    failOn: z.ZodOptional<z.ZodEnum<{
        critical: "critical";
        warning: "warning";
        suggestion: "suggestion";
        nitpick: "nitpick";
    }>>;
    batchChars: z.ZodOptional<z.ZodNumber>;
    context: z.ZodOptional<z.ZodEnum<{
        patch: "patch";
        full: "full";
    }>>;
    dedupe: z.ZodOptional<z.ZodBoolean>;
    incremental: z.ZodOptional<z.ZodBoolean>;
    event: z.ZodOptional<z.ZodEnum<{
        comment: "comment";
        auto: "auto";
    }>>;
    verify: z.ZodOptional<z.ZodBoolean>;
    output: z.ZodOptional<z.ZodEnum<{
        text: "text";
        json: "json";
        sarif: "sarif";
    }>>;
    repoContext: z.ZodOptional<z.ZodBoolean>;
    githubApiUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
type PrSageConfig = z.infer<typeof configSchema>;
declare const CONFIG_FILENAME = ".pr-sage.json";
declare function loadConfig(explicitPath?: string): Promise<PrSageConfig>;

declare function parseVerdicts(raw: unknown): Array<{
    index: number;
    confirmed: boolean;
}>;
declare function parseSummary(raw: unknown): string;
/**
 * Validate raw model output at runtime. A malformed overall shape throws;
 * individually malformed findings are dropped so one bad item doesn't
 * discard the whole batch.
 */
declare function parseReviewResult(raw: unknown, log: (message: string) => void): ReviewResult;

declare function isRetryable(error: unknown): boolean;
interface RetryOptions {
    retries?: number;
    baseDelayMs?: number;
    log?: (message: string) => void;
}
/** Retry `fn` on rate-limit/overload errors with exponential backoff + jitter. */
declare function withRetry<T>(fn: () => Promise<T>, { retries, baseDelayMs, log }?: RetryOptions): Promise<T>;

export { CONFIG_FILENAME, DEFAULT_EXCLUDES, type DiffFile, type Finding, GitHubClient, type OutputFormat, PR_SAGE_MARKER, type PrSageConfig, type Provider, type ProviderName, type PullRequestInfo, type ReviewEvent, type ReviewOptions, type ReviewResult, type ReviewTarget, SEVERITIES, type Severity, annotatePatch, batchFiles, commentableLines, createProvider, filterFiles, formatComment, isRetryable, loadConfig, localDiffFiles, parseReviewResult, parseSummary, parseUnifiedDiff, parseVerdicts, resolveRepo, runReview, sanitizeFindings, severityAtLeast, shaMarker, toJson, toSarif, validateFindings, withRetry };
