#!/usr/bin/env node
// Measurement harness: run pr-sage (dry, nothing posted) over real merged PRs
// from public repos and collect the numbers that matter — findings per PR,
// severity mix, latency, token usage — plus a labeling file for humans to
// mark each finding valid/invalid, which is how we measure the false-positive
// rate.
//
// Usage:
//   GITHUB_TOKEN=.. GEMINI_API_KEY=.. node scripts/bench.mjs \
//     --repos cli/cli,fastify/fastify --per-repo 5 \
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
const results = [];
const failures = [];

for (const repoFull of repos) {
  const [owner, repo] = repoFull.split("/");
  const github = new GitHubClient(token, owner, repo);
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

const summary = summarize(results);
await writeFile(
  `bench-results/run-${runId}.json`,
  JSON.stringify({ provider: provider.name, model: provider.model, args, summary, results, failures }, null, 2),
);
await writeFile(`bench-results/run-${runId}-labeling.md`, labelingDoc(results));

console.error("\n=== Summary ===");
console.error(JSON.stringify(summary, null, 2));
console.error(`\nWrote bench-results/run-${runId}.json`);
console.error(`Wrote bench-results/run-${runId}-labeling.md — mark each finding, then count checked/total for the valid-review rate.`);

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
