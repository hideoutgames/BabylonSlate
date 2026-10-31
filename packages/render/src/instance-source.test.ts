import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { hasDrawn, isRevealPending, noteDrawn } from "./reveal-pending";
import { isMeshFrameReady } from "./scene-perf";
import { probeVariantSwaps } from "./variant-swaps";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** A hidden source drawing only its instances, as a glTF node instance's or a pool's, with one instance. */
function batch() {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const source = MeshBuilder.CreateBox("source", {}, scene);
  source.material = new StandardMaterial("surface", scene);
  source.isVisible = false;
  const first = source.createInstance("first");
  return { scene, source, first };
}

it("never hides an instance that drew while its batch swaps, and reveals a new one with its actor", async () => {
  const { source, first } = batch();
  // The first instance's probe compiles the source's instanced variant, which the batch then draws.
  await vi.waitFor(() => expect(first.isReady(true)).toBe(true));
  noteDrawn(first);
  expect(source.subMeshes[0]!.effect?.isReady()).toBe(true);
  // A new variant still compiling (a light added): the batch keeps drawing its previous Effect from the source's
  // submeshes. The instance that drew waits for the swap, shown, as a drawn mesh does.
  vi.spyOn(source.material!, "isReadyForSubMesh").mockReturnValue(false);
  expect(probeVariantSwaps(true, () => isMeshFrameReady(first))).toBe(false);
  expect(isRevealPending(first)).toBe(false);
  // A new instance is hidden until its actor's round reveals it with the actor's other meshes.
  const spawned = source.createInstance("spawned");
  expect(probeVariantSwaps(true, () => isMeshFrameReady(spawned))).toBe(true);
  expect(isRevealPending(spawned)).toBe(true);
});

it("counts an instance drawn when its source has drawn with its Material", () => {
  const { source, first } = batch();
  expect(hasDrawn(first)).toBe(false);
  noteDrawn(source);
  expect(hasDrawn(first)).toBe(true);
  // A new Material is a new first draw for the whole batch.
  source.material = new StandardMaterial("other", source.getScene());
  expect(hasDrawn(first)).toBe(false);
});
