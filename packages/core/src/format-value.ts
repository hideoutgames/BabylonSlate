/** Deterministic stringification for Log / Print (engineplan §6). */

export type FormatValueOptions = {
  classNameByGuid?: ReadonlyMap<string, string>;
  maxDepth?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Map)
  );
}

function formatRef(
  value: Record<string, unknown>,
  classNameByGuid: ReadonlyMap<string, string> | undefined,
): string | null {
  const guid = value.guid;
  if (typeof guid !== "string") return null;
  const className =
    (typeof value.className === "string" ? value.className : undefined) ??
    (typeof value.classId === "string" ? value.classId : undefined) ??
    classNameByGuid?.get(guid) ??
    "Object";
  return `${className}(${guid})`;
}

function formatInner(
  value: unknown,
  depth: number,
  maxDepth: number,
  classNameByGuid: ReadonlyMap<string, string> | undefined,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[Function]";

  if (depth >= maxDepth) return "…";

  if (Array.isArray(value)) {
    const items = value.map((v) =>
      formatInner(v, depth + 1, maxDepth, classNameByGuid),
    );
    return `[${items.join(", ")}]`;
  }

  if (value instanceof Map) {
    const parts: string[] = [];
    for (const [k, v] of value.entries()) {
      parts.push(
        `${formatInner(k, depth + 1, maxDepth, classNameByGuid)}: ${formatInner(v, depth + 1, maxDepth, classNameByGuid)}`,
      );
    }
    return `{${parts.join(", ")}}`;
  }

  if (isPlainObject(value)) {
    if ("tag" in value && "value" in value && Object.keys(value).length === 2) {
      return `Wildcard(${String(value.tag)}, ${formatInner(value.value, depth + 1, maxDepth, classNameByGuid)})`;
    }
    const ref = formatRef(value, classNameByGuid);
    if (ref) return ref;

    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) =>
        `${k}: ${formatInner(value[k], depth + 1, maxDepth, classNameByGuid)}`,
    );
    return `{${parts.join(", ")}}`;
  }

  return String(value);
}

/**
 * Golden-stable formatting for on-screen and log output.
 * Structs/enums are plain objects; object refs use `guid` + `className`/`classId`.
 */
export function formatValue(
  value: unknown,
  options: FormatValueOptions = {},
): string {
  return formatInner(
    value,
    0,
    options.maxDepth ?? 6,
    options.classNameByGuid,
  );
}
