const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

export function quoteCssFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return "";
  if (GENERIC_FAMILIES.has(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function compileFontStack(options: {
  family: string;
  fallbackFamilies?: readonly string[];
  projectDefaultFamily?: string | null;
  globalFallback?: string;
}): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (family: string | null | undefined, allowGeneric: boolean) => {
    if (!family) return;
    const quoted = quoteCssFamily(family);
    if (!quoted) return;
    const generic = GENERIC_FAMILIES.has(quoted);
    if (generic && !allowGeneric) return;
    const key = quoted.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(quoted);
  };

  push(options.family, false);
  for (const fallback of options.fallbackFamilies ?? []) {
    push(fallback, false);
  }
  push(options.projectDefaultFamily ?? null, false);
  push(options.globalFallback ?? "sans-serif", true);
  if (parts.length === 0 || !GENERIC_FAMILIES.has(parts[parts.length - 1]!)) {
    push("sans-serif", true);
  }
  return parts.join(", ");
}

/** Characters whose advance matches the generic-only stack (likely fallback). */
export function glyphsFallingToFallback(
  sample: string,
  customFamily: string,
  measure: (text: string, fontStack: string) => number,
  genericFallback = "sans-serif",
): string[] {
  const customStack = compileFontStack({
    family: customFamily,
    globalFallback: genericFallback,
  });
  const flagged: string[] = [];
  const seen = new Set<string>();
  for (const char of sample) {
    if (char === " " || seen.has(char)) continue;
    seen.add(char);
    const withCustom = measure(char, customStack);
    const genericOnly = measure(char, genericFallback);
    if (Math.abs(withCustom - genericOnly) < 0.5) {
      flagged.push(char);
    }
  }
  return flagged;
}
