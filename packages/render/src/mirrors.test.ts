import { Color3, Constants, DirectionalLight, FreeCamera, MeshBuilder, NullEngine, RenderTargetTexture, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
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
  // A draw made before the scene's first render placed its meshes is drawn once more; then the static view draws
  // nothing, and every mirror keeps its image.
  expect(frame()).toEqual(["mirror:middle"]);
  expect(frame()).toEqual([]);
  // Skipped this render, the far mirror still shows its first reflection.
  expect(mirrorReflectionBinding(far)?.texture).not.toBeNull();
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 5, targets: 3, draws: 5 });

  // Each pass sees the scene from the eye reflected through its mirror and never draws a mirror surface.
  const near = passes[0]![0]!;
  expect(near.eye.subtract(new Vector3(0, 1, 6)).length()).toBeLessThan(1e-6);
  expect(near.meshes).toContain("box");
  for (const pass of passes.flat()) expect(pass.meshes.filter((name) => name !== "box")).toEqual([]);
});

/** A static view of one mirror reflecting a box, its first draw settled. */
function settledMirror() {
  const view = host();
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, view.scene);
  box.position.set(0, 1, 1.5);
  const surface = mirror(view.scene, "mirror", new Vector3(0, 1, 3));
  /** Mirror draws over `renders` more renders. */
  const drawsOver = (renders: number) => {
    let draws = 0;
    for (let i = 0; i < renders; i++) draws += view.frame().length;
    return draws;
  };
  expect(drawsOver(4)).toBe(2);
  return { ...view, box, surface, drawsOver };
}

it("keeps a static view's reflection instead of drawing it again, and redraws it on every render while the view moves", () => {
  const { scene, camera, surface, passes, drawsOver } = settledMirror();
  const image = mirrorReflectionBinding(surface)!.texture;
  expect(drawsOver(20)).toBe(0);
  expect(mirrorReflectionBinding(surface)!.texture).toBe(image);
  expect(mirrorDiagnostics(scene)).toMatchObject({ draws: 2, reuses: 22 });
  for (let i = 0; i < 4; i++) {
    camera.position.x += 0.1;
    expect(drawsOver(1)).toBe(1);
    // Each draw sees the scene from the moved eye reflected through the mirror.
    expect(passes.at(-1)![0]!.eye.x).toBeCloseTo(camera.position.x, 6);
  }
  expect(drawsOver(10)).toBe(0);
});

it("redraws a static view's reflection once when what it reflects changes, then keeps it again", () => {
  const { scene, box, drawsOver } = settledMirror();
  box.position.x += 0.1;
  expect(drawsOver(10)).toBe(1);
  box.isVisible = false;
  expect(drawsOver(10)).toBe(1);
  box.isVisible = true;
  expect(drawsOver(10)).toBe(1);
  const paint = new StandardMaterial("paint", scene);
  box.material = paint;
  expect(drawsOver(10)).toBe(1);
  paint.diffuseColor = new Color3(1, 0, 0);
  expect(drawsOver(10)).toBe(1);
  const sun = new DirectionalLight("sun", new Vector3(0, -1, 0.5), scene);
  expect(drawsOver(10)).toBe(1);
  sun.intensity = 2;
  expect(drawsOver(10)).toBe(1);
  scene.fogMode = Scene.FOGMODE_EXP;
  expect(drawsOver(10)).toBe(1);
  // Something the pass does not draw changes nothing: a mesh behind the mirror, past its plane, once its first render
  // has settled where it is.
  const behind = MeshBuilder.CreateBox("behind", { size: 0.5 }, scene);
  behind.position.set(0, 1, 20);
  drawsOver(10);
  behind.position.y += 1;
  behind.material = paint;
  expect(drawsOver(10)).toBe(0);
});

it("redraws a reflection on every render while a time-driven Material it reflects animates", async () => {
  const { scene, box, drawsOver } = settledMirror();
  const doc = createDefaultMaterialDocument("pulse");
  doc.nodes.push(
    { id: "time", type: "input.time", position: { x: 0, y: 0 }, properties: {} },
    { id: "sin", type: "math.sin", position: { x: 0, y: 0 }, properties: {} },
    { id: "combine", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges.push(
    { id: "time-sin", sourceNodeId: "time", sourcePinId: "time", targetNodeId: "sin", targetPinId: "value" },
    { id: "sin-combine", sourceNodeId: "sin", sourcePinId: "out", targetNodeId: "combine", targetPinId: "y" },
    { id: "combine-emissive", sourceNodeId: "combine", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "emissive" },
  );
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "pulse" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  box.material = compiled.material;
  await compiled.material.forceCompilationAsync(box);
  expect(drawsOver(10)).toBe(10);
  // Back on a still graph Material, it draws the change once and keeps its image.
  const stillPlan = lowerMaterialDocument(createDefaultMaterialDocument("still"));
  if (!stillPlan.ok) throw new Error(JSON.stringify(stillPlan.diagnostics));
  const still = compileMaterialPlan(stillPlan.plan, { scene, name: "still" });
  if (!still.ok) throw new Error(JSON.stringify(still.diagnostics));
  expect(await still.ready).toEqual([]);
  box.material = still.material;
  await still.material.forceCompilationAsync(box);
  expect(drawsOver(10)).toBe(1);
  expect(drawsOver(10)).toBe(0);
  compiled.dispose();
  still.dispose();
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
