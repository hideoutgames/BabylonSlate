import { publicAssetUrl } from "./branding";

/** Public URL path (under Vite `BASE_URL`) for the Kenney Mannequin GLB. */
export const KENNEY_MANNEQUIN_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

const REPO_RELATIVE_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

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

async function tryReadKenneyMannequinFromDisk(): Promise<Uint8Array | null> {
  const cwd = nodeCwd();
  if (!cwd) return null;
  try {
    const [fs, path, url] = (await Promise.all([
      import(/* @vite-ignore */ nodeBuiltin("fs/promises")),
      import(/* @vite-ignore */ nodeBuiltin("path")),
      import(/* @vite-ignore */ nodeBuiltin("url")),
    ])) as [NodeFs, NodePath, NodeUrl];
    const candidates = [
      path.resolve(cwd, REPO_RELATIVE_PATH),
      path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)),
        "../../../../",
        REPO_RELATIVE_PATH,
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

/** Kenney Mannequin GLB bytes (repo file in Node tests; public URL in the browser). */
export async function loadKenneyMannequinGlb(): Promise<Uint8Array> {
  const fromDisk = await tryReadKenneyMannequinFromDisk();
  if (fromDisk && fromDisk.byteLength > 0) return fromDisk;
  if (import.meta.env.MODE === "test") {
    throw new Error(
      `Kenney Mannequin GLB was not found at ${REPO_RELATIVE_PATH} (cwd ${nodeCwd() ?? "unknown"}).`,
    );
  }
  const response = await fetch(publicAssetUrl(KENNEY_MANNEQUIN_PUBLIC_PATH));
  if (!response.ok) {
    throw new Error(
      `Kenney Mannequin GLB is missing (${response.status} ${publicAssetUrl(KENNEY_MANNEQUIN_PUBLIC_PATH)}).`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
