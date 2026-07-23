#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline/promises";
import { Command } from "commander";
import { GitHubClient, resolveRepo, formatComment, findingFingerprint } from "./github.js";
import { createProvider } from "./providers/index.js";
import { DEFAULT_EXCLUDES, includeFiles, runReview, type ReviewTarget } from "./review.js";
import { loadConfig, skipReason, CONFIG_FILENAME, type PrSageConfig } from "./config.js";
import { localDiffFiles } from "./localdiff.js";
import { resolveLocale } from "./locale.js";
import {
  buildConfig,
  buildWorkflow,
  secretInstructions,
  PROVIDER_KEY_ENV,
  type InitAnswers,
} from "./init.js";
import { toJson, toSarif, type OutputFormat } from "./output.js";
import {
  SEVERITIES,
  severityAtLeast,
  type Finding,
  type Provider,
  type ProviderName,
  type ReviewEvent,
  type ReviewResult,
  type Severity,
} from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("pr-sage")
  .description("AI-powered GitHub pull request reviewer")
  .version(version);

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("--provider <name>", "anthropic | openai | gemini")
    .option("-m, --model <id>", "model id (defaults to the provider's recommended model)")
    .option("--locale <lang>", "language for review output (e.g. Korean, English)")
    .option("--exclude <patterns>", "comma-separated globs or substrings to skip (added to defaults)")
    .option("--batch-chars <n>", "max diff characters per model request")
    .option("--config <path>", "config file path (default: .pr-sage.json if present)")
    .option("--min-severity <severity>", "drop findings below this severity")
    .option("--fail-on <severity>", "exit 1 if any finding is at or above this severity")
    .option("--context <mode>", "patch | full — send full file contents for better accuracy")
    .option("--verify", "second model pass that rejects unconfirmed findings (doubles cost)")
    .option("--paths <globs>", "only review files matching these comma-separated globs")
    .option("--max-tokens <n>", "stop launching new batches once this many tokens are spent")
    .option("--output <format>", "text | json | sarif");
}

interface CommonSettings {
  config: PrSageConfig;
  providerName: ProviderName;
  provider: Provider;
  locale: string;
  exclude: string[];
  paths: string[];
  batchCharBudget: number;
  minSeverity?: Severity;
  failOn?: Severity;
  context: "patch" | "full";
  verify: boolean;
  maxTokens?: number;
  output: OutputFormat;
}

async function resolveCommon(opts: Record<string, unknown>): Promise<CommonSettings> {
  const config = await loadConfig(opts.config as string | undefined);

  const providerName = ((opts.provider as string) ?? config.provider ?? "anthropic") as ProviderName;
  if (!["anthropic", "openai", "gemini"].includes(providerName)) {
    fail(`Unknown provider "${providerName}". Use anthropic, openai, or gemini.`);
  }
  const context = ((opts.context as string) ?? config.context ?? "patch") as "patch" | "full";
  if (!["patch", "full"].includes(context)) {
    fail(`Invalid --context "${context}". Use patch or full.`);
  }
  const output = ((opts.output as string) ?? config.output ?? "text") as OutputFormat;
  if (!["text", "json", "sarif"].includes(output)) {
    fail(`Invalid --output "${output}". Use text, json, or sarif.`);
  }

  return {
    config,
    providerName,
    provider: createProvider(providerName, (opts.model as string) ?? config.model),
    locale: (opts.locale as string) ?? config.locale ?? "English",
    exclude: [
      ...DEFAULT_EXCLUDES,
      ...(config.exclude ?? []),
      ...(opts.exclude ? String(opts.exclude).split(",").map((s) => s.trim()) : []),
    ],
    paths: opts.paths
      ? String(opts.paths).split(",").map((s) => s.trim()).filter(Boolean)
      : (config.paths ?? []),
    batchCharBudget: Number(opts.batchChars ?? config.batchChars ?? 80_000),
    minSeverity: parseSeverity((opts.minSeverity as string) ?? config.minSeverity, "--min-severity"),
    failOn: parseSeverity((opts.failOn as string) ?? config.failOn, "--fail-on"),
    context,
    verify: (opts.verify as boolean | undefined) ?? config.verify ?? false,
    maxTokens: opts.maxTokens
      ? Number(opts.maxTokens)
      : config.maxTokensPerRun,
    output,
  };
}

