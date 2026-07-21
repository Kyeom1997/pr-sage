import OpenAI from "openai";
import type { Provider, ReviewRequest } from "../types.js";
import { REVIEW_SCHEMA, systemPrompt, userPrompt } from "../prompt.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
  private readonly client: OpenAI;

  constructor(readonly model: string = DEFAULT_OPENAI_MODEL) {
    this.client = new OpenAI();
  }

  async review(req: ReviewRequest): Promise<unknown> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt(req.locale, req.instructions) },
        { role: "user", content: userPrompt(req) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "review_result", strict: true, schema: REVIEW_SCHEMA },
      },
    });
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI response contained no content.");
    return JSON.parse(content) as unknown;
  }
}
