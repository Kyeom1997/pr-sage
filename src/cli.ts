#!/usr/bin/env node
import { Command } from "commander";
import { GitHubClient, resolveRepo, formatComment } from "./github.js";
import { createProvider } from "./providers/index.js";
import { DEFAULT_EXCLUDES, runReview } from "./review.js";
import type { ProviderName } from "./types.js";

const program = new Command();

program
  .name("pr-sage")
  .description("AI-powered GitHub pull request reviewer")
  .version("0.1.0");

program
  .command("review")
  .description("Review a pull request and post inline comments plus a summary")
  .requiredOption("-p, --pr <number>", "pull request number")
  .option("-r, --repo <owner/name>", "repository (defaults to $GITHUB_REPOSITORY)")
  .option("--provider <name>", "anthropic | openai | gemini", "anthropic")
  .option("-m, --model <id>", "model id (defaults to the provider's recommended model)")
  .option("--locale <lang>", "language for review output (e.g. Korean, English)", "English")
  .option("--exclude <patterns>", "comma-separated path substrings to skip (added to defaults)")
  .option("--batch-chars <n>", "max diff characters per model request", "80000")
  .option("--dry-run", "print the review to stdout instead of posting to GitHub")
  .action(async (opts) => {
    const prNumber = Number(opts.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      fail(`Invalid PR number: ${opts.pr}`);
    }

    const providerName = opts.provider as ProviderName;
    if (!["anthropic", "openai", "gemini"].includes(providerName)) {
      fail(`Unknown provider "${opts.provider}". Use anthropic, openai, or gemini.`);
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) fail("GITHUB_TOKEN is not set.");

    try {
      const { owner, repo } = resolveRepo(opts.repo);
      const github = new GitHubClient(token!, owner, repo);
      const provider = createProvider(providerName, opts.model);

      console.error(`Fetching ${owner}/${repo}#${prNumber}...`);
      const pr = await github.fetchPullRequest(prNumber);

      const exclude = [
        ...DEFAULT_EXCLUDES,
        ...(opts.exclude ? String(opts.exclude).split(",").map((s: string) => s.trim()) : []),
      ];

      const { result } = await runReview(provider, pr, {
        locale: opts.locale,
        exclude,
        batchCharBudget: Number(opts.batchChars),
        log: (msg) => console.error(msg),
      });

      if (opts.dryRun) {
        console.log(result.summary);
        console.log();
        for (const f of result.findings) {
          console.log(`--- ${f.path}:${f.line}`);
          console.log(formatComment(f));
          console.log();
        }
        return;
      }

      const url = await github.postReview(prNumber, result.summary, result.findings);
      console.error(`Review posted: ${url}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

program.parseAsync();
