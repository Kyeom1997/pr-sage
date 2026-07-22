#!/usr/bin/env node
// Measurement harness: run pr-sage (dry, nothing posted) over real merged PRs
// from public repos.
//
// --mode noise (default): review merged PRs as-is. Measures how quiet the
//   tool stays on already-human-reviewed code (findings per PR, severity mix,
//   latency, token usage) + a labeling sheet for the valid-review rate.
//
// --mode recall: pick merged PRs that received human review comments, review
//   the PR's FIRST commit (the state humans reviewed), and check how many
//   human-flagged locations pr-sage also flags (same file, within ±10 lines).
//   Approximate by nature — human comments may target later commits — so the
//   output includes a side-by-side sheet for human judgment.
//
// Usage:
//   GITHUB_TOKEN=.. GEMINI_API_KEY=.. node scripts/bench.mjs \
//     --repos cli/cli,fastify/fastify --per-repo 5 [--mode noise|recall] \
//     --provider gemini --model gemini-flash-lite-latest --batch-chars 25000
//
// Output: bench-results/run-<id>.json, bench-results/run-<id>-labeling.md

import { mkdir, writeFile } from "node:fs/promises";
import {
  GitHubClient,
  createProvider,
  runReview,
  DEFAULT_EXCLUDES,
} from "../dist/index.js";

const args = parseArgs(process.argv.slice(2));
const repos = (args.repos ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (repos.length === 0) {
  console.error("Usage: node scripts/bench.mjs --repos owner/name[,owner/name...] [--per-repo 5] [--provider gemini] [--model id] [--batch-chars 80000] [--max-files 30]");
  process.exit(1);
}
const perRepo = Number(args["per-repo"] ?? 5);
const maxFiles = Number(args["max-files"] ?? 30);
const providerName = args.provider ?? "gemini";
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is not set.");
  process.exit(1);
}

const provider = createProvider(providerName, args.model);
const mode = args.mode ?? "noise";
const results = [];
const recallResults = [];
const failures = [];

