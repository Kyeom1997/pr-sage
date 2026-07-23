import { describe, expect, it } from "vitest";
import {
  GitHubClient,
  activeMarker,
  findingFingerprint,
  findingKey,
  formatComment,
} from "../src/github.js";
import type { Finding } from "../src/types.js";

type FakeCall = { url: string; init?: RequestInit };

/** fetch stub that pops queued responses and records calls. */
function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: FakeCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, json: { message: "queue empty" } };
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const client = (impl: typeof fetch) =>
  new GitHubClient("tok", "owner", "repo", "https://api.github.com", impl);

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts",
  line: 3,
  severity: "warning",
  title: "t",
  body: "b",
  ...overrides,
});

describe("GitHubClient.fetchPullRequest", () => {
  it("paginates file listing and skips patch-less (binary) files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      patch: "@@ -1,1 +1,1 @@\n+x",
    }));
    const page2 = [
      { filename: "last.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n+y" },
      { filename: "image.png", status: "added" }, // no patch
    ];
    const { impl, calls } = fakeFetch([
      {
        json: {
          title: "T",
          body: null,
          base: { ref: "main", sha: "base123" },
          head: { ref: "b", sha: "abc1234" },
        },
      },
      { json: page1 },
      { json: page2 },
    ]);
    const pr = await client(impl).fetchPullRequest(7);
    expect(pr.files).toHaveLength(101);
    expect(pr.headSha).toBe("abc1234");
    expect(pr.baseSha).toBe("base123");
    expect(pr.missingPatchFiles).toBe(1);
    expect(pr.body).toBe("");
    expect(calls[1]?.url).toContain("page=1");
    expect(calls[2]?.url).toContain("page=2");
  });

  it("throws with status code on auth failure", async () => {
    const { impl } = fakeFetch([{ status: 401, json: { message: "Bad credentials" } }]);
    await expect(client(impl).fetchPullRequest(1)).rejects.toThrow(/401.*Bad credentials/s);
  });
});

describe("GitHubClient.postReview", () => {
  it("sends single-line, range, and deleted-line comments with the right payload shape", async () => {
    const { impl, calls } = fakeFetch([{ json: { html_url: "https://x/1" } }]);
    await client(impl).postReview(1, "sum", [
      finding(),
      finding({ line: 5, endLine: 8 }),
      finding({ line: 12, side: "removed", endLine: 20 }),
    ]);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.event).toBe("COMMENT");
    expect(body.comments[0]).toMatchObject({ path: "src/a.ts", line: 3, side: "RIGHT" });
    expect(body.comments[0].start_line).toBeUndefined();
    expect(body.comments[1]).toMatchObject({ start_line: 5, line: 8, start_side: "RIGHT" });
    expect(body.comments[2]).toMatchObject({ side: "LEFT", line: 12 });
    expect(body.comments[2].start_line).toBeUndefined();
    expect(body.comments[0].body).toContain("<!-- pr-sage -->");
    expect(body.comments[0].body).toContain("<!-- pr-sage fp:");
  });

  it("falls back to COMMENT when APPROVE is rejected with 422", async () => {
    const { impl, calls } = fakeFetch([
      { status: 422, json: { message: "Can not approve your own pull request" } },
      { json: { html_url: "https://x/2" } },
    ]);
    const posted = await client(impl).postReview(1, "sum", [], "APPROVE");
    expect(posted.event).toBe("COMMENT");
    expect(JSON.parse(String(calls[0]?.init?.body)).event).toBe("APPROVE");
    expect(JSON.parse(String(calls[1]?.init?.body)).event).toBe("COMMENT");
  });
});

describe("GitHubClient.postCheckRun", () => {
  it("uses a neutral conclusion for incomplete coverage", async () => {
    const { impl, calls } = fakeFetch([{ json: { html_url: "https://x/check" } }]);
    await client(impl).postCheckRun(
      "abc",
      {
        summary: "partial",
        findings: [finding()],
        coverage: {
          complete: false,
          totalFiles: 2,
          reviewedFiles: 1,
          skippedFiles: 1,
          skippedBatches: 1,
          reasons: ["token-budget"],
        },
      },
      false,
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.conclusion).toBe("neutral");
    expect(body.output.annotations).toHaveLength(1);
  });
});

describe("GitHubClient.fetchPrSageHistory", () => {
  it("collects marked locations, fingerprints, and the last reviewed sha", async () => {
    const f = finding();
    const { impl } = fakeFetch([
      {
        json: [
          { path: "src/a.ts", line: 3, body: formatComment(f) },
          { path: "src/a.ts", line: 9, body: "human comment, no marker" },
          { path: "old.ts", line: null, body: "outdated <!-- pr-sage -->" },
        ],
      },
      {
        json: [
          { body: "old summary <!-- pr-sage -->\n<!-- pr-sage sha:aaa111 -->" },
          {
            body: `newer summary <!-- pr-sage -->\n<!-- pr-sage sha:bbb222 -->\n${activeMarker([
              findingKey(f),
            ])}`,
          },
          { body: "human review" },
        ],
      },
    ]);
    const history = await client(impl).fetchPrSageHistory(1);
    expect(history.commentedLocations).toEqual(new Set(["src/a.ts:RIGHT:3"]));
    expect(history.fingerprints).toEqual(new Set([`src/a.ts|${findingFingerprint(f)}`]));
    expect(history.hasReview).toBe(true);
    expect(history.lastReviewedSha).toBe("bbb222");
    expect(history.activeFingerprints).toEqual(new Set([findingKey(f)]));
  });
});

describe("GitHubClient.compareFiles", () => {
  it("maps compare files and drops patch-less entries", async () => {
    const { impl } = fakeFetch([
      {
        json: {
          files: [
            { filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n+z" },
            { filename: "big.bin", status: "modified" },
          ],
        },
      },
    ]);
    const files = await client(impl).compareFiles("aaa", "bbb");
    expect(files).toHaveLength(1);
    expect([...files[0]!.commentableLines]).toEqual([1]);
  });
});

describe("findingFingerprint", () => {
  it("is stable across line moves but distinguishes titles and paths", () => {
    expect(findingFingerprint(finding({ line: 3 }))).toBe(findingFingerprint(finding({ line: 99 })));
    expect(findingFingerprint(finding({ title: "  T  " }))).toBe(findingFingerprint(finding({ title: "t" })));
    expect(findingFingerprint(finding())).not.toBe(findingFingerprint(finding({ title: "other" })));
    expect(findingFingerprint(finding())).not.toBe(findingFingerprint(finding({ path: "b.ts" })));
  });

  it("ignores punctuation so lightly rephrased titles still match", () => {
    expect(findingFingerprint(finding({ title: "Use `res.ok` here!" }))).toBe(
      findingFingerprint(finding({ title: "use res ok here" })),
    );
  });
});
