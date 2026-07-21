import type { Provider, ReviewResult, Severity } from "./types.js";

export type OutputFormat = "text" | "json" | "sarif";

export function toJson(result: ReviewResult, provider: Provider): string {
  return JSON.stringify(
    {
      provider: provider.name,
      model: provider.model,
      summary: result.summary,
      findings: result.findings,
    },
    null,
    2,
  );
}

const SARIF_LEVEL: Record<Severity, string> = {
  critical: "error",
  warning: "warning",
  suggestion: "note",
  nitpick: "note",
};

export function toSarif(result: ReviewResult, provider: Provider): string {
  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "pr-sage",
              informationUri: "https://github.com/Kyeom1997/pr-sage",
              properties: { provider: provider.name, model: provider.model },
              rules: (["critical", "warning", "suggestion", "nitpick"] as const).map((s) => ({
                id: `pr-sage/${s}`,
                shortDescription: { text: `pr-sage ${s} finding` },
              })),
            },
          },
          results: result.findings.map((f) => ({
            ruleId: `pr-sage/${f.severity}`,
            level: SARIF_LEVEL[f.severity],
            message: { text: `${f.title}\n\n${f.body}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.path },
                  region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}
