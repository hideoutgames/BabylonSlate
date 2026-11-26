import { afterEach, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { waterVariantBase } from "./material-compiler";
import { createWaterMesh, isBuiltInWaterMesh } from "./water-mesh";
import { builtInWaterMaterial } from "./water-template";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

it("compiles built-in water reading the Material record and shares it across water meshes", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const material = builtInWaterMaterial(scene);
  const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30 }), createDefaultWaterDefinition(), material);
  expect(waterVariantBase(lake.material)).toBe(material);
  expect(isBuiltInWaterMesh(lake)).toBe(true);
  await vi.waitFor(() => expect((material as NodeMaterial).compiledShaders).toContain("uniform HapticMaterial"));
});
