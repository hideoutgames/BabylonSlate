import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, createMeshComponent, normalizeScene, type SerializedScene } from "@babylonslate/core";
import { ClassRegistry, createActorFromSerialized, hydrateScenePropertyReferences, MaterialObject, World, type Actor } from "@babylonslate/object-model";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";
import { captureSimulationScene, type SimulationSceneCaptureInput, type SimulationSceneCaptureResult } from "./simulation-scene-capture";

function registry(): ClassRegistry {
  const registry = new ClassRegistry();
  registry.register({ id: "Hero", parentClassId: "Actor", kind: "actor", implementedInterfaces: [], variables: [
    { name: "Health", type: "int", defaultValue: 10 },
    { name: "Target", type: "object", typeClassId: "Actor", defaultValue: null },
    { name: "Parts", type: "object", typeClassId: "ActorComponent", container: "map", keyTypeId: "string", defaultValue: [] },
    { name: "State", type: "struct", typeClassId: "stats", defaultValue: { Score: 0, Target: null } },
    { name: "Note", type: "string", defaultValue: "" },
    { name: "Tags", type: "struct:engine:TagContainer", defaultValue: { Tags: [] } },
  ] });
  return registry;
}
function load(scene: SerializedScene): { world: World; actors: Actor[] } {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: registry() });
  const actors = scene.actors.map(row => createActorFromSerialized(world, row)!);
  hydrateScenePropertyReferences(actors);
  for (const actor of actors) world.spawnActorNow(actor);
  return { world, actors };
}
function fixture() {
  const mesh = createMeshComponent("mesh", "box");
  mesh.sourceId = "source-mesh";
  mesh.properties.materialGuid = "mat";
  const deleted = createMeshComponent("removed-part", "sphere");
  deleted.sourceId = "source-removed";
  const baseline = normalizeScene({ name: "世界", viewportMode: "3d", settings: createDefaultSceneSettings(),
    folders: [{ id: "folder", name: "Placed", parentFolderId: null }], actors: [
      createActor("hero", "Hero", { classId: "Hero", locked: true, folderId: "folder", properties: { Health: 10 }, components: [mesh, deleted] }),
      createActor("deleted", "Deleted"),
    ] });
  const { world, actors } = load(baseline);
  const materialParameters = new RuntimeMaterialParameters({ mat: { domain: "surface", planHash: "m", parameters: {
    Gain: { kind: "float", value: 1 }, Texture: { kind: "texture", textureAssetGuid: null },
  } } }, ["texture"]);
  const identity = { generation: 4, sceneAssetGuid: "root", sceneInstanceId: "instance", sceneLoadId: 1, tickIndex: 3, commandRevision: 8 };
  const input: SimulationSceneCaptureInput = { world, baseline, identity, startingScene: identity, quiescent: true, renderRevision: 8,
    sceneSettings: baseline.settings, ownership: () => "root", prefabComponents: () => [], assetExists: guid => ["mat", "texture"].includes(guid),
    materialOverrides: component => {
      const material = component.getVariable("materialObject");
      return material instanceof MaterialObject ? materialParameters.captureOverrides(material) : null;
    },
    structFields: type => type === "stats" ? [{ name: "Score", type: "int" }, { name: "Target", type: "object", typeClassId: "Actor" }] : null,
  };
  return { input, world, actors, materialParameters };
}
function complete(result: SimulationSceneCaptureResult) {
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result;
}

