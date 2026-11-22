import { describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  encodeLandscapeBase64,
  encodeLandscapeChunk,
  landscapeChunkId,
  parseLandscapeProperties,
  type SaveGameStorage,
  type SerializedComponent,
  type SerializedScene,
} from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import type { Actor } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";

/** A 4 x 4 cell terrain 8 m across standing `height` metres up everywhere. */
function plateau(height: number) {
  return parseLandscapeProperties({ width: 8, depth: 8, subdivisions: 4, heights: new Float32Array(25).fill(height), collisionsEnabled: true });
}

/** A Landscape row as a saved Scene holds it: metadata and the id of its chunk, no terrain. */
function chunkedLandscape(id: string): SerializedComponent {
  return { id, classId: "LandscapeComponent", properties: { width: 8, depth: 8, subdivisions: 4, chunkId: landscapeChunkId(id), materialGuid: null, collisionsEnabled: true } };
}

function terrainOf(actor: Actor | undefined) {
  const component = actor?.components.find((entry) => entry.classId === "LandscapeComponent");
  return { heights: component?.getVariable("heights"), data: component?.getVariable("data"), chunkId: component?.getVariable("chunkId") };
}

class MemoryStorage implements SaveGameStorage {
  readonly files = new Map<string, string>();
  async read(key: string) { return this.files.get(key) ?? null; }
  async write(key: string, text: string) { this.files.set(key, text); }
  async remove(key: string) { this.files.delete(key); }
  async list(prefix: string) { return [...this.files.keys()].filter((key) => key.startsWith(prefix)); }
  async withLock<T>(_key: string, operation: () => Promise<T>) { return operation(); }
}