function reportUsage(provider: Provider): void {
  const usage = provider.usage;
  if (usage && usage.calls > 0) {
    console.error(
      `LLM usage: ${usage.calls} call(s), ${usage.inputTokens} input / ${usage.outputTokens} output tokens`,
    );
  }
}

function printResult(result: ReviewResult, provider: Provider, output: OutputFormat): void {
  if (output === "json") {
    console.log(toJson(result, provider));
    return;
  }
  if (output === "sarif") {
    console.log(toSarif(result, provider));
    return;
  }
  console.log(result.summary);
  console.log();
  for (const f of result.findings) {
    console.log(`--- ${f.path}:${f.line}${f.endLine ? `-${f.endLine}` : ""}`);
    console.log(formatComment(f));
    console.log();
  }
}

addSharedOptions(
  program
    .command("review")
    .description("Review a pull request and post inline comments plus a summary")
    .requiredOption("-p, --pr <number>", "pull request number")
    .option("-r, --repo <owner/name>", "repository (defaults to $GITHUB_REPOSITORY)")
    .option("--event <mode>", "comment | auto — auto approves or requests changes based on findings")
    .option("--no-dedupe", "repost findings already commented by a previous pr-sage review")
    .option("--no-incremental", "always review the full PR diff, not just new commits")
    .option("--force", "review even draft/WIP/skip-labeled PRs")
    .option("--dry-run", "print the review to stdout instead of posting to GitHub"),
).action(async (opts) => {
  const prNumber = Number(opts.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    fail(`Invalid PR number: ${opts.pr}`);
  }

  try {
    const settings = await resolveCommon(opts);
    const { config, provider } = settings;

    const eventMode = (opts.event as string) ?? config.event ?? "comment";
    if (!["comment", "auto"].includes(eventMode)) {
      fail(`Invalid --event "${eventMode}". Use comment or auto.`);
    }
    const dedupe = opts.dedupe === false ? false : (config.dedupe ?? true);
    const incremental = opts.incremental === false ? false : (config.incremental ?? true);

    const token = process.env.GITHUB_TOKEN;
    if (!token) fail("GITHUB_TOKEN is not set.");

    const { owner, repo } = resolveRepo(opts.repo);
    const github = new GitHubClient(token!, owner, repo, config.githubApiUrl);

    console.error(`Fetching ${owner}/${repo}#${prNumber}...`);
    let pr = await github.fetchPullRequest(prNumber);

    if (!opts.force) {
      const reason = skipReason(pr, config);
      if (reason) {
        console.error(`Skipping review: ${reason}. (use --force to review anyway)`);
        finish(false, undefined);
      }
    }
    if (settings.paths.length > 0) {
      pr = { ...pr, files: includeFiles(pr.files, settings.paths) };
    }
    const locale = resolveLocale(settings.locale, pr.title, pr.body);

    const history = dedupe ? await github.fetchPrSageHistory(prNumber) : null;
    if (!opts.dryRun && history?.lastReviewedSha === pr.headSha) {
      console.error(`Head commit ${pr.headSha.slice(0, 7)} was already reviewed; nothing to do.`);
      finish(false, undefined);
    }

    // Incremental review: only look at commits pushed since the last review,
    // but keep anchoring (and validation) against the full PR diff.
    let reviewFiles = pr.files;
    let changedSinceLastReview: Map<string, Set<number>> | null = null;
    if (!opts.dryRun && incremental && history?.lastReviewedSha) {
      try {
        const changed = await github.compareFiles(history.lastReviewedSha, pr.headSha);
        changedSinceLastReview = new Map(changed.map((f) => [f.path, f.commentableLines]));
        const prPaths = new Set(pr.files.map((f) => f.path));
        reviewFiles = includeFiles(changed, settings.paths).filter((f) => prPaths.has(f.path));
        console.error(
          `Incremental: ${reviewFiles.length} file(s) changed since ${history.lastReviewedSha.slice(0, 7)}.`,
        );
        if (reviewFiles.length === 0) {
          console.error("No changes since the last pr-sage review; nothing posted.");
          finish(false, undefined);
        }
      } catch {
        console.error("Could not compute incremental diff (force push?); reviewing the full PR.");
        reviewFiles = pr.files;
      }
    }

    const instructions = await buildInstructions(config, () =>
      github.fetchRepoGuidelines(pr.headSha),
    );

    const target: ReviewTarget = {
      title: pr.title,
      body: pr.body,
      files: reviewFiles,
      headSha: pr.headSha,
    };
    const { result } = await runReview(provider, target, {
      locale,
      exclude: settings.exclude,
      batchCharBudget: settings.batchCharBudget,
      log: (msg) => console.error(msg),
      instructions,
      minSeverity: settings.minSeverity,
      verify: settings.verify,
      maxTokens: settings.maxTokens,
      anchorFiles: pr.files,
      fetchContent:
        settings.context === "full"
          ? (path) => github.fetchFileContent(path, pr.headSha)
          : undefined,
    });

    reportUsage(provider);
    const gateTripped =
      settings.failOn !== undefined &&
      result.findings.some((f) => severityAtLeast(f.severity, settings.failOn!));

    if (opts.dryRun) {
      printResult(result, provider, settings.output);
      finish(gateTripped, settings.failOn);
    }

    let findingsToPost = result.findings;
    if (history) {
      findingsToPost = result.findings.filter((f) => {
        // Same issue reposted at a shifted line — fingerprint catches it.
        if (history.fingerprints.has(`${f.path}|${findingFingerprint(f)}`)) return false;
        const side = (f.side ?? "added") === "removed" ? "LEFT" : "RIGHT";
        if (history.commentedLocations.has(`${f.path}:${side}:${f.line}`)) {
          // Same location, but if that line changed since the last review
          // this is a finding about new code — post it.
          return changedSinceLastReview?.get(f.path)?.has(f.line) ?? false;
        }
        return true;
      });
      const skipped = result.findings.length - findingsToPost.length;
      if (skipped > 0) {
        console.error(`Skipping ${skipped} finding(s) already posted by a previous review.`);
      }
      if (findingsToPost.length === 0 && history.hasReview && result.findings.length > 0) {
        console.error("No new findings since the last pr-sage review; nothing posted.");
        finish(gateTripped, settings.failOn);
      }
    }

    const event = resolveEvent(eventMode, result.findings);
    const posted = await github.postReview(prNumber, result.summary, findingsToPost, event);
    if (posted.event !== event) {
      console.error(`GitHub rejected event ${event} (own PR?); posted as COMMENT instead.`);
    }
    console.error(`Review posted (${posted.event}): ${posted.url}`);
    if (settings.output !== "text") printResult(result, provider, settings.output);
    finish(gateTripped, settings.failOn);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

addSharedOptions(
  program
    .command("local")
    .description("Review local git changes (no PR, no posting) — e.g. before pushing")
    .option("-b, --base <ref>", "base ref to diff against", "main")
    .option("--staged", "review staged changes instead of the diff against --base"),
).action(async (opts) => {
  try {
    const settings = await resolveCommon(opts);
    const { provider } = settings;

    let files = await localDiffFiles(opts.base, Boolean(opts.staged));
    if (settings.paths.length > 0) files = includeFiles(files, settings.paths);
    if (files.length === 0) {
      console.error("No local changes to review.");
      finish(false, undefined);
    }

    // For locale "auto" the best local sample is the latest commit message.
    const lastCommitMsg = await promisify(execFile)("git", ["log", "-1", "--format=%B"])
      .then((r) => r.stdout)
      .catch(() => "");
    const locale = resolveLocale(settings.locale, lastCommitMsg);

    const instructions = await buildInstructions(settings.config, async () => {
      const parts: string[] = [];
      for (const path of ["CLAUDE.md", "CONTRIBUTING.md"]) {
        const content = await readFile(path, "utf8").catch(() => null);
        if (content) parts.push(`--- ${path} ---\n${content.slice(0, 6000)}`);
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    });

    const target: ReviewTarget = {
      title: opts.staged ? "Staged local changes" : `Local changes vs ${opts.base}`,
      body: "",
      files,
      headSha: "",
    };
    const { result } = await runReview(provider, target, {
      locale,
      exclude: settings.exclude,
      batchCharBudget: settings.batchCharBudget,
      log: (msg) => console.error(msg),
      instructions,
      minSeverity: settings.minSeverity,
      verify: settings.verify,
      maxTokens: settings.maxTokens,
      fetchContent:
        settings.context === "full"
          ? (path) => readFile(path, "utf8").catch(() => null)
          : undefined,
    });

    reportUsage(provider);
    printResult(result, provider, settings.output);
    const gateTripped =
      settings.failOn !== undefined &&
      result.findings.some((f) => severityAtLeast(f.severity, settings.failOn!));
    finish(gateTripped, settings.failOn);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

program
  .command("init")
  .description("Set up pr-sage in 30 seconds: config file + GitHub Action workflow")
  .option("--provider <name>", "anthropic | openai | gemini | self-hosted")
  .option("--locale <lang>", "auto | Korean | English | ...")
  .option("--fail-on-critical", "block merges when a critical finding appears")
  .option("-y, --yes", "accept defaults without prompting")
  .action(async (opts) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ask = async (question: string, fallback: string): Promise<string> => {
      if (opts.yes) return fallback;
      const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
      return answer || fallback;
    };

    try {
      const providerRaw = (opts.provider as string | undefined)
        ?? (await ask("Provider? (anthropic / openai / gemini / self-hosted)", "anthropic"));
      const selfHosted = providerRaw === "self-hosted";
      const provider = (selfHosted ? "openai" : providerRaw) as ProviderName;
      if (!["anthropic", "openai", "gemini"].includes(provider)) {
        fail(`Unknown provider "${providerRaw}".`);
      }

      const locale = (opts.locale as string | undefined)
        ?? (await ask("Review language? (auto detects from each PR)", "auto"));
      const failOnCritical = Boolean(opts.failOnCritical)
        || (await ask("Block merges on critical findings? (y/n)", "n")).toLowerCase().startsWith("y");

      const answers: InitAnswers = { provider, selfHosted, locale, failOnCritical };

      if (existsSync(CONFIG_FILENAME)) {
        console.error(`✓ ${CONFIG_FILENAME} already exists — leaving it untouched.`);
      } else {
        await writeFile(CONFIG_FILENAME, buildConfig(answers));
        console.error(`✓ Wrote ${CONFIG_FILENAME}`);
      }

      const inGitRepo = existsSync(".git");
      const workflowPath = ".github/workflows/pr-sage.yml";
      if (inGitRepo && !existsSync(workflowPath)) {
        const wantWorkflow = (await ask("Create the GitHub Action workflow? (y/n)", "y"))
          .toLowerCase()
          .startsWith("y");
        if (wantWorkflow) {
          await mkdir(".github/workflows", { recursive: true });
          await writeFile(workflowPath, buildWorkflow(answers));
          console.error(`✓ Wrote ${workflowPath}`);
        }
      } else if (existsSync(workflowPath)) {
        console.error(`✓ ${workflowPath} already exists — leaving it untouched.`);
      }

      const keyEnv = PROVIDER_KEY_ENV[provider];
      if (selfHosted) {
        console.error(
          process.env.OPENAI_BASE_URL
            ? `✓ OPENAI_BASE_URL is set (${process.env.OPENAI_BASE_URL})`
            : "✗ OPENAI_BASE_URL is not set in this shell",
        );
      } else {
        console.error(
          process.env[keyEnv]
            ? `✓ ${keyEnv} is set in this shell`
            : `✗ ${keyEnv} is not set in this shell — the CLI needs it locally`,
        );
      }

      console.error(`\n${secretInstructions(answers, process.env.GITHUB_REPOSITORY)}`);
      console.error(
        "\nDone. Try it without posting anything:\n  npx pr-sage review --repo owner/name --pr <number> --dry-run",
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      rl.close();
    }
  });

async function buildInstructions(
  config: PrSageConfig,
  fetchGuidelines: () => Promise<string | null>,
): Promise<string | undefined> {
  const parts: string[] = [];
  if (config.instructions) parts.push(config.instructions);
  if (config.repoContext !== false) {
    const guidelines = await fetchGuidelines().catch(() => null);
    if (guidelines) parts.push(`Repository guideline documents:\n\n${guidelines}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function resolveEvent(mode: string, findings: Finding[]): ReviewEvent {
  if (mode !== "auto") return "COMMENT";
  if (findings.some((f) => f.severity === "critical")) return "REQUEST_CHANGES";
  return findings.length === 0 ? "APPROVE" : "COMMENT";
}

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
