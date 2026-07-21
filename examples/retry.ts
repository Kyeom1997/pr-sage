/** Demo file for testing pr-sage — contains intentional issues. */

export async function fetchWithRetry(url: string, maxRetries: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status == 200) {
        return res;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw lastError;
}

export function parseTimeout(value: string): number {
  return parseInt(value);
}
