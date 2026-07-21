import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(readonly model: string = DEFAULT_ANTHROPIC_MODEL) {
    this.client = new Anthropic();
  }

  async generate(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system,
      output_config: {
        format: { type: "json_schema", schema },
      },
      messages: [{ role: "user", content: user }],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("Anthropic declined this request (stop_reason: refusal).");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("Output was truncated (max_tokens reached). Try fewer files per batch.");
    }
    const text = message.content.find((b) => b.type === "text");
    if (!text) throw new Error("Anthropic response contained no text block.");
    return JSON.parse(text.text) as unknown;
  }
}
