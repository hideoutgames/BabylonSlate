export interface FontRepresentations {
  source: boolean;
  facetype: boolean;
  msdfJson: boolean;
  msdfPng: boolean;
  /** True only when the JSON + PNG pair is complete. */
  msdf: boolean;
}

export interface FontPayload {
  family: string;
  weight: number | string;
  style: "normal" | "italic";
  fallbackGuids: string[];
  representations: FontRepresentations;
}

function representationsFrom(
  extra: Partial<FontRepresentations> | undefined,
): FontRepresentations {
  const msdfJson = extra?.msdfJson === true;
  const msdfPng = extra?.msdfPng === true;
  return {
    source: extra?.source === true,
    facetype: extra?.facetype === true,
    msdfJson,
    msdfPng,
    msdf: msdfJson && msdfPng,
  };
}

export function createFontPayload(
  family: string,
  extra: Omit<Partial<FontPayload>, "representations"> & {
    representations?: Partial<FontRepresentations>;
  } = {},
): FontPayload {
  return {
    family,
    weight: extra.weight ?? 400,
    style: extra.style === "italic" ? "italic" : "normal",
    fallbackGuids: extra.fallbackGuids ? [...extra.fallbackGuids] : [],
    representations: representationsFrom(extra.representations),
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
  const hasExplicitMsdfParts =
    "msdfJson" in representations || "msdfPng" in representations;
  const msdfJson = hasExplicitMsdfParts
    ? representations.msdfJson === true
    : representations.msdf === true;
  const msdfPng = representations.msdfPng === true;
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
      msdfJson,
      msdfPng,
    },
  });
}

/** OR representation flags so attaching MSDF does not clear `source`. */
export function mergeFontAttachPayload(
  existing: unknown,
  incoming: unknown,
  familyFallback: string,
): FontPayload {
  const current = normalizeFontPayload(existing, familyFallback);
  const next = normalizeFontPayload(incoming, current.family);
  return createFontPayload(current.family, {
    weight: current.weight,
    style: current.style,
    fallbackGuids:
      current.fallbackGuids.length > 0 ? current.fallbackGuids : next.fallbackGuids,
    representations: {
      source: current.representations.source || next.representations.source,
      facetype: current.representations.facetype || next.representations.facetype,
      msdfJson:
        current.representations.msdfJson || next.representations.msdfJson,
      msdfPng: current.representations.msdfPng || next.representations.msdfPng,
    },
  });
}
