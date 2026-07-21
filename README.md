# pr-sage

**An AI PR reviewer built to eliminate review noise — not add to it.**

Most AI reviewers re-review the whole PR on every push and repeat themselves until the team mutes them. pr-sage is designed around the opposite goal: say each thing once, follow your team's rules, and stay silent when there is nothing new to say.

- 🔇 **Zero duplicate comments.** Findings carry content fingerprints — a line shift won't make the same comment appear twice, and re-runs post nothing when nothing changed.
- ⏩ **Incremental by default.** After the first review, only the commits you pushed since get reviewed. Less noise, fewer tokens.
- 📏 **Your rules, not generic advice.** `.pr-sage.json` instructions plus automatic `CLAUDE.md`/`CONTRIBUTING.md` injection make reviews follow team conventions.
- 🚦 **A quality gate, not just commentary.** `--fail-on critical` blocks merges; `--event auto` approves clean PRs and requests changes on real problems.
- 🖥️ **Reviews before the PR exists.** `pr-sage local` reviews your `git diff` pre-push — no server, no PR, no GitHub token.
- 🔐 **Your keys, your data path.** No server, nothing stored; code goes only to the provider you choose — **Claude, OpenAI, or Gemini** ([SECURITY.md](SECURITY.md)).

Ships as a **CLI**, a **GitHub Action**, and a **TypeScript library**.

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

Review your local changes before pushing (no PR, no GitHub token needed):

```bash
npx pr-sage local --base main            # diff vs main
npx pr-sage local --staged --fail-on critical   # gate staged changes
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
| `--exclude <patterns>` | — | Comma-separated globs or substrings to skip (added to defaults: lockfiles, `dist/`, `build/`, …) |
| `--min-severity <sev>` | — | Drop findings below this severity (e.g. `suggestion` hides nitpicks) |
| `--fail-on <sev>` | — | Exit 1 if any finding is at or above this severity — use as a CI quality gate |
| `--context <mode>` | `patch` | `full` sends complete file contents to the model for better accuracy (more tokens) |
| `--event <mode>` | `comment` | `auto` approves clean PRs and requests changes on critical findings (falls back to comment on your own PRs) |
| `--verify` | off | Second model pass that rejects unconfirmed findings — fewer false positives, double cost |
| `--output <format>` | `text` | `json` or `sarif` for machine-readable results |
| `--no-dedupe` | — | Repost findings already commented by a previous pr-sage review (dedup is on by default) |
| `--no-incremental` | — | Always review the full PR diff instead of only commits since the last pr-sage review |
| `--batch-chars <n>` | `80000` | Max diff characters per model request; larger PRs are reviewed in batches |
| `--config <path>` | `.pr-sage.json` | Config file path |
| `--dry-run` | — | Print the review to stdout instead of posting |

Required environment variables: `GITHUB_TOKEN` (with `pull_requests: write`), plus the API key for your provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`).

On repeat runs (e.g. new commits pushed to the PR), pr-sage reviews **only the commits pushed since its last review** (incremental mode), skips findings it has already commented, and posts nothing when there is nothing new — no duplicate-comment spam, no wasted tokens. If your repo has a `CLAUDE.md` or `CONTRIBUTING.md`, it is automatically injected as review context (disable with `"repoContext": false`). GitHub Enterprise works out of the box via `$GITHUB_API_URL` or the `githubApiUrl` config field.

## Configuration file

Put a `.pr-sage.json` in the directory you run from (CLI flags override it):

```json
{
  "provider": "anthropic",
  "locale": "Korean",
  "exclude": ["src/generated/**", "**/*.snap"],
  "minSeverity": "suggestion",
  "failOn": "critical",
  "context": "full",
  "instructions": "We use Result<T, E> for error handling — flag thrown exceptions in domain code. Prefer early returns over nested conditionals."
}
```

`instructions` is injected into the review prompt — use it for team conventions the reviewer should enforce.

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
      - uses: Kyeom1997/pr-sage@v1
        with:
          provider: anthropic
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          locale: Korean
          fail-on: critical   # optional: block merge on critical findings
```

## Measuring it

`scripts/bench.mjs` runs pr-sage (dry, nothing posted) over recent merged PRs of any public repo and records findings, severity mix, latency, and token usage, plus a labeling sheet for computing the valid-review rate:

```bash
node scripts/bench.mjs --repos fastify/fastify --per-repo 5 --provider gemini
```

## How it works

1. Fetches the PR metadata and per-file patches from the GitHub API.
2. Annotates each diff line with its new-file line number and filters out lockfiles/build artifacts.
3. Asks the LLM for a structured review (JSON schema — no parsing heuristics): summary + findings with `path`, `line`, `severity`, and an optional single-line suggestion.
4. Validates every finding at runtime (zod) and against the diff (GitHub rejects reviews that comment on lines outside the diff), demotes unsafe multi-line suggestions, skips findings already posted by a previous run, retries on provider rate limits, and posts one review: inline comments + summary.

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

## Security & privacy

Reviewing code means sending diffs (and optionally full files) to the LLM provider you choose — read [SECURITY.md](SECURITY.md) for the exact data flow, provider policy links, prompt-injection mitigations, and token scope guidance before enabling this on private repositories. The GitHub Action executes the bundled code committed at the tag you pin (no install step), and npm releases carry provenance.

## License

MIT
