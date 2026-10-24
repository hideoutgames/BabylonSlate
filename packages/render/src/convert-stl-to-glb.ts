import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { ModelBatchConversionOptions } from "./convert-fbx-to-glb";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { STLFileLoader } from "@babylonjs/loaders/STL/stlFileLoader";
import { exportConvertedSceneToGlb } from "./convert-obj-to-glb";

const STL_EXTENSION = /\.stl$/i;

/** Load a binary or ASCII STL and export a GLB for Model import. STL carries
 * geometry only, so the Model gets the default material slot. */
export async function convertStlToGlb(
  stlBytes: Uint8Array,
  options: { engine?: AbstractEngine } = {},
): Promise<Uint8Array> {
  const engine = options.engine ?? new NullEngine();
  const ownsEngine = !options.engine;
  const scene = new Scene(engine);
  try {
    // The loader detects binary STL from an ArrayBuffer and decodes ASCII itself.
    const data = stlBytes.slice().buffer;
    const container = new STLFileLoader().loadAssetContainer(
      scene,
      data as unknown as string,
      "",
    );
    container.addAllToScene();
    return await exportConvertedSceneToGlb(scene, "STL");
  } finally {
    for (const mesh of [...scene.meshes]) mesh.dispose(false, true);
    scene.dispose();
    if (ownsEngine) engine.dispose();
  }
}

/** Convert STL files in a picker batch to GLB; leave other files as-is. */
export async function convertStlImportBatch(
  files: Array<{ name: string; bytes: Uint8Array }>,
  options: ModelBatchConversionOptions & { engine?: AbstractEngine } = {},
): Promise<{
  files: Array<{ name: string; bytes: Uint8Array }>;
  errors: string[];
}> {
  const converted: Array<{ name: string; bytes: Uint8Array }> = [];
  const rest: Array<{ name: string; bytes: Uint8Array }> = [];
  const errors: string[] = [];
  for (const file of files) {
    if (!STL_EXTENSION.test(file.name)) {
      rest.push(file);
      continue;
    }
    // Between files only: the conversion runs on the main thread's Engine and cannot stop partway.
    options.signal?.throwIfAborted();
    options.onFile?.(file.name);
    try {
      converted.push({
        name: file.name.replace(STL_EXTENSION, ".glb"),
        bytes: await convertStlToGlb(file.bytes, { engine: options.engine }),
      });
    } catch (err) {
      errors.push(
        `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { files: [...converted, ...rest], errors };
}
