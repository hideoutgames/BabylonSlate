import {
  normalizeMaterialParameterOverrides,
  type MaterialParameterValue,
} from "./material-parameter-value";

/** Worker-neutral metadata from a successfully lowered Material asset. */
export type MaterialParameterCatalog = Readonly<
  Record<
    string,
    {
      domain: "surface" | "postProcess" | "particle";
      planHash: string;
      parameters: Readonly<Record<string, MaterialParameterValue>>;
    }
  >
>;

/** Detach runtime metadata from host objects and reject malformed transport entries. */
export function normalizeMaterialParameterCatalog(
  value: unknown,
): MaterialParameterCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, MaterialParameterCatalog[string]]> = [];
  for (const [guid, raw] of Object.entries(value)) {
    if (!guid || !raw || typeof raw !== "object" || Array.isArray(raw))
      continue;
    const entry = raw as Record<string, unknown>;
    if (
      (entry.domain !== "surface" &&
        entry.domain !== "postProcess" &&
        entry.domain !== "particle") ||
      typeof entry.planHash !== "string" ||
      !entry.planHash
    )
      continue;
    entries.push([
      guid,
      {
        domain: entry.domain,
        planHash: entry.planHash,
        parameters: normalizeMaterialParameterOverrides(entry.parameters),
      },
    ]);
  }
  return Object.fromEntries(entries);
}
