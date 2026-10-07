import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { FBXFileLoader } from "@babylonjs/loaders/FBX/fbxFileLoader";
import { ingestGltfForImport } from "@babylonslate/assets";
import { exportConvertedSceneToGlb } from "./convert-obj-to-glb";

export type ModelImportFile = { name: string; bytes: Uint8Array };

/** Texture URLs the loader builds from FBX relative paths; never fetched. */
const SIDECAR_ROOT = "file:";

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
}

/**
 * The selected image for an FBX texture path. Babylon 9.29's ASCII FBX parser
 * reads `Textures\albedo.png` as `Texturesalbedo.png`, so a path that matches
 * no basename falls back to the longest selected name it ends with.
 */
function sidecarFor(
  path: string,
  sidecars: ReadonlyMap<string, ModelImportFile>,
): ModelImportFile | undefined {
  const name = basename(path);
  const exact = sidecars.get(name);
  if (exact) return exact;
  let best: [string, ModelImportFile] | undefined;
  for (const entry of sidecars)
    if (name.endsWith(entry[0]) && entry[0].length > (best?.[0].length ?? 0))
      best = entry;
  return best?.[1];
}

/**
 * Load FBX with Babylon's FBX loader on a scratch scene and export canonical
 * GLB. The loader converts source axes and units to Y-up meters and builds
 * PBR materials; external textures resolve to the selected image sidecars.
 */
export async function convertFbxToGlb(
  file: ModelImportFile,
  sidecars: readonly ModelImportFile[] = [],
  consumedSidecars?: Set<string>,
): Promise<Uint8Array> {
  const byName = new Map<string, ModelImportFile>();
  for (const sidecar of sidecars) {
    const key = basename(sidecar.name);
    if (byName.has(key)) throw new Error(`Ambiguous FBX sidecar name: ${key}`);
    byName.set(key, sidecar);
  }
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const loader = new FBXFileLoader({ materials: "pbr", unitScale: "meters" });
    let container;
    try {
      container = await loader.loadAssetContainerAsync(scene, file.bytes.slice().buffer, SIDECAR_ROOT);
    } catch (error) {
      throw new Error(`FBX conversion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    container.addAllToScene();
    for (const texture of container.textures) {
      const internal = texture.getInternalTexture();
      if (!internal?.url.startsWith(SIDECAR_ROOT)) continue;
      const path = internal.url.slice(SIDECAR_ROOT.length);
      const sidecar = sidecarFor(path, byName);
      // Fail visibly instead of silently dropping missing materials' image inputs.
      if (!sidecar)
        throw new Error(`Missing FBX texture: ${path}. Select its image file with the FBX.`);
      // The glTF serializer embeds a URL texture's cached source bytes as-is.
      internal._buffer = sidecar.bytes.slice();
      consumedSidecars?.add(sidecar.name);
    }
    const glb = await exportConvertedSceneToGlb(scene, "FBX");
    return ingestGltfForImport("import.glb", glb, new Map()).bytes;
  } finally {
    scene.dispose();
    engine.dispose();
  }
}
