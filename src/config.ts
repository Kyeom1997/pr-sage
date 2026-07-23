import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SEVERITIES } from "./types.js";

const configSchema = z.strictObject({
  provider: z.enum(["anthropic", "openai", "gemini"]).optional(),
  model: z.string().optional(),
  locale: z.string().optional(),
  /** Path globs (picomatch) or plain substrings, added to the default excludes. */
  exclude: z.array(z.string()).optional(),
  /** Project-specific review guidelines injected into the system prompt. */
  instructions: z.string().optional(),
  /** Drop findings below this severity. */
  minSeverity: z.enum(SEVERITIES).optional(),
  /** Exit 1 if any finding is at or above this severity (CI gate). */
  failOn: z.enum(SEVERITIES).optional(),
  batchChars: z.number().int().positive().optional(),
  /** "patch" (default) or "full" — include full file contents for accuracy. */
  context: z.enum(["patch", "full"]).optional(),
  /** Skip findings already posted by a previous pr-sage review (default true). */
  dedupe: z.boolean().optional(),
  /** Review only commits pushed since the last pr-sage review (default true). */
  incremental: z.boolean().optional(),
  /** "comment" (default) or "auto" — approve / request changes based on findings. */
  event: z.enum(["comment", "auto"]).optional(),
  /** Second model pass that rejects unconfirmed findings (doubles cost). */
  verify: z.boolean().optional(),
  /** Behavior when the verification provider fails (default: abort). */
  verifyFailure: z.enum(["abort", "keep", "drop"]).optional(),
  /** "text" (default), "json", or "sarif" stdout format. */
  output: z.enum(["text", "json", "sarif"]).optional(),
  /** Inject repo guideline docs (CLAUDE.md, CONTRIBUTING.md) into the prompt (default true). */
  repoContext: z.boolean().optional(),
  /** GitHub API base URL for GitHub Enterprise (default: $GITHUB_API_URL or api.github.com). */
  githubApiUrl: z.string().optional(),
  /** Only review files matching these globs (monorepo scoping). */
  paths: z.array(z.string()).optional(),
  /** Skip PRs carrying any of these labels (default: ["skip-review", "no-review"]). */
  skipLabels: z.array(z.string()).optional(),
  /** Skip draft PRs (default true). */
  skipDraft: z.boolean().optional(),
  /** Skip PRs whose title starts with WIP (default true). */
  skipWip: z.boolean().optional(),
  /** Abort the run once this many total LLM tokens have been spent (cost guard). */
  maxTokensPerRun: z.number().int().positive().optional(),
  /** Fail CI when any part of the configured change could not be reviewed. */
  failOnIncomplete: z.boolean().optional(),
  /** Post a GitHub Check Run in addition to the PR review. */
  checkRun: z.boolean().optional(),
  /** Use a separate provider/model for the false-positive verification pass. */
  verifyProvider: z.enum(["anthropic", "openai", "gemini"]).optional(),
  verifyModel: z.string().optional(),
  /** Optional path-specific review instructions and severity policies. */
  pathRules: z.array(z.strictObject({
    paths: z.array(z.string()).min(1),
    instructions: z.string().optional(),
    minSeverity: z.enum(SEVERITIES).optional(),
    failOn: z.enum(SEVERITIES).optional(),
  })).optional(),
});

export type PrSageConfig = z.infer<typeof configSchema>;

/** Returns a human-readable reason when the PR shouldn't be reviewed, else null. */
export function skipReason(
  pr: { draft: boolean; title: string; labels: string[] },
  config: PrSageConfig,
): string | null {
  if ((config.skipDraft ?? true) && pr.draft) return "PR is a draft";
  if ((config.skipWip ?? true) && /^\s*(\[wip\]|wip\b[:\s-]?)/i.test(pr.title)) {
    return "PR title is marked WIP";
  }
  const skipLabels = config.skipLabels ?? ["skip-review", "no-review"];
  const hit = pr.labels.find((label) => skipLabels.includes(label));
  if (hit) return `PR carries the "${hit}" label`;
  return null;
}

export const CONFIG_FILENAME = ".pr-sage.json";

export async function loadConfig(explicitPath?: string): Promise<PrSageConfig> {
  const file = resolve(explicitPath ?? CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (!explicitPath && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read config file ${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file ${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config ${file}: ${detail}`);
  }
  return parsed.data;
}
