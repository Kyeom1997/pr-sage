import type { Finding, ReviewEvent } from "./types.js";

/** Resolve the GitHub review event without ever approving incomplete coverage. */
export function resolveEvent(
  mode: string,
  findings: Finding[],
  complete = true,
): ReviewEvent {
  if (mode !== "auto" || !complete) return "COMMENT";
  if (findings.some((finding) => finding.severity === "critical")) {
    return "REQUEST_CHANGES";
  }
  return findings.length === 0 ? "APPROVE" : "COMMENT";
}
