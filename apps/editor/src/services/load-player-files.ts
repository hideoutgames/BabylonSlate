import { defaultPlayerIndexHtml } from "@babylonslate/exporter";

const PLAYER_CANDIDATES = [
  "player-files.json",
  "index.html",
  "player.js",
  "coi-serviceworker.js",
  "havok/HavokPhysics.wasm",
  "ktx2/babylon.ktx2Decoder.js",
  "ktx2/msc_basis_transcoder.js",
  "ktx2/msc_basis_transcoder.wasm",
];

function originBase(): string {
  return typeof globalThis.location?.origin === "string"
    ? globalThis.location.origin
    : "http://127.0.0.1";
}

async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

export async function loadPlayerDistFiles(
  base = "/player/",
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const root = new URL(base, originBase()).href;
  const listBytes = await fetchBytes(new URL("player-files.json", root).href, fetchImpl);
  let names = [...PLAYER_CANDIDATES];
  if (listBytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(listBytes)) as unknown;
      if (Array.isArray(parsed)) {
        names = parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry !== "player-files.json",
        );
      }
    } catch {
      /* fall back to candidates */
    }
  }
  for (const name of names) {
    const bytes = await fetchBytes(new URL(name, root).href, fetchImpl);
    if (bytes) files.set(name, bytes);
  }
  if (!files.has("index.html")) {
    files.set("index.html", new TextEncoder().encode(defaultPlayerIndexHtml()));
  }
  return files;
}
