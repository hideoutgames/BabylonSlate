import { embedGlbExternalImages } from "@babylonslate/assets";
import { publicAssetUrl } from "./branding";
import { nodeCwd, tryReadRepoFile } from "./engine-content";
import { prepareMannequinNormals } from "./kenney-mannequin-normals";

/** Public URL path (under Vite `BASE_URL`) for the Kenney Mannequin GLB. */
export const KENNEY_MANNEQUIN_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";

export const KENNEY_MANNEQUIN_PNG_PUBLIC_PATH =
  "engine-content/kenney-assets/Mannequin/mannequin.png";

const REPO_RELATIVE_GLB =
  "engine-content/kenney-assets/Mannequin/mannequin.glb";
const REPO_RELATIVE_PNG =
  "engine-content/kenney-assets/Mannequin/mannequin.png";

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
  glb = prepareMannequinNormals(glb);
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
  let png: Uint8Array | null;
  try {
    png = await fetchPublicBytes(KENNEY_MANNEQUIN_PNG_PUBLIC_PATH);
  } catch {
    png = null;
  }
  return withEmbeddedAlbedo(glb, png);
}
