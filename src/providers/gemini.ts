import { GoogleGenAI } from "@google/genai";
import type { Provider, ReviewRequest } from "../types.js";
import { REVIEW_SCHEMA, systemPrompt, userPrompt } from "../prompt.js";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;

  constructor(readonly model: string = DEFAULT_GEMINI_MODEL) {
    this.client = new GoogleGenAI({});
  }

  async review(req: ReviewRequest): Promise<unknown> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: userPrompt(req),
      config: {
        systemInstruction: systemPrompt(req.locale, req.instructions),
        responseMimeType: "application/json",
        responseJsonSchema: REVIEW_SCHEMA,
      },
    });
    const text = response.text;
    if (!text) throw new Error("Gemini response contained no text.");
    return JSON.parse(text) as unknown;
  }
}
