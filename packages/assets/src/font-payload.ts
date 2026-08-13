export interface FontRepresentations {
  source: boolean;
  facetype: boolean;
  msdf: boolean;
}

export interface FontPayload {
  family: string;
  weight: number | string;
  style: "normal" | "italic";
  fallbackGuids: string[];
  representations: FontRepresentations;
}

export function createFontPayload(
  family: string,
  extra: Partial<FontPayload> = {},
): FontPayload {
  return {
    family,
    weight: extra.weight ?? 400,
    style: extra.style === "italic" ? "italic" : "normal",
    fallbackGuids: extra.fallbackGuids ? [...extra.fallbackGuids] : [],
    representations: {
      source: extra.representations?.source ?? false,
      facetype: extra.representations?.facetype ?? false,
      msdf: extra.representations?.msdf ?? false,
    },
  };
}

export function normalizeFontPayload(
  value: unknown,
  familyFallback: string,
): FontPayload {
  const source = (value ?? {}) as Record<string, unknown>;
  const representations = (source.representations ?? {}) as Record<
    string,
    unknown
  >;
  const fallbackGuids = Array.isArray(source.fallbackGuids)
    ? source.fallbackGuids.filter((entry): entry is string => typeof entry === "string")
    : [];
  const family =
    typeof source.family === "string" && source.family.trim() !== ""
      ? source.family.trim()
      : familyFallback;
  return createFontPayload(family, {
    weight:
      typeof source.weight === "number" || typeof source.weight === "string"
        ? source.weight
        : 400,
    style: source.style === "italic" ? "italic" : "normal",
    fallbackGuids,
    representations: {
      source: representations.source === true,
      facetype: representations.facetype === true,
      msdf: representations.msdf === true,
    },
  });
}
