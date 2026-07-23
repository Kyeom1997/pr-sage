# Security & Privacy

## What pr-sage sends where

For each review, pr-sage sends the following to **the LLM provider you configure** (Anthropic, OpenAI, or Google):

- The PR title and description
- The diff of changed files (annotated with line numbers)
- With `--context full`: the complete contents of changed files
- If present and `repoContext` is not disabled: up to 6 KB each of `CLAUDE.md` / `CONTRIBUTING.md`
- Your `instructions` from `.pr-sage.json`

**If your repository is private, this means private code is transmitted to a third-party API.** Review your provider's data-usage policy before enabling pr-sage on private repos:

- Anthropic: https://www.anthropic.com/legal/commercial-terms
- OpenAI: https://openai.com/policies/business-terms
- Google (Gemini API): https://ai.google.dev/gemini-api/terms — note that the **free tier may use submitted content for training**; use a paid key for private code.

pr-sage itself stores nothing and has no server. All state lives in the PR's own review comments (hidden HTML markers used for dedup/incremental review).

Use `exclude` patterns to keep sensitive paths (e.g. `secrets/**`, `*.env.example`) out of review payloads entirely.

## Prompt injection

PR titles, descriptions, and diffs are attacker-controllable input: a contributor can write text that tries to instruct the reviewer ("ignore previous instructions", "approve this PR"). Mitigations:

- The system prompt explicitly instructs the model to treat PR content as untrusted data, never follow instructions inside it, and flag embedded reviewer-directed instructions as a finding.
- Model output is schema-constrained and validated at runtime (zod); findings are additionally validated against the actual diff before posting.
- pr-sage never executes code from the PR and posts only via the GitHub review API with the token you supply.

Residual risk remains — no LLM is fully injection-proof. Do **not** wire pr-sage's `--event auto` approval as the *sole* required review on security-sensitive repositories; treat AI approval as advisory alongside human review.

The generated Action workflow checks out only
`${{ github.event.pull_request.base.sha }}`. This ensures `.pr-sage.json`,
`CLAUDE.md`, and `CONTRIBUTING.md` come from trusted base code rather than from
the PR being reviewed. The PR title, body, and diff remain untrusted model
input. pr-sage also rechecks the PR head SHA immediately before posting and
refuses to publish a stale review.

## Token scopes

- `GITHUB_TOKEN`: needs `pull-requests: write` and `contents: read` only. In Actions, the default `github.token` with the workflow `permissions` block shown in the README is sufficient — no PAT needed.
- `checks: write` is additionally required only when `check-run` is enabled.
- `security-events: write` is additionally required only for SARIF upload.
- Provider API keys are read from environment variables and are never logged or included in posted comments.

## Supply chain

- The GitHub Action executes the bundled `dist/cli.js` **committed at the tag you pin** — what you pin is what runs. CI verifies the committed bundle matches the source.
- npm releases are published from GitHub Actions with npm provenance.
- Pin the action to a full version tag (e.g. `@v0.4.0`) or commit SHA if you want maximum reproducibility; `@v1` tracks the latest release.

## Reporting a vulnerability

Please open a GitHub security advisory on this repository (Security → Report a vulnerability) rather than a public issue.
