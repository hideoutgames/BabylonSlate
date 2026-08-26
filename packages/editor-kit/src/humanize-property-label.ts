/** Canonical spellings for tokens that Title Case would otherwise mangle. */
const ACRONYMS: Record<string, string> = {
  "2d": "2D",
  "3d": "3D",
  ui: "UI",
  id: "ID",
  guid: "GUID",
  url: "URL",
  uri: "URI",
  pbr: "PBR",
  ms: "MS",
  xy: "XY",
  xyz: "XYZ",
  uv: "UV",
  rgb: "RGB",
  rgba: "RGBA",
  hdr: "HDR",
  lod: "LOD",
  fov: "FOV",
  fps: "FPS",
  js: "JS",
  msdf: "MSDF",
};

function titleCaseWord(word: string): string {
  const canonical = ACRONYMS[word.toLowerCase()];
  if (canonical) return canonical;
  if (!word) return word;
  const isAllLower = word === word.toLowerCase();
  const isAllUpper = word === word.toUpperCase();
  if (!isAllLower && !isAllUpper) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCaseToken(token: string): string {
  return token.replace(/[A-Za-z0-9]+/g, titleCaseWord);
}

function splitIdentifier(token: string): string {
  return token
    .replace(/([0-9][Dd])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(?=2[Dd]|3[Dd])/g, "$1 ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._-]+/g, " ");
}

/**
 * Title Case a camelCase, snake_case, or already-spaced label.
 * Keeps 2D/3D (and similar) as acronyms instead of "2 d".
 */
export function humanizePropertyLabel(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return key;
  const joined = trimmed.replace(/\b([23])\s+[Dd]\b/g, "$1D");
  const words = joined.split(/\s+/).flatMap((token) => {
    const startsUpper = /^[A-Z]/.test(token);
    const split =
      startsUpper && !/[._-]/.test(token) ? token : splitIdentifier(token);
    return split.split(/\s+/).filter(Boolean);
  });
  if (words.length === 0) return key;
  return words.map(titleCaseToken).join(" ");
}

/** Class-member event name without the leading "Event" prefix. */
export function formatEventMemberName(raw: string): string {
  return humanizePropertyLabel(raw.trim())
    .replace(/^(Event\s+)+/, "")
    .trim();
}

/** Graph node title: `Event Begin Play`, `Event On Hit (Collider)`. */
export function formatEventTitle(raw: string, qualifier?: string): string {
  let body = formatEventMemberName(raw);
  const label = qualifier?.trim();
  if (label) {
    body = body.replace(/\s*\([^)]+\)\s*$/, "").trim();
    return body ? `Event ${body} (${label})` : `Event (${label})`;
  }
  return body ? `Event ${body}` : "Event";
}
