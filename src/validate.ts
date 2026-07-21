import { z } from "zod";
import { SEVERITIES, type Finding, type ReviewResult } from "./types.js";

const findingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
});

const resultSchema = z.object({
  summary: z.string(),
  findings: z.array(z.unknown()),
});

/**
 * Validate raw model output at runtime. A malformed overall shape throws;
 * individually malformed findings are dropped so one bad item doesn't
 * discard the whole batch.
 */
export function parseReviewResult(raw: unknown, log: (message: string) => void): ReviewResult {
  const base = resultSchema.safeParse(raw);
  if (!base.success) {
    throw new Error(
      `Model returned malformed review output: ${base.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  const findings: Finding[] = [];
  let malformed = 0;
  for (const item of base.data.findings) {
    const parsed = findingSchema.safeParse(item);
    if (parsed.success) findings.push(parsed.data);
    else malformed++;
  }
  if (malformed > 0) log(`Dropped ${malformed} malformed finding(s) from model output.`);
  return { summary: base.data.summary, findings };
}
