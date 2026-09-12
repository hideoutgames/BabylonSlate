import type { AssimpModule } from "assimpjs";
import { ingestGltfForImport, splitGlbJsonBin } from "@babylonslate/assets";

export type ModelImportFile = { name: string; bytes: Uint8Array };

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
}

/** Engine-independent WASM boundary, shared by the import worker and fixture tests. */
export function convertFbxWithAssimp(
  importer: AssimpModule,
  file: ModelImportFile,
  sidecars: readonly ModelImportFile[] = [],
): Uint8Array {
  const files = new Map<string, Uint8Array>();
  for (const sidecar of sidecars) {
    const key = basename(sidecar.name);
    if (files.has(key)) throw new Error(`Ambiguous FBX sidecar name: ${key}`);
    files.set(key, sidecar.bytes);
  }
  const result = importer.ConvertFile(file.name, "glb2", file.bytes,
    (name) => files.has(basename(name)),
    (name) => files.get(basename(name)) ?? new Uint8Array());
  try {
    if (!result.IsSuccess()) throw new Error(`FBX conversion failed (Assimp ${result.GetErrorCode()}).`);
    let glb: Uint8Array | undefined;
    for (let i = 0; i < result.FileCount(); i++) {
      const output = result.GetFile(i);
      try {
        const name = output.GetPath();
        const bytes = output.GetContent().slice();
        if (/\.glb$/i.test(name)) glb = bytes;
        else files.set(basename(name), bytes);
      } finally { output.delete(); }
    }
    const split = glb && splitGlbJsonBin(glb);
    if (!glb || !split || !Array.isArray(split.json.meshes) || !split.json.meshes.length) {
      throw new Error("FBX conversion produced no model meshes.");
    }
    // Fail visibly instead of silently dropping missing materials' image inputs.
    for (const image of (split.json.images ?? []) as { uri?: string }[]) {
      if (!image.uri || image.uri.startsWith("data:")) continue;
      const key = basename(decodeURIComponent(image.uri));
      const bytes = files.get(key);
      if (!bytes) throw new Error(`Missing FBX texture: ${image.uri}. Select its image file with the FBX.`);
      files.set(image.uri, bytes);
    }
    return ingestGltfForImport("import.glb", glb, files).bytes;
  } finally { result.delete(); }
}