for (const repoFull of repos) {
  const [owner, repo] = repoFull.split("/");
  const github = new GitHubClient(token, owner, repo);

  if (mode === "recall") {
    await runRecallForRepo(repoFull, github);
    continue;
  }

  const prNumbers = await listRecentMergedPrs(repoFull, perRepo, maxFiles);
  console.error(`${repoFull}: benchmarking ${prNumbers.length} merged PR(s): ${prNumbers.join(", ")}`);

  for (const prNumber of prNumbers) {
    const before = snapshotUsage(provider);
    const startedAt = Date.now();
    try {
      const pr = await github.fetchPullRequest(prNumber);
      const { result, dropped } = await runReview(
        provider,
        { title: pr.title, body: pr.body, files: pr.files, headSha: pr.headSha },
        {
          locale: args.locale ?? "English",
          exclude: DEFAULT_EXCLUDES,
          batchCharBudget: Number(args["batch-chars"] ?? 80_000),
          verify: Boolean(args.verify),
          log: () => {},
        },
      );
      const durationMs = Date.now() - startedAt;
      const usage = usageDelta(before, snapshotUsage(provider));
      const bySeverity = {};
      for (const f of result.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      results.push({
        repo: repoFull,
        pr: prNumber,
        url: `https://github.com/${repoFull}/pull/${prNumber}`,
        title: pr.title,
        files: pr.files.length,
        diffChars: pr.files.reduce((n, f) => n + f.patch.length, 0),
        durationMs,
        usage,
        findings: result.findings,
        bySeverity,
        droppedOutOfDiff: dropped.length,
      });
      console.error(`  #${prNumber}: ${result.findings.length} finding(s) in ${(durationMs / 1000).toFixed(1)}s (${usage.inputTokens}in/${usage.outputTokens}out tok)`);
    } catch (error) {
      failures.push({ repo: repoFull, pr: prNumber, error: String(error?.message ?? error) });
      console.error(`  #${prNumber}: FAILED — ${error?.message ?? error}`);
    }
  }
}

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await mkdir("bench-results", { recursive: true });

const summary = mode === "recall" ? summarizeRecall(recallResults) : summarize(results);
await writeFile(
  `bench-results/run-${runId}.json`,
  JSON.stringify(
    { mode, provider: provider.name, model: provider.model, args, summary, results, recallResults, failures },
    null,
    2,
  ),
);
await writeFile(
  `bench-results/run-${runId}-labeling.md`,
  mode === "recall" ? recallDoc(recallResults) : labelingDoc(results),
);

console.error("\n=== Summary ===");
console.error(JSON.stringify(summary, null, 2));
console.error(`\nWrote bench-results/run-${runId}.json`);
console.error(`Wrote bench-results/run-${runId}-labeling.md`);

// --- recall mode ---

async function runRecallForRepo(repoFull, github) {
  const gh = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path}: ${r.status}`))));

  const closed = await gh(`/repos/${repoFull}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
  const merged = closed.filter((p) => p.merged_at);
  let picked = 0;

  for (const p of merged) {
    if (picked >= perRepo) break;
    try {
      const comments = await gh(`/repos/${repoFull}/pulls/${p.number}/comments?per_page=100`);
      const human = comments.filter(
        (c) =>
          c.user?.type !== "Bot" &&
          !c.body?.includes("<!-- pr-sage") &&
          (c.original_line ?? c.line) !== null,
      );
      if (human.length < 1 || human.length > 25) continue;

      const detail = await gh(`/repos/${repoFull}/pulls/${p.number}`);
      if (detail.changed_files > maxFiles) continue;
      const commits = await gh(`/repos/${repoFull}/pulls/${p.number}/commits?per_page=100`);
      if (commits.length === 0) continue;
      const firstSha = commits[0].sha;

      // The state human reviewers first saw: base...first-commit.
      const files = await github.compareFiles(detail.base.sha, firstSha);
      if (files.length === 0) continue;

      const { result } = await runReview(
        provider,
        { title: p.title, body: p.body ?? "", files, headSha: "" },
        {
          locale: args.locale ?? "English",
          exclude: DEFAULT_EXCLUDES,
          batchCharBudget: Number(args["batch-chars"] ?? 80_000),
          verify: Boolean(args.verify),
          log: () => {},
        },
      );

      // Group comments by location: replies in the same thread are one
      // review target, not several.
      const byLocation = new Map();
      for (const c of human) {
        const line = c.original_line ?? c.line;
        const key = `${c.path}:${line}`;
        const existing = byLocation.get(key);
        if (existing) existing.replies++;
        else {
          byLocation.set(key, {
            path: c.path,
            line,
            author: c.user?.login,
            replies: 0,
            excerpt: (c.body ?? "").replaceAll("\n", " ").slice(0, 160),
          });
        }
      }
      const targets = [...byLocation.values()];
      const matched = targets.map((t) => ({
        ...t,
        hit: result.findings.some(
          (f) => f.path === t.path && Math.abs(f.line - t.line) <= 10,
        ),
      }));

      recallResults.push({
        repo: repoFull,
        pr: p.number,
        url: `https://github.com/${repoFull}/pull/${p.number}`,
        title: p.title,
        files: files.length,
        humanComments: matched,
        hits: matched.filter((m) => m.hit).length,
        prSageFindings: result.findings.map((f) => ({
          path: f.path,
          line: f.line,
          severity: f.severity,
          title: f.title,
        })),
      });
      picked++;
      console.error(
        `${repoFull}#${p.number}: ${matched.filter((m) => m.hit).length}/${matched.length} human comment(s) matched, ${result.findings.length} pr-sage finding(s)`,
      );
    } catch (error) {
      failures.push({ repo: repoFull, pr: p.number, error: String(error?.message ?? error) });
      console.error(`${repoFull}#${p.number}: FAILED — ${error?.message ?? error}`);
    }
  }
}

