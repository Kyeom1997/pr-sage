const RETRYABLE_MESSAGE = /\b(429|503|529)\b|rate.?limit|RESOURCE_EXHAUSTED|overloaded|quota/i;

export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status === 429 || status === 503 || status === 529) return true;
  return error instanceof Error && RETRYABLE_MESSAGE.test(error.message);
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  log?: (message: string) => void;
}

/** Retry `fn` on rate-limit/overload errors with exponential backoff + jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 4, baseDelayMs = 2000, log }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 1000;
      log?.(`Rate limited; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
