import { afterEach, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { waterVariantBase } from "./material-compiler";
import { createWaterMesh, isBuiltInWaterMesh } from "./water-mesh";
import { builtInWaterMaterial, recompileBuiltInWaterMaterial } from "./water-template";
import { setSceneWorldDebug } from "./world-debug";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

it("compiles built-in water again when the Material record is switched and moves its water meshes to the new build", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const previous = builtInWaterMaterial(scene);
  const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30 }), createDefaultWaterDefinition(), previous);
  expect(waterVariantBase(lake.material)).toBe(previous);

  setSceneWorldDebug(scene, "materialrecords", true);
  const switching = recompileBuiltInWaterMaterial(scene);
  // Until the new build is ready, the old one draws.
  expect(builtInWaterMaterial(scene)).toBe(previous);
  await switching;
  const recorded = builtInWaterMaterial(scene);
  expect(recorded).not.toBe(previous);
  expect(waterVariantBase(lake.material)).toBe(recorded);
  expect(isBuiltInWaterMesh(lake)).toBe(true);
  expect(scene.materials.includes(previous)).toBe(false);
  expect((recorded as NodeMaterial).compiledShaders).toContain("uniform HapticMaterial");

  setSceneWorldDebug(scene, "materialrecords", false);
  await recompileBuiltInWaterMaterial(scene);
  const plain = builtInWaterMaterial(scene);
  expect([plain === recorded, waterVariantBase(lake.material) === plain, scene.materials.includes(recorded)]).toEqual([false, true, false]);
  expect(plain.compiledShaders).not.toContain("HapticMaterial");
});
