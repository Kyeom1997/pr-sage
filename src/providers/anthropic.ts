import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ReviewRequest, ReviewResult } from "../types.js";
import { REVIEW_SCHEMA, systemPrompt, userPrompt } from "../prompt.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(readonly model: string = DEFAULT_ANTHROPIC_MODEL) {
    this.client = new Anthropic();
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system: systemPrompt(req.locale),
      output_config: {
        format: { type: "json_schema", schema: REVIEW_SCHEMA },
      },
      messages: [{ role: "user", content: userPrompt(req) }],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("Anthropic declined to review this diff (stop_reason: refusal).");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("Review output was truncated (max_tokens reached). Try fewer files per batch.");
    }
    const text = message.content.find((b) => b.type === "text");
    if (!text) throw new Error("Anthropic response contained no text block.");
    return JSON.parse(text.text) as ReviewResult;
  }
}
