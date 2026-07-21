import { GoogleGenAI } from "@google/genai";
import type { Provider } from "../types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;
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
    const text = response.text;
    if (!text) throw new Error("Gemini response contained no text.");
    return JSON.parse(text) as unknown;
  }
}
