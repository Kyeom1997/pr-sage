import type { ProviderName } from "./types.js";

export interface InitAnswers {
  provider: ProviderName;
  /** True when the user picked a self-hosted OpenAI-compatible endpoint. */
  selfHosted: boolean;
  locale: string;
  failOnCritical: boolean;
}

export const PROVIDER_KEY_ENV: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const ACTION_KEY_INPUT: Record<ProviderName, string> = {
  anthropic: "anthropic-api-key",
  openai: "openai-api-key",
  gemini: "gemini-api-key",
};

export function buildConfig(answers: InitAnswers): string {
  const config: Record<string, unknown> = {
    provider: answers.provider,
    locale: answers.locale,
  };
  if (answers.failOnCritical) config.failOn = "critical";
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function buildWorkflow(answers: InitAnswers): string {
  const keyEnv = PROVIDER_KEY_ENV[answers.provider];
  const keyInput = ACTION_KEY_INPUT[answers.provider];
  return `name: AI Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    # Secrets are unavailable on forked PRs; skip instead of failing.
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: Kyeom1997/pr-sage@v1
        with:
          provider: ${answers.provider}
          ${keyInput}: \${{ secrets.${keyEnv} }}
          locale: ${answers.locale}${answers.failOnCritical ? "\n          fail-on: critical" : ""}
`;
}

export function secretInstructions(answers: InitAnswers, repo?: string): string {
  const keyEnv = PROVIDER_KEY_ENV[answers.provider];
  const repoFlag = repo ? ` --repo ${repo}` : "";
  if (answers.selfHosted) {
    return [
      "Self-hosted endpoint: no API key secret needed.",
      "Set OPENAI_BASE_URL where pr-sage runs, e.g.:",
      "  OPENAI_BASE_URL=http://localhost:11434/v1",
    ].join("\n");
  }
  return [
    `Register your ${keyEnv} as a repository secret so the Action can use it:`,
    `  gh secret set ${keyEnv}${repoFlag}`,
    "(paste the key when prompted — never commit it)",
  ].join("\n");
}
