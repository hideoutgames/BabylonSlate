import { publicAssetUrl } from "./branding";
import { FEATURE_TEST_SLOTS_MANIFEST } from "./feature-test/engine-content-files";

type NodeFs = {
  readFile: (path: string) => Promise<Uint8Array>;
  access: (path: string) => Promise<void>;
};

type NodePath = {
  dirname: (path: string) => string;
  resolve: (...paths: string[]) => string;
};

type NodeUrl = {
  fileURLToPath: (url: string | URL) => string;
};

export function nodeCwd(): string | null {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  if (typeof proc?.cwd !== "function") return null;
  return proc.cwd();
}

/** Non-literal so tsc does not resolve Node built-ins in the app tsconfig. */
function nodeBuiltin(name: "fs/promises" | "path" | "url"): string {
  return `node:${name}`;
}

/** Read a repository file in Node (unit tests); null in the browser or when absent. */
export async function tryReadRepoFile(relativePath: string): Promise<Uint8Array | null> {
  const cwd = nodeCwd();
  if (!cwd) return null;
  try {
    const [fs, path, url] = (await Promise.all([
      import(/* @vite-ignore */ nodeBuiltin("fs/promises")),
      import(/* @vite-ignore */ nodeBuiltin("path")),
      import(/* @vite-ignore */ nodeBuiltin("url")),
    ])) as [NodeFs, NodePath, NodeUrl];
    const candidates = [
      path.resolve(cwd, relativePath),
      path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)),
        "../../../../",
        relativePath,
      ),
    ];
    for (const file of candidates) {
      try {
        await fs.access(file);
        return new Uint8Array(await fs.readFile(file));
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Public URL for a repository `engine-content/...` path ("Holiday Pack" has a space). */
export function engineContentUrl(relativePath: string): string {
  return publicAssetUrl(relativePath.split("/").map(encodeURIComponent).join("/"));
}

/** Bytes of a published repository content file: disk in Node tests, fetch in the app. */
export async function loadEngineContentBytes(relativePath: string): Promise<Uint8Array> {
  const fromDisk = await tryReadRepoFile(relativePath);
  if (fromDisk && fromDisk.byteLength > 0) return fromDisk;
  if (import.meta.env.MODE === "test") {
    throw new Error(`Engine content was not found at ${relativePath} (cwd ${nodeCwd() ?? "unknown"}).`);
  }
  const url = engineContentUrl(relativePath);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Engine content is missing (${response.status} ${url}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let publishedSlots: Promise<ReadonlySet<string>> | null = null;

/** Optional CC0 slot files the build published (see `FEATURE_TEST_SLOTS_MANIFEST`). */
async function publishedOptionalContent(): Promise<ReadonlySet<string>> {
  publishedSlots ??= (async () => {
    try {
      const response = await fetch(engineContentUrl(FEATURE_TEST_SLOTS_MANIFEST));
      if (!response.ok) return new Set<string>();
      const manifest = (await response.json()) as { present?: unknown };
      return new Set(
        Array.isArray(manifest.present)
          ? manifest.present.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      return new Set<string>();
    }
  })();
  return publishedSlots;
}

/**
 * First present file among `candidates`, or null. Optional content never
 * fails a scaffold: a missing slot leaves its feature authored without media.
 */
export async function loadOptionalEngineContent(
  candidates: readonly string[],
): Promise<{ path: string; bytes: Uint8Array } | null> {
  if (import.meta.env.MODE === "test") {
    for (const path of candidates) {
      const bytes = await tryReadRepoFile(path);
      if (bytes && bytes.byteLength > 0) return { path, bytes };
    }
    return null;
  }
  const published = await publishedOptionalContent();
  for (const path of candidates) {
    if (!published.has(path)) continue;
    try {
      return { path, bytes: await loadEngineContentBytes(path) };
    } catch {
      continue;
    }
  }
  return null;
}
