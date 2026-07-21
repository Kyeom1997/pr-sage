import type { DiffFile, Finding, PullRequestInfo } from "./types.js";
import { commentableLines } from "./diff.js";

const API = "https://api.github.com";

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status} on ${path}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async fetchPullRequest(prNumber: number): Promise<PullRequestInfo> {
    const pr = await this.request<{
      title: string;
      body: string | null;
      base: { ref: string };
      head: { ref: string; sha: string };
    }>(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);

    const files: DiffFile[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<
        Array<{ filename: string; status: string; patch?: string }>
      >(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
      for (const f of batch) {
        // Binary files and very large files come without a patch — skip them.
        if (!f.patch) continue;
        files.push({
          path: f.filename,
          status: f.status,
          patch: f.patch,
          commentableLines: commentableLines(f.patch),
        });
      }
      if (batch.length < 100) break;
    }

    return {
      title: pr.title,
      body: pr.body ?? "",
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      files,
    };
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

  /**
   * Locate previous pr-sage activity on this PR: inline-comment locations
   * (for dedup) and whether any pr-sage summary review exists.
   */
  async fetchPrSageHistory(
    prNumber: number,
  ): Promise<{ commentedLocations: Set<string>; hasReview: boolean }> {
    const commentedLocations = new Set<string>();
    for (let page = 1; ; page++) {
      const batch = await this.request<
        Array<{ path: string; line: number | null; body: string }>
      >(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`);
      for (const c of batch) {
        if (c.line !== null && c.body.includes(PR_SAGE_MARKER)) {
          commentedLocations.add(`${c.path}:${c.line}`);
        }
      }
      if (batch.length < 100) break;
    }

    let hasReview = false;
    for (let page = 1; ; page++) {
      const batch = await this.request<Array<{ body: string | null }>>(
        `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      );
      if (batch.some((r) => r.body?.includes(PR_SAGE_MARKER))) hasReview = true;
      if (batch.length < 100) break;
    }

    return { commentedLocations, hasReview };
  }

  async postReview(prNumber: number, summary: string, findings: Finding[]): Promise<string> {
    const review = await this.request<{ html_url: string }>(
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({
          event: "COMMENT",
          body: summary,
          comments: findings.map((f) => ({
            path: f.path,
            line: f.line,
            side: "RIGHT",
            body: formatComment(f),
          })),
        }),
      },
    );
    return review.html_url;
  }
}

/** Hidden marker identifying comments posted by pr-sage (used for dedup). */
export const PR_SAGE_MARKER = "<!-- pr-sage -->";

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
  return `${body}\n\n${PR_SAGE_MARKER}`;
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
