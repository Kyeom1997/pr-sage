import type {
  DiffFile,
  Finding,
  PullRequestInfo,
  ReviewCoverage,
  ReviewEvent,
  ReviewResult,
} from "./types.js";
import { commentableLines, commentableOldLines } from "./diff.js";

/** Hidden marker identifying comments posted by pr-sage (used for dedup). */
export const PR_SAGE_MARKER = "<!-- pr-sage -->";

/** Marker recording which head commit a summary review covered. */
export function shaMarker(sha: string): string {
  return `<!-- pr-sage sha:${sha} -->`;
}

const SHA_MARKER_RE = /<!-- pr-sage sha:([0-9a-f]{6,40}) -->/;
const FP_MARKER_RE = /<!-- pr-sage fp:([0-9a-z]+) -->/;
const ACTIVE_MARKER_RE = /<!-- pr-sage active:([A-Za-z0-9_-]+) -->/;

/**
 * Content-based identity of a finding (path + normalized title), stable
 * across line shifts. Used to avoid reposting the same issue after new
 * commits move it to a different line.
 */
export function findingFingerprint(f: Pick<Finding, "path" | "title">): string {
  // Strip punctuation/backticks so a lightly rephrased title (e.g. added
  // quotes) still maps to the same fingerprint.
  const title = f.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const input = `${f.path}|${title}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function fpMarker(f: Pick<Finding, "path" | "title">): string {
  return `<!-- pr-sage fp:${findingFingerprint(f)} -->`;
}

export function findingKey(f: Pick<Finding, "path" | "title">): string {
  return `${f.path}|${findingFingerprint(f)}`;
}

export function activeMarker(keys: Iterable<string>): string {
  const encoded = Buffer.from(JSON.stringify([...new Set(keys)].sort())).toString("base64url");
  return `<!-- pr-sage active:${encoded} -->`;
}

export function replaceActiveMarker(summary: string, keys: Iterable<string>): string {
  const marker = activeMarker(keys);
  return ACTIVE_MARKER_RE.test(summary)
    ? summary.replace(ACTIVE_MARKER_RE, marker)
    : `${summary}\n${marker}`;
}

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
    baseUrl?: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
    // GitHub Actions sets GITHUB_API_URL automatically, including on GHES.
    this.baseUrl = (baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      // Primary (429) and secondary (403 + message) rate limits are transient.
      const rateLimited =
        res.status === 429 || (res.status === 403 && /rate limit/i.test(text));
      if (rateLimited && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2000 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 60_000)));
        continue;
      }
      throw new Error(`GitHub API ${res.status} on ${path}: ${text}`);
    }
  }

  async fetchPullRequest(prNumber: number): Promise<PullRequestInfo> {
    const pr = await this.request<{
      title: string;
      body: string | null;
      draft?: boolean;
      labels?: Array<{ name: string }>;
      base: { ref: string; sha: string };
      head: { ref: string; sha: string };
    }>(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);

    const files: DiffFile[] = [];
    let missingPatchFiles = 0;
    for (let page = 1; ; page++) {
      const batch = await this.request<
        Array<{ filename: string; status: string; patch?: string }>
      >(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
      for (const f of batch) {
        // Binary files and very large files come without a patch — skip them.
        if (!f.patch) {
          missingPatchFiles++;
          continue;
        }
        files.push({
          path: f.filename,
          status: f.status,
          patch: f.patch,
          commentableLines: commentableLines(f.patch),
          commentableOldLines: commentableOldLines(f.patch),
        });
      }
      if (batch.length < 100) break;
    }

    return {
      title: pr.title,
      body: pr.body ?? "",
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      draft: pr.draft ?? false,
      labels: (pr.labels ?? []).map((l) => l.name),
      files,
      missingPatchFiles,
    };
  }

  async fetchPullRequestHead(prNumber: number): Promise<string> {
    const pr = await this.request<{ head: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
    );
    return pr.head.sha;
  }

  /** Files changed between two commits (for incremental review). */
  async compareFiles(baseSha: string, headSha: string): Promise<DiffFile[]> {
    const cmp = await this.request<{
      files?: Array<{ filename: string; status: string; patch?: string }>;
    }>(`/repos/${this.owner}/${this.repo}/compare/${baseSha}...${headSha}`);
    // The compare API silently caps at 300 files; a capped listing would make
    // an incremental review skip changes, so force a full-review fallback.
    if ((cmp.files?.length ?? 0) >= 300) {
      throw new Error("compare listing truncated at 300 files");
    }
    return (cmp.files ?? [])
      .filter((f) => f.patch)
      .map((f) => ({
        path: f.filename,
        status: f.status,
        patch: f.patch!,
        commentableLines: commentableLines(f.patch!),
        commentableOldLines: commentableOldLines(f.patch!),
      }));
  }

  /** Fetch a file's content at a given ref. Returns null for binary/oversized/missing files. */
  async fetchFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.request<{ type: string; encoding?: string; content?: string }>(
        `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}?ref=${ref}`,
      );
      if (res.type !== "file" || res.encoding !== "base64" || !res.content) return null;
      return Buffer.from(res.content, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  /** Fetch repo guideline docs (CLAUDE.md, CONTRIBUTING.md) to inject as review context. */
  async fetchRepoGuidelines(ref: string): Promise<string | null> {
    const candidates = ["CLAUDE.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"];
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const path of candidates) {
      const basename = path.split("/").pop()!;
      if (seen.has(basename)) continue;
      const content = await this.fetchFileContent(path, ref);
      if (content) {
        seen.add(basename);
        parts.push(`--- ${path} ---\n${content.slice(0, 6000)}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /**
   * Locate previous pr-sage activity on this PR: inline-comment locations
   * (for dedup), whether any pr-sage summary review exists, and the head
   * commit the most recent one covered (for incremental review).
   */
  async fetchPrSageHistory(prNumber: number): Promise<{
    /** `${path}:${SIDE}:${line}` of previously posted pr-sage comments. */
    commentedLocations: Set<string>;
    /** `${path}|${fingerprint}` of previously posted findings (line-shift-proof). */
    fingerprints: Set<string>;
    hasReview: boolean;
    lastReviewedSha: string | null;
    /** Finding keys recorded as active by the most recent pr-sage review. */
    activeFingerprints: Set<string>;
  }> {
    const commentedLocations = new Set<string>();
    const fingerprints = new Set<string>();
    for (let page = 1; ; page++) {
      const batch = await this.request<
        Array<{ path: string; line: number | null; side?: string | null; body: string }>
      >(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`);
      for (const c of batch) {
        if (c.line !== null && c.body.includes(PR_SAGE_MARKER)) {
          commentedLocations.add(`${c.path}:${c.side ?? "RIGHT"}:${c.line}`);
          const fp = c.body.match(FP_MARKER_RE)?.[1];
          if (fp) fingerprints.add(`${c.path}|${fp}`);
        }
      }
      if (batch.length < 100) break;
    }

    let hasReview = false;
    let lastReviewedSha: string | null = null;
    let activeFingerprints = new Set<string>();
    for (let page = 1; ; page++) {
      const batch = await this.request<Array<{ body: string | null }>>(
        `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      );
      for (const review of batch) {
        if (!review.body?.includes("<!-- pr-sage")) continue;
        hasReview = true;
        const sha = review.body.match(SHA_MARKER_RE)?.[1];
        if (sha) lastReviewedSha = sha; // reviews are chronological; last wins
        const encoded = review.body.match(ACTIVE_MARKER_RE)?.[1];
        if (encoded) {
          try {
            const keys = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
            if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) {
              activeFingerprints = new Set(keys);
            }
          } catch {
            // Ignore malformed markers from older/manual reviews.
          }
        }
      }
      if (batch.length < 100) break;
    }

    return {
      commentedLocations,
      fingerprints,
      hasReview,
      lastReviewedSha,
      activeFingerprints,
    };
  }

  async postReview(
    prNumber: number,
    summary: string,
    findings: Finding[],
    event: ReviewEvent = "COMMENT",
  ): Promise<{ url: string; event: ReviewEvent }> {
    const post = (ev: ReviewEvent) =>
      this.request<{ html_url: string }>(
        `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`,
        {
          method: "POST",
          body: JSON.stringify({
            event: ev,
            body: summary,
            comments: findings.map((f) =>
              (f.side ?? "added") === "removed"
                ? { path: f.path, body: formatComment(f), side: "LEFT", line: f.line }
                : {
                    path: f.path,
                    body: formatComment(f),
                    side: "RIGHT",
                    ...(f.endLine !== undefined && f.endLine > f.line
                      ? { start_line: f.line, start_side: "RIGHT", line: f.endLine }
                      : { line: f.line }),
                  },
            ),
          }),
        },
      );

    try {
      const review = await post(event);
      return { url: review.html_url, event };
    } catch (error) {
      // APPROVE/REQUEST_CHANGES can be rejected (e.g. reviewing your own PR);
      // fall back to a plain comment review rather than losing the review.
      if (event !== "COMMENT" && error instanceof Error && error.message.includes("422")) {
        const review = await post("COMMENT");
        return { url: review.html_url, event: "COMMENT" };
      }
      throw error;
    }
  }

  async postCheckRun(
    headSha: string,
    result: ReviewResult,
    gateTripped: boolean,
  ): Promise<string> {
    const coverage = result.coverage;
    const incomplete = coverage?.complete === false;
    const conclusion = gateTripped ? "failure" : incomplete ? "neutral" : "success";
    const annotations = result.findings.slice(0, 50).map((f) => ({
      path: f.path,
      start_line: f.line,
      ...(f.endLine ? { end_line: f.endLine } : {}),
      annotation_level: f.severity === "critical"
        ? "failure"
        : f.severity === "warning"
          ? "warning"
          : "notice",
      title: f.title.slice(0, 255),
      message: f.body.slice(0, 65_535),
    }));
    const coverageText = coverage ? formatCoverage(coverage) : "Coverage unavailable";
    const check = await this.request<{ html_url: string }>(
      `/repos/${this.owner}/${this.repo}/check-runs`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "pr-sage",
          head_sha: headSha,
          status: "completed",
          conclusion,
          output: {
            title: gateTripped
              ? "Review quality gate failed"
              : incomplete
                ? "Review completed with partial coverage"
                : "Review completed",
            summary: `${coverageText}\n\n${result.findings.length} finding(s).`,
            annotations,
          },
        }),
      },
    );
    return check.html_url;
  }
}

function formatCoverage(coverage: ReviewCoverage): string {
  const reasons = coverage.reasons.length > 0 ? ` (${coverage.reasons.join(", ")})` : "";
  return `Coverage: ${coverage.reviewedFiles}/${coverage.totalFiles} files${reasons}`;
}

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  critical: "🔴 **Critical**",
  warning: "🟡 **Warning**",
  suggestion: "🔵 **Suggestion**",
  nitpick: "⚪ **Nitpick**",
};

export function formatComment(f: Finding): string {
  let body = `${SEVERITY_BADGE[f.severity]} — ${f.title}\n\n${f.body}`;
  if (f.suggestion) {
    body += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return `${body}\n\n${PR_SAGE_MARKER}\n${fpMarker(f)}`;
}

/** Parse "owner/repo", or fall back to the GITHUB_REPOSITORY env var (set in Actions). */
export function resolveRepo(repoFlag?: string): { owner: string; repo: string } {
  const value = repoFlag ?? process.env.GITHUB_REPOSITORY;
  if (!value) {
    throw new Error(
      "Repository not specified. Pass --repo owner/name or set GITHUB_REPOSITORY.",
    );
  }
  const [owner, repo] = value.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository "${value}" — expected owner/name.`);
  return { owner, repo };
}
