export const FLOW_SWITCH_CASE_PREFIX = "case:";

export type FlowSwitchCaseWarning = {
  code:
    | "flow.switch.empty_case"
    | "flow.switch.duplicate_case"
    | "flow.switch.invalid_int";
  message: string;
  value?: string;
};

export function flowSwitchCasePinId(caseValue: string): string {
  return `${FLOW_SWITCH_CASE_PREFIX}${encodeURIComponent(caseValue)}`;
}

/** Case value from a Switch exec-out pin id (`case:a%2Fb`). */
export function flowSwitchCaseValueFromPinId(
  pinId: string,
): string | undefined {
  if (!pinId.startsWith(FLOW_SWITCH_CASE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(pinId.slice(FLOW_SWITCH_CASE_PREFIX.length));
  } catch {
    return undefined;
  }
}

function asRawCaseList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export function normalizeIntSwitchCases(raw: unknown): {
  cases: number[];
  warnings: FlowSwitchCaseWarning[];
} {
  const cases: number[] = [];
  const warnings: FlowSwitchCaseWarning[] = [];
  const seen = new Set<number>();

  for (const entry of asRawCaseList(raw)) {
    if (typeof entry === "string" && entry.trim() === "") {
      warnings.push({
        code: "flow.switch.empty_case",
        message: "Empty Switch on Int case was removed.",
      });
      continue;
    }
    if (entry === "" || entry === null || entry === undefined) {
      warnings.push({
        code: "flow.switch.empty_case",
        message: "Empty Switch on Int case was removed.",
      });
      continue;
    }

    const numeric =
      typeof entry === "number"
        ? entry
        : typeof entry === "string"
          ? Number(entry.trim())
          : Number.NaN;

    if (!Number.isFinite(numeric)) {
      warnings.push({
        code: "flow.switch.invalid_int",
        message: "Non-integer Switch on Int case was removed.",
        value: String(entry),
      });
      continue;
    }

    const value = Math.trunc(numeric);
    if (seen.has(value)) {
      warnings.push({
        code: "flow.switch.duplicate_case",
        message: `Duplicate Switch on Int case ${value} was removed.`,
        value: String(value),
      });
      continue;
    }
    seen.add(value);
    cases.push(value);
  }

  return { cases, warnings };
}

export function normalizeStringSwitchCases(raw: unknown): {
  cases: string[];
  warnings: FlowSwitchCaseWarning[];
} {
  const cases: string[] = [];
  const warnings: FlowSwitchCaseWarning[] = [];
  const seen = new Set<string>();

  for (const entry of asRawCaseList(raw)) {
    if (typeof entry !== "string") {
      warnings.push({
        code: "flow.switch.empty_case",
        message: "Empty Switch on String case was removed.",
      });
      continue;
    }
    if (entry.trim() === "") {
      warnings.push({
        code: "flow.switch.empty_case",
        message: "Empty Switch on String case was removed.",
      });
      continue;
    }
    if (seen.has(entry)) {
      warnings.push({
        code: "flow.switch.duplicate_case",
        message: `Duplicate Switch on String case ${JSON.stringify(entry)} was removed.`,
        value: entry,
      });
      continue;
    }
    seen.add(entry);
    cases.push(entry);
  }

  return { cases, warnings };
}

export function intSwitchCasesOf(
  properties: Record<string, unknown>,
): number[] {
  return normalizeIntSwitchCases(properties.cases).cases;
}

export function stringSwitchCasesOf(
  properties: Record<string, unknown>,
): string[] {
  return normalizeStringSwitchCases(properties.cases).cases;
}