function summarizeRecall(rows) {
  if (rows.length === 0) return { mode: "recall", prs: 0 };
  const totalTargets = rows.reduce((n, r) => n + r.humanComments.length, 0);
  const totalHits = rows.reduce((n, r) => n + r.hits, 0);
  return {
    mode: "recall",
    prs: rows.length,
    humanComments: totalTargets,
    matched: totalHits,
    approxRecall: totalTargets > 0 ? Number((totalHits / totalTargets).toFixed(3)) : null,
    prSageFindingsTotal: rows.reduce((n, r) => n + r.prSageFindings.length, 0),
  };
}

function recallDoc(rows) {
  const lines = [
    "# Recall sheet — human review comments vs pr-sage findings",
    "",
    "Each PR was reviewed at its FIRST commit (the state human reviewers saw).",
    "`hit` means pr-sage flagged the same file within ±10 lines of a human comment —",
    "an approximation: verify each pair by hand before quoting a recall number.",
    "",
  ];
  for (const r of rows) {
    lines.push(`## ${r.repo}#${r.pr} — ${r.title} (${r.hits}/${r.humanComments.length} matched)`, r.url, "");
    for (const c of r.humanComments) {
      lines.push(`- [${c.hit ? "x" : " "}] \`${c.path}:${c.line}\` (@${c.author}) ${c.excerpt}`);
    }
    if (r.prSageFindings.length > 0) {
      lines.push("", "  pr-sage findings on the first commit:");
      for (const f of r.prSageFindings) {
        lines.push(`  - \`${f.path}:${f.line}\` **[${f.severity}]** ${f.title}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- helpers ---

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function listRecentMergedPrs(repoFull, count, maxFiles) {
  const res = await fetch(
    `https://api.github.com/repos/${repoFull}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`Listing PRs for ${repoFull} failed: ${res.status}`);
  const prs = await res.json();
  const merged = prs.filter((p) => p.merged_at);
  const picked = [];
  for (const p of merged) {
    if (picked.length >= count) break;
    const detail = await fetch(`https://api.github.com/repos/${repoFull}/pulls/${p.number}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    }).then((r) => (r.ok ? r.json() : null));
    if (detail && detail.changed_files > 0 && detail.changed_files <= maxFiles) picked.push(p.number);
  }
  return picked;
}

function snapshotUsage(p) {
  return p.usage ? { ...p.usage } : { calls: 0, inputTokens: 0, outputTokens: 0 };
}

function usageDelta(a, b) {
  return {
    calls: b.calls - a.calls,
    inputTokens: b.inputTokens - a.inputTokens,
    outputTokens: b.outputTokens - a.outputTokens,
  };
}

function summarize(results) {
  if (results.length === 0) return { prs: 0 };
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const severities = {};
  for (const r of results)
    for (const [s, n] of Object.entries(r.bySeverity)) severities[s] = (severities[s] ?? 0) + n;
  return {
    prs: results.length,
    totalFindings,
    findingsPerPr: Number((totalFindings / results.length).toFixed(2)),
    prsWithZeroFindings: results.filter((r) => r.findings.length === 0).length,
    severities,
    medianDurationMs: durations[Math.floor(durations.length / 2)],
    totalInputTokens: results.reduce((n, r) => n + r.usage.inputTokens, 0),
    totalOutputTokens: results.reduce((n, r) => n + r.usage.outputTokens, 0),
    droppedOutOfDiff: results.reduce((n, r) => n + r.droppedOutOfDiff, 0),
  };
}

function labelingDoc(results) {
  const lines = [
    "# Finding labeling sheet",
    "",
    "For each finding, open the PR diff and judge it. Check the box if the finding is **valid**",
    "(a real, defensible review comment a good human reviewer could have made). Leave unchecked if",
    "it is wrong, speculative, or noise. valid-review rate = checked / total.",
    "",
  ];
  for (const r of results) {
    if (r.findings.length === 0) continue;
    lines.push(`## ${r.repo}#${r.pr} — ${r.title}`, `${r.url}/files`, "");
    for (const f of r.findings) {
      const body = f.body.replaceAll("\n", " ").slice(0, 220);
      lines.push(`- [ ] \`${f.path}:${f.line}\` **[${f.severity}]** ${f.title} — ${body}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