describe("Landscape terrain on every runtime actor", () => {
  it("decodes a streamed Scene's terrain from its own chunks, not another Scene's with the same chunk id", async () => {
    // A duplicated Scene keeps its component ids, so the parent and the streamed child name the same chunk.
    const commands: CommandMessage[] = [];
    const child: SerializedScene = { ...createDefaultScene(), name: "Child", actors: [createActor("hill", "Hill", { components: [chunkedLandscape("terrain")] })] };
    const parent: SerializedScene = { ...createDefaultScene(), actors: [
      createActor("hill", "Hill", { components: [chunkedLandscape("terrain")] }),
      createActor("marker", "Marker", { classId: "SceneStreamingActor", components: [
        { id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: "child", sceneName: "Child" } }] }),
    ] };
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: parent, playSceneGuid: "parent",
      sceneLibrary: { child }, deferSceneModelsReady: true, onCommand: (command) => commands.push(command),
      sceneLandscapeBytes: {
        [`parent:${landscapeChunkId("terrain")}`]: encodeLandscapeChunk(plateau(1)),
        [`child:${landscapeChunkId("terrain")}`]: encodeLandscapeChunk(plateau(7)),
      } });
    try {
      await runtime.realizePlayWorld();
      runtime.notifySceneModelsReady("parent", 1);
      runtime.start();
      const marker = runtime.getWorld().findActor("marker")!;
      const loading = runtime.loadSceneStream(marker);
      await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneStreamRealized")).toBe(true));
      const realized = commands.find((command): command is Extract<CommandMessage, { type: "sceneStreamRealized" }> => command.type === "sceneStreamRealized")!;
      runtime.notifySceneStreamReady(realized.actorGuid, realized.streamLoadId);
      await loading;
      const hills = runtime.getWorld().getActors().filter((actor) => actor.getVariable("name") === "Hill");
      expect(hills).toHaveLength(2);
      const heights = hills.map((actor) => (terrainOf(actor).heights as Float32Array)[12]).sort();
      expect(heights).toEqual([1, 7]);
      expect(terrainOf(runtime.getWorld().findActor("hill")).heights).toEqual(plateau(1).heights);
    } finally { runtime.stop(); }
  });

  it("decodes a spawned Class's inline terrain once, with collision", async () => {
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: createDefaultScene(), playSceneGuid: "level" });
    try {
      await runtime.loadScripts([{ assetGuid: "island-class", classId: "Island", parentClassId: "Actor", anchors: [], entryPoints: [], source: "",
        components: [{ id: "terrain", classId: "LandscapeComponent", properties: { width: 8, depth: 8, subdivisions: 4,
          data: encodeLandscapeBase64(plateau(3)), materialGuid: null, collisionsEnabled: true } }] }]);
      await runtime.realizePlayWorld();
      runtime.start();
      const island = runtime.spawnScriptedActor({ classId: "Island" })!;
      expect(island).not.toBeNull();
      const terrain = terrainOf(island);
      expect(terrain.heights).toBeInstanceOf(Float32Array);
      expect((terrain.heights as Float32Array)[12]).toBe(3);
      expect(terrain.data).toBeUndefined();
      runtime.tick();
      const hit = runtime.getPhysicsSync()!.lineTrace({ x: 0.5, y: 10, z: 0.5 }, { x: 0.5, y: -10, z: 0.5 });
      expect(hit.hit).toBe(true);
      expect(hit.location!.y).toBeCloseTo(3, 5);
    } finally { runtime.stop(); }
  });

  it("restores a destroyed Scene Landscape from a Save Game with its terrain and collision", async () => {
    const scene: SerializedScene = { ...createDefaultScene(), actors: [createActor("island", "Island", { components: [
      chunkedLandscape("terrain"),
      { id: "save", classId: "SaveGameComponent", properties: { saveTransform: true } },
    ] })] };
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: scene, playSceneGuid: "level",
      sceneLandscapeBytes: { [`level:${landscapeChunkId("terrain")}`]: encodeLandscapeChunk(plateau(5)) } });
    const service = runtime.configureSaveGame({ projectId: "project", storage: new MemoryStorage(),
      definition: { id: "progress", schemaVersion: 1, fields: [] } });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      expect((await service.saveGame()).ok).toBe(true);
      runtime.getWorld().destroyActor("island");
      runtime.getWorld().flushPending();
      expect(runtime.getWorld().findActor("island")).toBeUndefined();
      expect((await service.loadGame()).ok).toBe(true);
      const restored = runtime.getWorld().findActor("island");
      expect((terrainOf(restored).heights as Float32Array | undefined)?.[12]).toBe(5);
      runtime.tick();
      const hit = runtime.getPhysicsSync()!.lineTrace({ x: 0.5, y: 10, z: 0.5 }, { x: 0.5, y: -10, z: 0.5 });
      expect(hit.location?.y).toBeCloseTo(5, 5);
    } finally { runtime.stop(); }
  });

  it("warns and plays flat when a Landscape's chunk is missing or damaged", async () => {
    const commands: CommandMessage[] = [];
    const scene: SerializedScene = { ...createDefaultScene(), actors: [
      createActor("lost", "Lost", { components: [chunkedLandscape("missing")] }),
      createActor("broken", "Broken", { components: [chunkedLandscape("damaged")] }),
    ] };
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: scene, playSceneGuid: "level",
      onCommand: (command) => commands.push(command),
      sceneLandscapeBytes: { [`level:${landscapeChunkId("damaged")}`]: encodeLandscapeChunk(plateau(2)).slice(0, 40) } });
    try {
      await runtime.realizePlayWorld();
      const warnings = commands.filter((command) => command.type === "log" && command.severity === "warning" && command.message.includes("Landscape terrain"));
      expect(warnings.map((command) => command.type === "log" && command.message.split(":")[0])).toEqual(["Lost (lost)", "Broken (broken)"]);
      for (const id of ["lost", "broken"]) {
        const terrain = terrainOf(runtime.getWorld().findActor(id));
        expect((terrain.heights as Float32Array).every((height) => height === 0)).toBe(true);
        expect(terrain.chunkId).toBeUndefined();
      }
    } finally { runtime.stop(); }
  });
});
