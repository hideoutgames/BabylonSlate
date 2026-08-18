import { embedGlbExternalImages } from "@babylonslate/assets";
import { publicAssetUrl } from "./branding";

/** Public URL path (under Vite `BASE_URL`) for the Kenney Mannequin GLB. */
export const KENNEY_MANNEQUIN_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

export const KENNEY_MANNEQUIN_PNG_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.png";

const REPO_RELATIVE_GLB =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";
const REPO_RELATIVE_PNG =
  "engine-content/kenney-assets/Mannequin/mannequin.png";

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

function nodeCwd(): string | null {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  if (typeof proc?.cwd !== "function") return null;
  return proc.cwd();
}

/** Non-literal so tsc does not resolve Node built-ins in the app tsconfig. */
function nodeBuiltin(name: "fs/promises" | "path" | "url"): string {
  return `node:${name}`;
}

async function tryReadRepoFile(relativePath: string): Promise<Uint8Array | null> {
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

async function fetchPublicBytes(publicPath: string): Promise<Uint8Array> {
  const response = await fetch(publicAssetUrl(publicPath));
  if (!response.ok) {
    throw new Error(
      `Kenney Mannequin asset is missing (${response.status} ${publicAssetUrl(publicPath)}).`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function withEmbeddedAlbedo(glb: Uint8Array, png: Uint8Array | null): Uint8Array {
  if (!png || png.byteLength === 0) return glb;
  return embedGlbExternalImages(glb, {
    "Textures/texture-d.png": png,
    "texture-d.png": png,
    "mannequin.png": png,
  });
}

/** Kenney Mannequin GLB bytes with albedo embedded (repo files in Node tests). */
export async function loadKenneyMannequinGlb(): Promise<Uint8Array> {
  const fromDisk = await tryReadRepoFile(REPO_RELATIVE_GLB);
  if (fromDisk && fromDisk.byteLength > 0) {
    const png = await tryReadRepoFile(REPO_RELATIVE_PNG);
    return withEmbeddedAlbedo(fromDisk, png);
  }
  if (import.meta.env.MODE === "test") {
    throw new Error(
      `Kenney Mannequin GLB was not found at ${REPO_RELATIVE_GLB} (cwd ${nodeCwd() ?? "unknown"}).`,
    );
  }
  const glb = await fetchPublicBytes(KENNEY_MANNEQUIN_PUBLIC_PATH);
  let png: Uint8Array | null = null;
  try {
    png = await fetchPublicBytes(KENNEY_MANNEQUIN_PNG_PUBLIC_PATH);
  } catch {
    png = null;
  }
  return withEmbeddedAlbedo(glb, png);
}
