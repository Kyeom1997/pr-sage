/**
 * Resolve `"auto"` locale from sample text (PR title/body, commit messages).
 * Detection is script-based and deliberately coarse — when nothing matches,
 * English is the safe default.
 */
export function resolveLocale(locale: string, ...samples: Array<string | undefined>): string {
  if (locale !== "auto") return locale;
  const text = samples.filter(Boolean).join(" ");
  if (/[가-힣]/.test(text)) return "Korean";
  if (/[぀-ヿ]/.test(text)) return "Japanese";
  if (/[一-鿿]/.test(text)) return "Chinese";
  return "English";
}
