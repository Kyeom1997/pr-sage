import OpenAI from "openai";
import type { Provider, ProviderUsage } from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
  readonly usage: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly client: OpenAI;

  constructor(readonly model: string = DEFAULT_OPENAI_MODEL) {
    this.client = new OpenAI();
  }

  async generate(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // strict mode rejects schemas with optional properties, so best-effort
      // here; runtime zod validation covers the gap.
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", strict: false, schema },
      },
    });
    this.usage.calls++;
    this.usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += completion.usage?.completion_tokens ?? 0;
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI response contained no content.");
    return JSON.parse(content) as unknown;
  }
}
