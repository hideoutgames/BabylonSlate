import { publicAssetUrl } from "./branding";

/** Public URL path (under Vite `BASE_URL`) for the Kenney Mannequin GLB. */
export const KENNEY_MANNEQUIN_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

const REPO_RELATIVE_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

type NodeProcess = {
  cwd: () => string;
  release?: { name?: string };
};

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

function nodeProcess(): NodeProcess | undefined {
  const candidate = (globalThis as { process?: Partial<NodeProcess> }).process;
  if (typeof candidate?.cwd !== "function") return undefined;
  if (candidate.release?.name !== "node") return undefined;
  return candidate as NodeProcess;
}

function importNodeModule<T>(specifier: string): Promise<T> {
  const importer = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<T>;
  return importer(specifier);
}

async function tryReadKenneyMannequinFromDisk(): Promise<Uint8Array | null> {
  const proc = nodeProcess();
  if (!proc) return null;
  try {
    const [fs, path, url] = await Promise.all([
      importNodeModule<NodeFs>("node:fs/promises"),
      importNodeModule<NodePath>("node:path"),
      importNodeModule<NodeUrl>("node:url"),
    ]);
    const candidates = [
      path.resolve(proc.cwd(), REPO_RELATIVE_PATH),
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
  const response = await fetch(publicAssetUrl(KENNEY_MANNEQUIN_PUBLIC_PATH));
  if (!response.ok) {
    throw new Error(
      `Kenney Mannequin GLB is missing (${response.status} ${publicAssetUrl(KENNEY_MANNEQUIN_PUBLIC_PATH)}).`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
