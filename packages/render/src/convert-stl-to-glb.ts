import { createHeadlessEngine } from "./large-world";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { ModelBatchConversionOptions } from "./convert-fbx-to-glb";
import { Scene } from "@babylonjs/core/scene";
import { STLFileLoader } from "@babylonjs/loaders/STL/stlFileLoader";
import { assertMeshConversionSourceSize, exportConvertedSceneToGlb } from "./convert-obj-to-glb";
import { formatImportBytes, formatImportCount, importLimitError, STL_MAX_TRIANGLES } from "@haptic/assets";

const STL_EXTENSION = /\.stl$/i;

const STL_HEADER_BYTES = 84;
const STL_TRIANGLE_BYTES = 50;
const SOLID = [0x73, 0x6f, 0x6c, 0x69, 0x64];

/**
 * Checks an STL the way Babylon's loader will read it, before it allocates:
 * the loader reads a file as binary when its size matches the triangle count
 * at byte 80, or when it does not start with `solid`, and then allocates for
 * that count. A binary file must hold every triangle it declares, and no more
 * than {@link STL_MAX_TRIANGLES}.
 */
export function assertStlWithinLimits(bytes: Uint8Array): void {
  assertMeshConversionSourceSize("STL", bytes.byteLength);
  if (bytes.byteLength <= 80) return;
  const ascii = SOLID.every((byte, index) => bytes[index] === byte);
  if (bytes.byteLength < STL_HEADER_BYTES) {
    if (ascii) return;
    throw new Error("The STL is too short to hold its triangle count. It is damaged or not an STL.");
  }
  const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  const exact = STL_HEADER_BYTES + triangles * STL_TRIANGLE_BYTES === bytes.byteLength;
  if (!exact && ascii) return;
  if (triangles > STL_MAX_TRIANGLES) {
    throw importLimitError(
      "The STL's triangle count",
      formatImportCount(triangles),
      formatImportCount(STL_MAX_TRIANGLES),
      "Decimate the mesh or split it into smaller files.",
    );
  }
  if (bytes.byteLength < STL_HEADER_BYTES + triangles * STL_TRIANGLE_BYTES) {
    throw new Error(
      `The STL declares ${formatImportCount(triangles)} triangles, which need ${formatImportBytes(STL_HEADER_BYTES + triangles * STL_TRIANGLE_BYTES)}, but the file is ${formatImportBytes(bytes.byteLength)}. It is damaged or not an STL.`,
    );
  }
}

/** Load a binary or ASCII STL and export a GLB for Model import. STL carries
 * geometry only, so the Model gets the default material slot. */
export async function convertStlToGlb(
  stlBytes: Uint8Array,
  options: { engine?: AbstractEngine } = {},
): Promise<Uint8Array> {
  assertStlWithinLimits(stlBytes);
  const engine = options.engine ?? createHeadlessEngine();
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
