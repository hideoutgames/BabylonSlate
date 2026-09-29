/** Test-build-only pixel proof of Text Material coverage on both GPU backends. */
import { Camera, Color4, Engine, FreeCamera, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { createAppWebGpuEngine, createText2DMesh, refreshText2DMaterials, MaterialLibrary, ResourceCache } from "@babylonslate/render";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

export async function runTextMaterialProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: false });
  engine.setSize(128, 128);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Text Camera", new Vector3(0, 0, -2), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -1;
  camera.orthoRight = camera.orthoTop = 1;
  scene.activeCamera = camera;
  const library = new MaterialLibrary();
  const cache = new ResourceCache();
  const materialDocument = createDefaultMaterialDocument("Text Fill", "text");
  materialDocument.nodes[0]!.properties = { "default:color": [0, 1, 1, 1] };
  const acquired = library.acquire(scene, "text", materialDocument);
  if (acquired.ok === false) throw new Error(JSON.stringify(acquired.diagnostics));
  const diagnostics = await acquired.ready;
  if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
  let authored = false;
  const captures: Array<{ renderer: string; before: number[]; after: number[] }> = [];
  const pixelFormat = backend === "webgpu" ? (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() : "rgba8unorm";
  const capture = async (mesh: Mesh) => {
    await scene.whenReadyAsync();
    for (const glyph of mesh.getChildMeshes()) if (glyph.material) await glyph.material.forceCompilationAsync(glyph as Mesh);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    const view = await engine.readPixels(0, 0, 128, 128);
    const data = Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    if (pixelFormat.startsWith("bgra")) for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2]!, data[i]!];
    return data;
  };
  try {
    // Numeric MSDF coverage fixture: one half zero, one half one; no artwork.
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = 32;
    const context = atlas.getContext("2d")!;
    context.fillStyle = "black"; context.fillRect(0, 0, 32, 32);
    context.fillStyle = "white"; context.fillRect(16, 0, 16, 32);
    const png = await new Promise<Blob>((resolve, reject) => atlas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Atlas encoding failed")), "image/png"));
    const json = new TextEncoder().encode(JSON.stringify({ info: { size: 100 }, common: { scaleW: 32, scaleH: 32 },
      chars: [{ id: 65, x: 0, y: 0, width: 32, height: 32, xoffset: 0, yoffset: 0, xadvance: 40 }] }));
    for (const renderer of ["bitmap", "msdf"] as const) {
      authored = false;
      const assets = { resourceCache: cache, fontMsdfJson: new Map([["font", json]]), fontMsdfPng: new Map([["font", png]]),
        resolveMaterial: () => authored ? acquired.material : null };
      const mesh = createText2DMesh(scene, renderer, { text: "[color=FFFF00]AA[/color]", renderer, fontAssetGuid: "font",
        materialGuid: "text", size: 100, wrapWidth: 200, wrapHeight: 200, alignment: "center" }, assets, { rich: true });
      const before = await capture(mesh);
      authored = true;
      refreshText2DMaterials(mesh, assets);
      acquired.material.freeze();
      const after = await capture(mesh);
      captures.push({ renderer, before, after });
      mesh.dispose();
    }
    const materialsBeforeRelease = scene.materials.length;
    library.dispose();
    cache.dispose();
    return { backend, captures, releasedMaterials: materialsBeforeRelease - scene.materials.length };
  } finally {
    library.dispose(); cache.dispose(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}
