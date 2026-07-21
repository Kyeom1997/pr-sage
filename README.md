# pr-sage

AI-powered GitHub pull request reviewer. Fetches a PR's diff, reviews it with an LLM, and posts **inline comments** on the exact changed lines plus a **summary review** — as a CLI or a GitHub Action.

Supports **Claude (Anthropic)**, **OpenAI**, and **Gemini**.

## Quick start (CLI)

```bash
export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-ant-...

npx pr-sage review --repo owner/name --pr 123
```

Preview without posting anything:

```bash
npx pr-sage review --repo owner/name --pr 123 --dry-run
```

Review in Korean with a different provider:

```bash
export OPENAI_API_KEY=sk-...
npx pr-sage review --repo owner/name --pr 123 --provider openai --locale Korean
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-p, --pr <number>` | (required) | Pull request number |
| `-r, --repo <owner/name>` | `$GITHUB_REPOSITORY` | Target repository |
| `--provider <name>` | `anthropic` | `anthropic` \| `openai` \| `gemini` |
| `-m, --model <id>` | provider default | Model id (`claude-opus-4-8`, `gpt-5`, `gemini-flash-latest`) |
| `--locale <lang>` | `English` | Language for the review output |
| `--exclude <patterns>` | — | Comma-separated path substrings to skip (added to defaults: lockfiles, `dist/`, `build/`, …) |
| `--batch-chars <n>` | `80000` | Max diff characters per model request; larger PRs are reviewed in batches |
| `--dry-run` | — | Print the review to stdout instead of posting |

Required environment variables: `GITHUB_TOKEN` (with `pull_requests: write`), plus the API key for your provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`).

## GitHub Action

```yaml
# .github/workflows/pr-sage.yml
name: AI Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: Kyeom1997/pr-sage@v1
        with:
          provider: anthropic
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          locale: Korean
```

## How it works

1. Fetches the PR metadata and per-file patches from the GitHub API.
2. Annotates each diff line with its new-file line number and filters out lockfiles/build artifacts.
3. Asks the LLM for a structured review (JSON schema — no parsing heuristics): summary + findings with `path`, `line`, `severity`, and an optional single-line suggestion.
4. Validates every finding against the diff (GitHub rejects reviews that comment on lines outside the diff) and posts one review: inline comments + summary.

Severities: 🔴 critical · 🟡 warning · 🔵 suggestion · ⚪ nitpick. Safe single-line fixes are posted as GitHub suggestion blocks you can commit with one click.

## Programmatic use

```ts
import { GitHubClient, createProvider, runReview } from "pr-sage";

const github = new GitHubClient(process.env.GITHUB_TOKEN!, "owner", "repo");
const pr = await github.fetchPullRequest(123);
const provider = createProvider("anthropic");
const { result } = await runReview(provider, pr, {
  locale: "English",
  exclude: [],
  batchCharBudget: 80_000,
  log: console.error,
});
```

## License

MIT
