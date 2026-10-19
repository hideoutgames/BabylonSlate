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

function quotedFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return "";
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** A CSS family for a stack's generic fallback: a generic keyword stays bare, any other name is quoted. */
export function quoteCssFamily(family: string): string {
  const trimmed = family.trim();
  if (GENERIC_FAMILIES.has(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  return quotedFamily(trimmed);
}

/**
 * CSS stack for a Font: its family, its fallbacks' and the project default's
 * (Font asset families, always quoted, so a Font named `serif` is still that
 * registered face), then the generic fallback.
 */
export function compileFontStack(options: {
  family: string;
  fallbackFamilies?: readonly string[];
  projectDefaultFamily?: string | null;
  globalFallback?: string;
}): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (quoted: string) => {
    if (!quoted) return;
    const key = quoted.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(quoted);
  };

  push(quotedFamily(options.family));
  for (const fallback of options.fallbackFamilies ?? []) {
    push(quotedFamily(fallback));
  }
  push(quotedFamily(options.projectDefaultFamily ?? ""));
  push(quoteCssFamily(options.globalFallback ?? "sans-serif"));
  if (parts.length === 0 || !GENERIC_FAMILIES.has(parts[parts.length - 1]!)) {
    push("sans-serif");
  }
  return parts.join(", ");
}

export type Text2DFontStackSource = {
  guid: string;
  family: string;
  fallbackGuids?: readonly string[];
};

/** Project default + per-Font CSS stacks for Bitmap overlay 2D Text. */
export function compileText2DFontStacks(options: {
  fonts: readonly Text2DFontStackSource[];
  defaultFontGuid?: string | null;
  globalFallback?: string;
}): { defaultStack: string; byGuid: Map<string, string> } {
  const familyByGuid = new Map(
    options.fonts.map((font) => [font.guid, font.family] as const),
  );
  const familyForGuid = (guid: string): string | null =>
    familyByGuid.get(guid) ?? null;
  const globalFallback = options.globalFallback ?? "sans-serif";
  const projectDefaultFamily = options.defaultFontGuid
    ? familyForGuid(options.defaultFontGuid)
    : null;
  const defaultStack = compileFontStack({
    family: projectDefaultFamily ?? "",
    globalFallback,
  });
  const byGuid = new Map<string, string>();
  for (const font of options.fonts) {
    const fallbackFamilies = (font.fallbackGuids ?? [])
      .map((guid) => familyForGuid(guid))
      .filter((family): family is string => family !== null);
    byGuid.set(
      font.guid,
      compileFontStack({
        family: font.family,
        fallbackFamilies,
        projectDefaultFamily,
        globalFallback,
      }),
    );
  }
  return { defaultStack, byGuid };
}

/** Characters the custom family does not draw, judged by their advance under two different generic tails. */
export function glyphsFallingToFallback(
  sample: string,
  customFamily: string,
  measure: (text: string, fontStack: string) => number,
  genericFallback = "sans-serif",
): string[] {
  // A glyph the custom face draws measures the same whatever generic follows
  // it; a missing one takes on the generic's width. Two generics with
  // different advances tell the cases apart without trusting a coincidence.
  const contrast = genericFallback === "monospace" ? "serif" : "monospace";
  const customStack = compileFontStack({ family: customFamily, globalFallback: genericFallback });
  const contrastStack = compileFontStack({ family: customFamily, globalFallback: contrast });
  const flagged: string[] = [];
  const seen = new Set<string>();
  for (const char of sample) {
    if (char === " " || seen.has(char)) continue;
    seen.add(char);
    const withCustom = measure(char, customStack);
    const genericOnly = measure(char, genericFallback);
    const generics = Math.abs(genericOnly - measure(char, contrast)) >= 0.5;
    const falls = generics
      ? Math.abs(withCustom - measure(char, contrastStack)) >= 0.5
      : Math.abs(withCustom - genericOnly) < 0.5;
    if (falls) flagged.push(char);
  }
  return flagged;
}
