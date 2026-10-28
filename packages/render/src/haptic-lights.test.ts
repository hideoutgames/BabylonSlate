import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Color3,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type Mesh,
  type NodeMaterial,
} from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { HAPTIC_LIGHT_MAXIMUM, hapticLightBuffer, setHapticLighting } from "./haptic-lights";
import { compileMaterialPlan } from "./material-compiler";
import { syncSceneLighting } from "./scene-lighting";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A NullEngine Scene that reports uniform buffers, as WebGL2 does. */
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  return { engine, scene };
}

async function litBox(scene: Scene): Promise<{ mesh: Mesh; material: NodeMaterial }> {
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("Invalid fixture");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = compiled.material;
  return { mesh, material: compiled.material };
}

/** The defines of the Effect `material` draws `mesh` with, after a lighting sync and a frame. */
async function drawnDefines(scene: Scene, mesh: Mesh, material: NodeMaterial): Promise<string[]> {
  syncSceneLighting(scene);
  await material.forceCompilationAsync(mesh);
  scene.render();
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
  return mesh.subMeshes[0]!.effect!.defines.split("\n").filter((line) => /HAPTIC_LIGHTS|#define LIGHT\d|SPECULARTERM|MAXLIGHTCOUNT/.test(line));
}

describe("the HapticLights spike", () => {
  it("draws PBR graphs from the light block, whose defines no light change alters", async () => {
    const { engine, scene } = host();
    new PointLight("lamp", new Vector3(0, 2, 0), scene);
    const { mesh, material } = await litBox(scene);
    // Off: Babylon's per-light path.
    expect(await drawnDefines(scene, mesh, material)).toEqual(expect.arrayContaining(["#define LIGHT0"]));
    expect(material.compiledShaders).toContain("#ifdef HAPTIC_LIGHTS");

    setHapticLighting(engine, "all");
    const haptic = await drawnDefines(scene, mesh, material);
    expect(haptic).toEqual(expect.arrayContaining(["#define HAPTIC_LIGHTS", "#define SPECULARTERM"]));
    expect(haptic.some((line) => /#define LIGHT\d/.test(line))).toBe(false);
    expect(material.maxSimultaneousLights).toBe(0);
    const effect = mesh.subMeshes[0]!.effect;
    // Lights arriving, leaving and switching keep the Effect.
    new SpotLight("spot", new Vector3(1, 3, 0), Vector3.Down(), Math.PI / 3, 2, scene);
    new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
    scene.lights[0]!.setEnabled(false);
    expect(await drawnDefines(scene, mesh, material)).toEqual(haptic);
    expect(mesh.subMeshes[0]!.effect).toBe(effect);

    setHapticLighting(engine, null);
    expect(await drawnDefines(scene, mesh, material)).toEqual(expect.arrayContaining(["#define LIGHT0"]));
  });

  it("writes the Scene's lights as records, the first hemispheric light as the fill", async () => {
    const { engine, scene } = host();
    setHapticLighting(engine, "all");
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    fill.diffuse = new Color3(0.5, 0.5, 1);
    fill.groundColor = new Color3(0.2, 0.1, 0);
    fill.intensity = 2;
    new HemisphericLight("second fill", Vector3.Up(), scene);
    const sun = new DirectionalLight("sun", new Vector3(0, -2, 0), scene);
    sun.intensity = 3;
    const lamp = new PointLight("lamp", new Vector3(1, 2, 3), scene);
    lamp.range = 7;
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), new Vector3(0, -2, 0), Math.PI / 2, 2, scene);
    spot.range = 9;
    new PointLight("dark", new Vector3(0, 0, 0), scene).intensity = 0;
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string, length: number) => [...buffer._bufferData.subarray(buffer._uniformLocations[name]!, buffer._uniformLocations[name]! + length)];
    expect(read("hapticCounts", 4)).toEqual([1, 1, 1, 1]);
    expect(read("hapticFillSky", 3)).toEqual([1, 1, 2]);
    expect(read("hapticFillGround", 3).map((value) => Math.round(value * 10) / 10)).toEqual([0.4, 0.2, 0]);
    expect(read("hapticDirectional", 8)).toEqual([0, -2, 0, sun.radius, 3, 3, 3, 0].map(Math.fround));
    expect(read("hapticPoint", 8)).toEqual([1, 2, 3, lamp.radius, 1, 1, 1, 7].map(Math.fround));
    expect(read("hapticSpot", 12).map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 4, 0, 0, 0, -1, 0, 0.707, 1, 1, 1, 9]);
    expect(HAPTIC_LIGHT_MAXIMUM.point).toBeGreaterThan(0);
  });
});
