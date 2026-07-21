import type { Provider, ProviderName } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";

const REQUIRED_ENV: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function createProvider(name: ProviderName, model?: string): Provider {
  const envVar = REQUIRED_ENV[name];
  if (!process.env[envVar]) {
    throw new Error(`${envVar} is not set (required for provider "${name}").`);
  }
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "openai":
      return new OpenAIProvider(model);
    case "gemini":
      return new GeminiProvider(model);
  }
}
