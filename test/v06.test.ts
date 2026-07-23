import { describe, expect, it } from "vitest";
import { skipReason } from "../src/config.js";
import { resolveLocale } from "../src/locale.js";
import { includeFiles, runReview } from "../src/review.js";
import { buildConfig, buildWorkflow, secretInstructions } from "../src/init.js";
import { commentableLines } from "../src/diff.js";
import type { DiffFile, Provider, ProviderUsage } from "../src/types.js";

const pr = (overrides = {}) => ({ draft: false, title: "feat: x", labels: [], ...overrides });

describe("skipReason", () => {
  it("skips drafts, WIP titles, and skip labels by default", () => {
    expect(skipReason(pr({ draft: true }), {})).toMatch(/draft/);
    expect(skipReason(pr({ title: "[WIP] thing" }), {})).toMatch(/WIP/);
    expect(skipReason(pr({ title: "wip: thing" }), {})).toMatch(/WIP/);
    expect(skipReason(pr({ labels: ["skip-review"] }), {})).toMatch(/skip-review/);
    expect(skipReason(pr(), {})).toBeNull();
  });

  it("respects config overrides", () => {
    expect(skipReason(pr({ draft: true }), { skipDraft: false })).toBeNull();
    expect(skipReason(pr({ labels: ["hold"] }), { skipLabels: ["hold"] })).toMatch(/hold/);
    expect(skipReason(pr({ title: "wip: x" }), { skipWip: false })).toBeNull();
  });

  it("does not misfire on titles containing wip inside words", () => {
    expect(skipReason(pr({ title: "fix: wipe cache correctly" }), {})).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("passes through explicit locales and detects scripts for auto", () => {
    expect(resolveLocale("Korean", "hello")).toBe("Korean");
    expect(resolveLocale("auto", "버그 수정합니다")).toBe("Korean");
    expect(resolveLocale("auto", "バグを修正")).toBe("Japanese");
    expect(resolveLocale("auto", "fix bug")).toBe("English");
    expect(resolveLocale("auto", undefined, "")).toBe("English");
  });
});

function makeFile(path: string): DiffFile {
  const patch = "@@ -1,1 +1,1 @@\n+x\n";
  return { path, status: "modified", patch, commentableLines: commentableLines(patch) };
}

describe("includeFiles", () => {
  const files = [makeFile("packages/web/a.ts"), makeFile("packages/api/b.ts"), makeFile("docs/c.md")];

  it("keeps only matching globs and is a no-op when empty", () => {
    expect(includeFiles(files, ["packages/web/**"]).map((f) => f.path)).toEqual([
      "packages/web/a.ts",
    ]);
    expect(includeFiles(files, [])).toHaveLength(3);
  });
});

describe("token budget guard", () => {
  it("stops launching batches once the budget is spent and notes it in the summary", async () => {
    const usage: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
    const provider: Provider = {
      name: "gemini",
      model: "fake",
      usage,
      async generate() {
        usage.calls++;
        usage.inputTokens += 5000;
        return { summary: "batch ok", findings: [] };
      },
    };
    const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
    const { result } = await runReview(
      provider,
      { title: "T", body: "", files, headSha: "" },
      {
        locale: "English",
        exclude: [],
        batchCharBudget: 1, // one file per batch
        maxTokens: 4000, // exhausted after the first batch
        log: () => {},
      },
    );
    expect(usage.calls).toBe(1);
    expect(result.summary).toContain("budget");
    expect(result.coverage).toMatchObject({
      complete: false,
      reviewedFiles: 1,
      skippedFiles: 2,
      reasons: ["token-budget"],
    });
  });
});

describe("init generators", () => {
  const answers = { provider: "gemini" as const, selfHosted: false, locale: "auto", failOnCritical: true };

  it("builds a valid config file", () => {
    const config = JSON.parse(buildConfig(answers));
    expect(config).toEqual({ provider: "gemini", locale: "auto", failOn: "critical" });
  });

  it("builds a workflow wired to the chosen provider secret", () => {
    const yml = buildWorkflow(answers);
    expect(yml).toContain("provider: gemini");
    expect(yml).toContain("gemini-api-key: ${{ secrets.GEMINI_API_KEY }}");
    expect(yml).toContain("fail-on: critical");
    expect(yml).toContain("pull-requests: write");
    expect(yml).toContain("github.event.pull_request.base.sha");
    expect(yml).toContain("cancel-in-progress: true");
  });

  it("gives self-hosted users base-url instructions instead of secrets", () => {
    const text = secretInstructions({ ...answers, provider: "openai", selfHosted: true });
    expect(text).toContain("OPENAI_BASE_URL");
    expect(text).not.toContain("gh secret set");
  });

  it("wires self-hosted mode to a self-hosted runner and endpoint", () => {
    const yml = buildWorkflow({
      ...answers,
      provider: "openai",
      selfHosted: true,
      baseUrl: "http://ollama.internal:11434/v1",
    });
    expect(yml).toContain("runs-on: self-hosted");
    expect(yml).toContain("openai-base-url: http://ollama.internal:11434/v1");
    expect(yml).not.toContain("secrets.OPENAI_API_KEY");
  });
});
