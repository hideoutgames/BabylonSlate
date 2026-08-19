import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FilesInputStore } from "@babylonjs/core/Misc/filesInputStore";
import { Scene } from "@babylonjs/core/scene";
import { OBJFileLoader } from "@babylonjs/loaders/OBJ/objFileLoader";
import { GLTF2Export } from "@babylonjs/serializers/glTF/2.0";
import { groupObjImportSidecars } from "@babylonslate/assets";

/** Node tests have Blob/File but no FileReader; Babylon MTL/OBJ file IO needs it. */
function installFileReaderPolyfill(): void {
  if (typeof globalThis.FileReader !== "undefined") return;
  class FileReaderPolyfill {
    result: string | ArrayBuffer | null = null;
    error: Error | null = null;
    onload: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
    onerror: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
    onloadend: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
    onprogress: ((ev: unknown) => void) | null = null;
    abort(): void {}
    readAsText(blob: Blob): void {
      void blob.text().then(
        (text) => {
          this.result = text;
          const ev = { target: this };
          this.onload?.(ev);
          this.onloadend?.(ev);
        },
        (error: Error) => {
          this.error = error;
          const ev = { target: this };
          this.onerror?.(ev);
          this.onloadend?.(ev);
        },
      );
    }
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then(
        (buffer) => {
          this.result = buffer;
          const ev = { target: this };
          this.onload?.(ev);
          this.onloadend?.(ev);
        },
        (error: Error) => {
          this.error = error;
          const ev = { target: this };
          this.onerror?.(ev);
          this.onloadend?.(ev);
        },
      );
    }
  }
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: FileReaderPolyfill,
  });
}

export interface ConvertObjToGlbOptions {
  engine?: AbstractEngine;
  fileName?: string;
  sidecars?: Array<{ name: string; bytes: Uint8Array }>;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function blobToBytes(value: Blob | string): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array(await value.arrayBuffer());
}

function registerSidecars(
  sidecars: Array<{ name: string; bytes: Uint8Array }>,
): string[] {
  const keys: string[] = [];
  for (const sidecar of sidecars) {
    const name = fileNameOf(sidecar.name);
    const key = name.toLowerCase();
    const copy = sidecar.bytes.slice();
    const file = new File([copy], name);
    FilesInputStore.FilesToLoad[key] = file;
    FilesInputStore.FilesToLoad[name] = file;
    keys.push(key, name);
  }
  return keys;
}

function unregisterSidecars(keys: string[]): void {
  for (const key of keys) {
    delete FilesInputStore.FilesToLoad[key];
  }
}

/** Load Wavefront OBJ (optional MTL/maps) and export a GLB for Model import. */
export async function convertObjToGlb(
  objBytes: Uint8Array,
  options: ConvertObjToGlbOptions = {},
): Promise<Uint8Array> {
  const engine = options.engine ?? new NullEngine();
  const ownsEngine = !options.engine;
  const scene = new Scene(engine);
  const fileName = fileNameOf(options.fileName ?? "import.obj");
  installFileReaderPolyfill();
  const sidecarKeys = registerSidecars([
    { name: fileName, bytes: objBytes },
    ...(options.sidecars ?? []),
  ]);
  try {
    const objText = new TextDecoder().decode(objBytes);
    const loader = new OBJFileLoader();
    const container = await loader.loadAssetContainerAsync(
      scene,
      objText,
      "file:",
    );
    container.addAllToScene();
    if (scene.meshes.length === 0) {
      throw new Error("OBJ conversion produced no meshes.");
    }
    const exported = await GLTF2Export.GLBAsync(scene, "import", {
      shouldExportNode: (node) => {
        const className = node.getClassName();
        return className === "Mesh" || className === "TransformNode";
      },
    });
    const glbFile =
      exported.glTFFiles["import.glb"] ?? Object.values(exported.glTFFiles)[0];
    if (!glbFile) {
      throw new Error("OBJ conversion did not write a GLB.");
    }
    return await blobToBytes(glbFile);
  } finally {
    unregisterSidecars(sidecarKeys);
    containerDispose(scene);
    scene.dispose();
    if (ownsEngine) engine.dispose();
  }
}

function containerDispose(scene: Scene): void {
  for (const mesh of [...scene.meshes]) mesh.dispose(false, true);
}

export function glbFileNameFromObj(objName: string): string {
  return fileNameOf(objName).replace(/\.obj$/i, ".glb");
}

/** Convert OBJ files in a picker batch to GLB; leave unrelated files as-is. */
export async function convertObjImportBatch(
  files: Array<{ name: string; bytes: Uint8Array }>,
  options: { engine?: AbstractEngine } = {},
): Promise<{
  files: Array<{ name: string; bytes: Uint8Array }>;
  errors: string[];
}> {
  const { objs, rest } = groupObjImportSidecars(files);
  const converted: Array<{ name: string; bytes: Uint8Array }> = [];
  const errors: string[] = [];
  for (const { obj, sidecars } of objs) {
    try {
      const glb = await convertObjToGlb(obj.bytes, {
        engine: options.engine,
        fileName: obj.name,
        sidecars,
      });
      converted.push({ name: glbFileNameFromObj(obj.name), bytes: glb });
    } catch (err) {
      errors.push(
        `${obj.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { files: [...converted, ...rest], errors };
}
