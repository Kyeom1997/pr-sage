import type { DiffFile, ReviewRequest } from "./types.js";
import { annotatePatch } from "./diff.js";

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Overall review summary in markdown: what the PR does, general quality, and the most important issues. A few short paragraphs at most.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path exactly as shown in the diff." },
          line: {
            type: "integer",
            description: "New-file line number the finding anchors to. Must be a numbered line from the annotated diff.",
          },
          severity: { type: "string", enum: ["critical", "warning", "suggestion", "nitpick"] },
          title: { type: "string", description: "One-line summary of the issue." },
          body: {
            type: "string",
            description: "Explanation of the issue and how to fix it, in markdown. Concrete, not generic.",
          },
          suggestion: {
            type: "string",
            description:
              "Optional replacement code for ONLY the anchored line, used in a GitHub suggestion block. Omit unless the fix is a safe single-line change.",
          },
        },
        required: ["path", "line", "severity", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
} as const;

export function systemPrompt(locale: string, instructions?: string): string {
  const custom = instructions?.trim()
    ? `\n\nProject-specific review guidelines (follow these in addition to the rules above):\n${instructions.trim()}`
    : "";
  return `You are an expert code reviewer for GitHub pull requests.

You are given a PR description and its diff. Each right-side diff line is prefixed with its new-file line number. Review the changes and report findings.

What to look for, in priority order:
1. critical — bugs, logic errors, crashes, data loss, security vulnerabilities, race conditions
2. warning — likely bugs, missing error handling at system boundaries, breaking API changes, performance problems on hot paths
3. suggestion — clearer or simpler implementation, missing test coverage for changed behavior
4. nitpick — minor style or naming issues (report sparingly)

Rules:
- Only comment on lines that carry a number in the annotated diff. Use that exact number as "line".
- Judge the change in context; do not flag pre-existing code unless the change makes it worse.
- No generic advice ("consider adding tests") without pointing at something specific.
- Do not praise line-by-line; positive notes belong in the summary only.
- If the diff looks fine, return an empty findings array and say so in the summary.
- Write the summary and all finding bodies in ${locale}.${custom}`;
}

const MAX_PATCH_CHARS = 30_000;
const MAX_CONTENT_CHARS = 40_000;

export function renderFiles(files: DiffFile[], contents?: Map<string, string>): string {
  return files
    .map((f) => {
      let patch = annotatePatch(f.patch);
      if (patch.length > MAX_PATCH_CHARS) {
        patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n... (patch truncated)`;
      }
      let block = `### ${f.path} (${f.status})\n\`\`\`diff\n${patch}\n\`\`\``;
      const content = contents?.get(f.path);
      if (content) {
        let body = content;
        if (body.length > MAX_CONTENT_CHARS) {
          body = `${body.slice(0, MAX_CONTENT_CHARS)}\n... (file truncated)`;
        }
        block += `\n\nFull new version of ${f.path} for context (findings must still anchor to numbered diff lines above):\n\`\`\`\n${body}\n\`\`\``;
      }
      return block;
    })
    .join("\n\n");
}

export function userPrompt(req: ReviewRequest): string {
  const body = req.prBody.trim() ? req.prBody.trim() : "(no description)";
  return `## Pull request: ${req.prTitle}\n\n${body}\n\n## Diff\n\n${req.filesText}`;
}
