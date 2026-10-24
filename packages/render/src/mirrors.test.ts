import { Constants, FreeCamera, MeshBuilder, NullEngine, RenderTargetTexture, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { parseMirrorProperties } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createMirrorSurfaceMesh, mirrorDiagnostics } from "./mirrors";
import { mirrorReflectionBinding } from "./mirror-surface-state";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });

/** NullEngine has no GPU: keep the real owner, leases, cameras and targets; record each mirror pass instead of drawing. */
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine does not record the allocator's format metadata the ledger reconciles.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const passes: { target: string; meshes: string[]; eye: Vector3 }[][] = [];
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockReturnValue(true);
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    passes.at(-1)!.push({ target: this.name, meshes: (this.renderList ?? []).map((mesh) => mesh.name), eye: this.activeCamera!.globalPosition.clone() });
  });
  const scene = new Scene(engine);
  const camera = new FreeCamera("View", new Vector3(0, 1, 0), scene);
  camera.setTarget(new Vector3(0, 1, 10));
  const frame = () => {
    passes.push([]);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    return passes.at(-1)!.map((pass) => pass.target);
  };
  return { scene, camera, passes, frame };
}

function mirror(scene: Scene, name: string, at: Vector3, yaw = 0) {
  const mesh = createMirrorSurfaceMesh(scene, name, parseMirrorProperties({ width: 2, height: 2 }));
  mesh.position.copyFrom(at);
  mesh.rotation.y = yaw;
  return mesh;
}

it("draws at most two visible, facing mirrors per render, an imageless one first, and the rest keep their image", () => {
  const { scene, passes, frame } = host();
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, scene);
  box.position.set(0, 1, 1.5);
  mirror(scene, "near", new Vector3(0, 1, 3));
  mirror(scene, "middle", new Vector3(-2, 1, 5));
  const far = mirror(scene, "far", new Vector3(2, 1, 8));
  // Its reflective side faces away from the eye, and the last one is behind the view.
  mirror(scene, "turned away", new Vector3(0, 1, 4.5), Math.PI);
  mirror(scene, "behind the view", new Vector3(0, 1, -4), Math.PI);

  expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
  expect(frame()).toEqual(["mirror:far", "mirror:near"]);
  expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
  // Skipped this render, the far mirror still shows its first reflection.
  expect(mirrorReflectionBinding(far)?.texture).not.toBeNull();
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 5, targets: 3, lastRenderDraws: 2 });

  // Each pass sees the scene from the eye reflected through its mirror and never draws a mirror surface.
  const near = passes[0]![0]!;
  expect(near.eye.subtract(new Vector3(0, 1, 6)).length()).toBeLessThan(1e-6);
  expect(near.meshes).toContain("box");
  for (const pass of passes.flat()) expect(pass.meshes.filter((name) => name !== "box")).toEqual([]);
});

it("hides a disabled mirror and frees a removed mirror's reflection", () => {
  const { scene, frame } = host();
  const disabled = createMirrorSurfaceMesh(scene, "disabled", parseMirrorProperties({ enabled: false }));
  disabled.position.set(0, 1, 3);
  const removed = mirror(scene, "removed", new Vector3(0, 1, 4));
  expect(disabled.isEnabled()).toBe(false);
  expect(frame()).toEqual(["mirror:removed"]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 2, targets: 1 });
  removed.dispose();
  expect(frame()).toEqual([]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 1, targets: 0 });
});

it("restores the built-in surface when a Material override is cleared", () => {
  const { scene } = host();
  const mesh = mirror(scene, "mirror", new Vector3(0, 1, 3));
  const builtIn = mesh.material;
  mesh.material = null;
  expect(mesh.material).toBe(builtIn);
});

it("compiles a Mirror Reflection Material that reads the reflection on a Mirror surface and nothing elsewhere", async () => {
  const { scene, frame } = host();
  const doc = createDefaultMaterialDocument();
  doc.shadingModel = "unlit";
  doc.nodes.push({ id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: {} });
  doc.edges = [{ id: "reflection-output", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "output", targetPinId: "baseColor" }];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "mirror-override" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const surface = mirror(scene, "mirror", new Vector3(0, 1, 3));
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, scene);
  box.position.set(0, 1, 1.5);
  for (const mesh of [surface, box]) {
    mesh.material = compiled.material;
    await compiled.material.forceCompilationAsync(mesh);
  }
  expect(frame()).toEqual(["mirror:mirror"]);
  const reflection = mirrorReflectionBinding(surface)!.texture;
  expect(reflection).not.toBeNull();
  const sampled = (mesh: typeof box) => {
    const subMesh = mesh.subMeshes[0]!;
    const textures = vi.spyOn(subMesh.effect!, "setTexture");
    scene.resetCachedMaterial();
    compiled.material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, subMesh);
    return { defines: subMesh.materialDefines!.toString(), textures: textures.mock.calls.map(([, texture]) => texture) };
  };
  const onSurface = sampled(surface), elsewhere = sampled(box);
  expect(onSurface.defines).toContain("SLATE_MIRROR_REFLECTION");
  expect(onSurface.textures).toContain(reflection);
  expect(elsewhere.defines).not.toContain("SLATE_MIRROR_REFLECTION");
  expect(elsewhere.textures).not.toContain(reflection);
  compiled.dispose();
});
