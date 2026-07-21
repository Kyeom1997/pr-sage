#!/usr/bin/env node
import { Command } from "commander";
import { GitHubClient, resolveRepo, formatComment } from "./github.js";
import { createProvider } from "./providers/index.js";
import { DEFAULT_EXCLUDES, runReview } from "./review.js";
import { loadConfig } from "./config.js";
import { SEVERITIES, severityAtLeast, type ProviderName, type Severity } from "./types.js";

const program = new Command();

program
  .name("pr-sage")
  .description("AI-powered GitHub pull request reviewer")
  .version("0.2.0");

program
  .command("review")
  .description("Review a pull request and post inline comments plus a summary")
  .requiredOption("-p, --pr <number>", "pull request number")
  .option("-r, --repo <owner/name>", "repository (defaults to $GITHUB_REPOSITORY)")
  .option("--provider <name>", "anthropic | openai | gemini")
  .option("-m, --model <id>", "model id (defaults to the provider's recommended model)")
  .option("--locale <lang>", "language for review output (e.g. Korean, English)")
  .option("--exclude <patterns>", "comma-separated globs or substrings to skip (added to defaults)")
  .option("--batch-chars <n>", "max diff characters per model request")
  .option("--config <path>", "config file path (default: .pr-sage.json if present)")
  .option("--min-severity <severity>", "drop findings below this severity")
  .option("--fail-on <severity>", "exit 1 if any finding is at or above this severity")
  .option("--context <mode>", "patch | full — send full file contents for better accuracy")
  .option("--no-dedupe", "repost findings already commented by a previous pr-sage review")
  .option("--dry-run", "print the review to stdout instead of posting to GitHub")
  .action(async (opts) => {
    const prNumber = Number(opts.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      fail(`Invalid PR number: ${opts.pr}`);
    }

    try {
      const config = await loadConfig(opts.config);

      const providerName = (opts.provider ?? config.provider ?? "anthropic") as ProviderName;
      if (!["anthropic", "openai", "gemini"].includes(providerName)) {
        fail(`Unknown provider "${providerName}". Use anthropic, openai, or gemini.`);
      }
      const minSeverity = parseSeverity(opts.minSeverity ?? config.minSeverity, "--min-severity");
      const failOn = parseSeverity(opts.failOn ?? config.failOn, "--fail-on");
      const context = opts.context ?? config.context ?? "patch";
      if (!["patch", "full"].includes(context)) {
        fail(`Invalid --context "${context}". Use patch or full.`);
      }
      const dedupe = opts.dedupe === false ? false : (config.dedupe ?? true);

      const token = process.env.GITHUB_TOKEN;
      if (!token) fail("GITHUB_TOKEN is not set.");

      const { owner, repo } = resolveRepo(opts.repo);
      const github = new GitHubClient(token!, owner, repo);
      const provider = createProvider(providerName, opts.model ?? config.model);

      console.error(`Fetching ${owner}/${repo}#${prNumber}...`);
      const pr = await github.fetchPullRequest(prNumber);

      const exclude = [
        ...DEFAULT_EXCLUDES,
        ...(config.exclude ?? []),
        ...(opts.exclude ? String(opts.exclude).split(",").map((s: string) => s.trim()) : []),
      ];

      const { result } = await runReview(provider, pr, {
        locale: opts.locale ?? config.locale ?? "English",
        exclude,
        batchCharBudget: Number(opts.batchChars ?? config.batchChars ?? 80_000),
        log: (msg) => console.error(msg),
        instructions: config.instructions,
        minSeverity,
        fetchContent:
          context === "full" ? (path) => github.fetchFileContent(path, pr.headSha) : undefined,
      });

      const gateTripped =
        failOn !== undefined && result.findings.some((f) => severityAtLeast(f.severity, failOn));

      if (opts.dryRun) {
        console.log(result.summary);
        console.log();
        for (const f of result.findings) {
          console.log(`--- ${f.path}:${f.line}`);
          console.log(formatComment(f));
          console.log();
        }
        finish(gateTripped, failOn);
      }

      let findingsToPost = result.findings;
      if (dedupe) {
        const history = await github.fetchPrSageHistory(prNumber);
        findingsToPost = result.findings.filter(
          (f) => !history.commentedLocations.has(`${f.path}:${f.line}`),
        );
        const skipped = result.findings.length - findingsToPost.length;
        if (skipped > 0) {
          console.error(`Skipping ${skipped} finding(s) already posted by a previous review.`);
        }
        if (findingsToPost.length === 0 && history.hasReview) {
          console.error("No new findings since the last pr-sage review; nothing posted.");
          finish(gateTripped, failOn);
        }
      }

      const url = await github.postReview(prNumber, result.summary, findingsToPost);
      console.error(`Review posted: ${url}`);
      finish(gateTripped, failOn);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

function parseSeverity(value: string | undefined, flag: string): Severity | undefined {
  if (value === undefined) return undefined;
  if (!SEVERITIES.includes(value as Severity)) {
    fail(`Invalid ${flag} "${value}". Use one of: ${SEVERITIES.join(", ")}.`);
  }
  return value as Severity;
}

function finish(gateTripped: boolean, failOn: Severity | undefined): never {
  if (gateTripped) {
    console.error(`Quality gate failed: found finding(s) at or above "${failOn}".`);
    process.exit(1);
  }
  process.exit(0);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

program.parseAsync();
