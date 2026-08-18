import { publicAssetUrl } from "./branding";

/** Public URL path (under Vite `BASE_URL`) for the Kenney Mannequin GLB. */
export const KENNEY_MANNEQUIN_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

const REPO_RELATIVE_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

async function tryReadKenneyMannequinFromDisk(): Promise<Uint8Array | null> {
  if (typeof process === "undefined" || process.release?.name !== "node") {
    return null;
  }
  try {
    const [{ readFile, access }, { dirname, resolve }, { fileURLToPath }] =
      await Promise.all([
        import(/* @vite-ignore */ "node:fs/promises"),
        import(/* @vite-ignore */ "node:path"),
        import(/* @vite-ignore */ "node:url"),
      ]);
    const candidates = [
      resolve(process.cwd(), REPO_RELATIVE_PATH),
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../",
        REPO_RELATIVE_PATH,
      ),
    ];
    for (const file of candidates) {
      try {
        await access(file);
        return new Uint8Array(await readFile(file));
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
