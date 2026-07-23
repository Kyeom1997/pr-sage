import { readFile } from "node:fs/promises";
import type { PrSageConfig } from "./config.js";
import type { ProviderName } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctorChecks(config: PrSageConfig): Promise<DoctorCheck[]> {
  const provider = config.provider ?? "anthropic";
  const checks: DoctorCheck[] = [
    { name: "config", ok: true, detail: "configuration is valid" },
    providerCheck(provider),
  ];

  const workflow = await readFile(".github/workflows/pr-sage.yml", "utf8").catch(() => null);
  checks.push({
    name: "workflow",
    ok: workflow !== null,
    detail: workflow ? ".github/workflows/pr-sage.yml found" : "workflow file not found",
  });
  if (workflow) {
    checks.push({
      name: "trusted config",
      ok: workflow.includes("github.event.pull_request.base.sha"),
      detail: workflow.includes("github.event.pull_request.base.sha")
        ? "workflow loads configuration from the trusted base commit"
        : "checkout the PR base SHA before running pr-sage",
    });
    checks.push({
      name: "permissions",
      ok: workflow.includes("pull-requests: write")
        && (!config.checkRun || workflow.includes("checks: write")),
      detail: !workflow.includes("pull-requests: write")
        ? "workflow needs pull-requests: write"
        : config.checkRun && !workflow.includes("checks: write")
          ? "checkRun requires checks: write"
          : "required write permissions are configured",
    });
    checks.push({
      name: "concurrency",
      ok: workflow.includes("cancel-in-progress: true"),
      detail: workflow.includes("cancel-in-progress: true")
        ? "stale runs are cancelled"
        : "add per-PR concurrency with cancel-in-progress",
    });
  }

  return checks;
}

function providerCheck(provider: ProviderName): DoctorCheck {
  if (provider === "openai" && process.env.OPENAI_BASE_URL) {
    try {
      const url = new URL(process.env.OPENAI_BASE_URL);
      return {
        name: "provider",
        ok: url.protocol === "http:" || url.protocol === "https:",
        detail: `self-hosted endpoint: ${url.origin}`,
      };
    } catch {
      return { name: "provider", ok: false, detail: "OPENAI_BASE_URL is not a valid URL" };
    }
  }
  const env = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
  }[provider];
  return {
    name: "provider",
    ok: Boolean(process.env[env]),
    detail: process.env[env] ? `${env} is set` : `${env} is not set`,
  };
}
