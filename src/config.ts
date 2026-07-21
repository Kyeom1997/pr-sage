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
});

export type PrSageConfig = z.infer<typeof configSchema>;

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
