import OpenAI from "openai";
import type { Provider } from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
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
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI response contained no content.");
    return JSON.parse(content) as unknown;
  }
}