describe("complete simulation scene capture", () => {
  it("keeps the normalized starting scene unchanged when authorable runtime state did not change", () => {
    const { input } = fixture();
    expect(complete(captureSimulationScene(input)).scene).toEqual(input.baseline);
  });

  it("round-trips gameplay spawns, deletions, local transforms, typed references and private material values", () => {
    const { input, world, actors, materialParameters } = fixture();
    const baseline = structuredClone(input.baseline), hero = actors[0]!;
    const spawned = world.createActor({ guid: "runtime-spawn", classId: "Hero", variables: { name: "Created", parentId: hero.guid } });
    const spawnedMesh = world.createComponent({ guid: "runtime-mesh", classId: "MeshComponent", variables: { meshKind: "sphere" } });
    spawned.attachComponent(spawnedMesh); world.spawnActorNow(spawned);
    world.destroyActor("deleted"); world.tick();
    hero.components[1]!.destroyed = true;
    hero.setVariable("Health", 5);
    hero.setVariable("name", "Renamed During Play");
    hero.setVariable("Target", spawned);
    hero.setVariable("Parts", new Map([["created", spawnedMesh]]));
    hero.setVariable("State", { Score: 8, Target: spawned });
    hero.setVariable("Note", undefined);
    hero.setVariable("Tags", { Tags: [1, 2] });
    hero.transform.position.x = 12;
    spawnedMesh.transform.position.y = 2;
    const material = hero.components[0]!.getVariable("materialObject") as MaterialObject;
    expect(materialParameters.set(material, "Gain", { kind: "float", value: 0.25 })).toBe(true);
    expect(materialParameters.set(material, "Texture", { kind: "texture", textureAssetGuid: "texture" })).toBe(true);
    const result = complete(captureSimulationScene(input));
    expect(input.baseline).toEqual(baseline);
    expect(result.identity).toEqual(input.identity);
    expect(result.byteSize).toBe(new TextEncoder().encode(JSON.stringify(result.scene)).byteLength);
    expect(result.scene.actors).toHaveLength(2);
    expect(result.scene.actors[0]).toMatchObject({ id: "hero", name: "Renamed During Play", locked: true, folderId: "folder", suppressedComponentSourceIds: ["source-removed"],
      transform: { position: [12, 0, 0] }, properties: { Health: 5 }, components: [{ id: "mesh", sourceId: "source-mesh", materialInstance: {
        materialGuid: "mat", parameters: { Gain: { kind: "float", value: 0.25 }, Texture: { kind: "texture", textureAssetGuid: "texture" } },
      } }] });
    expect(result.scene.actors[1]).toMatchObject({ name: "Created", parentId: "hero", components: [{ transform: { position: [0, 2, 0] } }] });
    const reopened = load(normalizeScene(JSON.parse(JSON.stringify(result.scene))));
    const [loadedHero, loadedSpawn] = reopened.actors;
    expect(loadedHero!.getVariable("name")).toBe("Renamed During Play");
    expect(loadedHero!.getVariable("Target")).toBe(loadedSpawn);
    expect(loadedHero!.getVariable("Parts")).toEqual(new Map([["created", loadedSpawn!.components[0]]]));
    expect(loadedHero!.getVariable("State")).toEqual({ Score: 8, Target: loadedSpawn });
    expect(loadedHero!.variables.has("Note")).toBe(true);
    expect(loadedHero!.getVariable("Note")).toBeUndefined();
    expect(loadedHero!.getVariable("Tags")).toEqual({ Tags: [1, 2] });
    expect(loadedHero!.components).toHaveLength(1);
    const reloadedParameters = new RuntimeMaterialParameters({ mat: { domain: "surface", planHash: "m", parameters: {
      Gain: { kind: "float", value: 1 }, Texture: { kind: "texture", textureAssetGuid: null },
    } } }, ["texture"]);
    expect(reloadedParameters.get(loadedHero!.components[0]!.getVariable("materialObject") as MaterialObject, "Gain", "float")).toEqual({ kind: "float", value: 0.25 });
  });

  it("retains spawned component authoring fields outside the Inspector's writable whitelist", () => {
    const { input, actors, world } = fixture();
    const light = world.createComponent({ guid: "new-light", classId: "LightComponent", variables: { lightKind: "point", intensity: 6, range: 32 } });
    actors[0]!.attachComponent(light);
    const captured = complete(captureSimulationScene(input)).scene.actors[0]!.components.find(row => row.classId === "LightComponent")!;
    expect(captured.properties).toMatchObject({ lightKind: "point", intensity: 6, range: 32 });
  });

  it("fails without modifying authoring data at incomplete boundaries and unsupported ownership", () => {
    const { input } = fixture();
    const baseline = structuredClone(input.baseline);
    expect(captureSimulationScene({ ...input, quiescent: false })).toMatchObject({ ok: false, code: "boundary" });
    expect(captureSimulationScene({ ...input, renderRevision: 7 })).toMatchObject({ ok: false, code: "boundary" });
    expect(captureSimulationScene({ ...input, identity: { ...input.identity, sceneLoadId: 2 } })).toMatchObject({ ok: false, code: "ownership", reason: expect.stringContaining("transition") });
    expect(captureSimulationScene({ ...input, independentInstances: [{ kind: "stream", id: "empty-stream" }] })).toMatchObject({ ok: false, code: "ownership", path: "empty-stream" });
    expect(captureSimulationScene({ ...input, ownership: () => "layer" })).toMatchObject({ ok: false, code: "ownership" });
    expect(input.baseline).toEqual(baseline);
  });

  it("names malformed values, missing references and unsupported resources instead of dropping fields", () => {
    const { input, actors, world } = fixture();
    const hero = actors[0]!;
    hero.setVariable("Health", NaN);
    expect(captureSimulationScene(input)).toMatchObject({ ok: false, code: "value", path: "hero.properties.Health" });
    hero.setVariable("Health", 10);
    hero.setVariable("Target", world.createActor({ classId: "Actor" }));
    expect(captureSimulationScene(input)).toMatchObject({ ok: false, code: "reference", path: "hero.properties.Target" });
    hero.setVariable("Target", null);
    hero.setVariable("State", { Score: 2, Surprise: true });
    expect(captureSimulationScene(input)).toMatchObject({ ok: false, code: "value", path: "hero.properties.State.Surprise" });
    hero.setVariable("State", { Score: 0, Target: null });
    hero.components[0]!.setVariable("materialGuid", "not-authored");
    expect(captureSimulationScene(input)).toMatchObject({ ok: false, code: "resource" });
  });

  it("bounds serialized bytes and node work, and rejects duplicate runtime identities", () => {
    const { input, actors, world } = fixture();
    const result = complete(captureSimulationScene(input));
    expect(captureSimulationScene({ ...input, maxBytes: result.byteSize - 1 })).toMatchObject({ ok: false, code: "budget" });
    expect(captureSimulationScene({ ...input, maxNodes: 3 })).toMatchObject({ ok: false, code: "budget" });
    actors[0]!.setVariable("Note", "界".repeat(2048));
    expect(captureSimulationScene({ ...input, maxBytes: 4096 })).toMatchObject({ ok: false, code: "budget" });
    world.spawnActorNow(world.createActor({ guid: "hero", classId: "Actor" }));
    expect(captureSimulationScene(input)).toMatchObject({ ok: false, code: "reference", reason: expect.stringContaining("ambiguous") });
  });
});
