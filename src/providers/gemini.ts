import { GoogleGenAI } from "@google/genai";
import type { Provider, ProviderUsage } from "../types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;
  readonly usage: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly client: GoogleGenAI;

  constructor(readonly model: string = DEFAULT_GEMINI_MODEL) {
    this.client = new GoogleGenAI({});
  }

  async generate(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    });
    this.usage.calls++;
    this.usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    this.usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
    const text = response.text;
    if (!text) throw new Error("Gemini response contained no text.");
    return JSON.parse(text) as unknown;
  }
}
