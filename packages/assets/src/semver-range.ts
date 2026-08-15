export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compare(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function parseBase(token: string): Semver | null {
  return parseSemver(token);
}

function caretUpper(base: Semver): Semver {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

function tildeUpper(base: Semver): Semver {
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

function satisfiesToken(version: Semver, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return true;
  const wildcard = /^(\d+)\.(x|X|\*)$/.exec(trimmed);
  if (wildcard) {
    return version.major === Number(wildcard[1]);
  }
  if (trimmed === "x" || trimmed === "X" || trimmed === "*") return true;
  if (trimmed.startsWith("^")) {
    const base = parseBase(trimmed.slice(1));
    if (!base) return false;
    return compare(version, base) >= 0 && compare(version, caretUpper(base)) < 0;
  }
  if (trimmed.startsWith("~")) {
    const base = parseBase(trimmed.slice(1));
    if (!base) return false;
    return compare(version, base) >= 0 && compare(version, tildeUpper(base)) < 0;
  }
  if (trimmed.startsWith(">=")) {
    const base = parseBase(trimmed.slice(2));
    return base ? compare(version, base) >= 0 : false;
  }
  if (trimmed.startsWith("<=")) {
    const base = parseBase(trimmed.slice(2));
    return base ? compare(version, base) <= 0 : false;
  }
  if (trimmed.startsWith(">")) {
    const base = parseBase(trimmed.slice(1));
    return base ? compare(version, base) > 0 : false;
  }
  if (trimmed.startsWith("<")) {
    const base = parseBase(trimmed.slice(1));
    return base ? compare(version, base) < 0 : false;
  }
  const exact = parseBase(trimmed);
  return exact ? compare(version, exact) === 0 : false;
}

/** True when `version` satisfies a caret/tilde/comparator/`x` range. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => satisfiesToken(parsed, token));
}
