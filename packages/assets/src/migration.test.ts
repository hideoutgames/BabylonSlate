import { describe, expect, it } from "vitest";
import { SCENE_SCHEMA_VERSION, normalizeScene } from "@babylonslate/core";
import { createDefaultMigrationRegistry } from "./migration";
import { loadPayloadWithMigration } from "./migrate-on-load";

describe("Data asset schema versions", () => {
  it("migrates unversioned data without dropping values and refuses future schemas", () => {
    const registry = createDefaultMigrationRegistry();
    const object = registry.migrate("DataObject", 0, { structureGuid: "weapon", values: { Legacy: "keep", Damage: 10 } });
    expect(object).toMatchObject({ migrated: true, version: 1, payload: {
      kind: "dataObject", structureGuid: "weapon", values: { Legacy: "keep", Damage: 10 },
    } });
    expect(registry.migrate("DataSheet", 0, { structureGuid: "weapon", objectGuids: ["sword", "sword", "shield"] }).payload)
      .toEqual({ kind: "dataSheet", structureGuid: "weapon", objectGuids: ["sword", "shield"] });
    expect(registry.migrate("DataObject", 1, object.payload).migrated).toBe(false);
    expect(() => registry.migrate("DataSheet", 2, {})).toThrow(/newer engine version/);
  });
});

describe("Scene schema version", () => {
  it("matches SCENE_SCHEMA_VERSION so newly created scenes can load", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("Scene")).toBe(SCENE_SCHEMA_VERSION);
  });

  it("loads a Scene at the current schema version without pending migration", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "Scene",
      version: SCENE_SCHEMA_VERSION,
      payload: { name: "New", actors: [] },
      path: "assets/NewAsset.scene.babasset",
    });
    expect(loaded.pending).toBeNull();
    expect(loaded.version).toBe(SCENE_SCHEMA_VERSION);
    expect(loaded.payload.name).toBe("New");
  });

  it("migrates a Scene v2 document up to the current schema", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "Scene",
      version: 2,
      payload: {
        name: "Legacy",
        viewportMode: "3d",
        actors: [],
      },
      path: "assets/legacy.scene.babasset",
    });
    expect(loaded.version).toBe(SCENE_SCHEMA_VERSION);
    expect(loaded.pending).not.toBeNull();
    expect(loaded.payload.name).toBe("Legacy");
  });
  it("migrates legacy shadow capacity once and preserves a subsequently reset mode", () => {
    const registry = createDefaultMigrationRegistry();
    const migrated = registry.migrate("Scene", 3, {
      settings: { shadowOverrides: { maxLocalLights: 0, enabled: false } },
      actors: [],
    });
    const scene = normalizeScene(migrated.payload);
    expect(scene.settings.shadowOverrides).toEqual({
      maxLocalLights: 0,
      enabled: false,
      localLightMode: "manual",
    });
    delete scene.settings.shadowOverrides!.localLightMode;
    const reopened = registry.migrate(
      "Scene",
      migrated.version,
      JSON.parse(JSON.stringify(scene)),
    );
    expect(normalizeScene(reopened.payload).settings.shadowOverrides).toEqual({
      maxLocalLights: 0,
      enabled: false,
    });
    expect(registry.migrate("Scene", 3, { settings: {} }).payload).toEqual({
      settings: {},
    });
  });
});

describe("Audio schema versions", () => {
  it("registers Audio mixer, channel, and attenuation at version 1", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("Audio")).toBe(1);
    expect(registry.currentVersion("AudioMixer")).toBe(1);
    expect(registry.currentVersion("AudioChannel")).toBe(1);
    expect(registry.currentVersion("SoundAttenuation")).toBe(1);
    expect(registry.currentVersion("ParticleEmitter")).toBe(1);
    expect(registry.currentVersion("ParticleGraph")).toBe(1);
    expect(registry.currentVersion("ParticleSystem")).toBe(1);
    expect(registry.currentVersion("SceneLayer")).toBe(1);
  });

  it("loads current AudioMixer payloads without a pending migration", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "AudioMixer",
      version: 1,
      payload: { globalVolume: 0.5, channels: [] },
      path: "assets/Master.mixer.babasset",
    });
    expect(loaded.pending).toBeNull();
    expect(loaded.version).toBe(1);
    expect(loaded.payload.globalVolume).toBe(0.5);
  });
});

describe("ParticleGraph schema version", () => {
  it("loads a v1 Particle Graph without a save prompt", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "ParticleGraph",
      version: 1,
      payload: {
        schemaVersion: 1,
        name: "Embers",
        materialGuid: "mat-1",
        nodes: [{ id: "create", type: "particle.create", position: { x: 4, y: 8 }, properties: {} }],
        edges: [],
      },
      path: "assets/Embers.particlegraph.babasset",
    });
    expect(loaded.pending).toBeNull();
    expect(loaded.version).toBe(1);
  });

  it("normalizes an unversioned payload into a graph with its Emitter Output", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "ParticleGraph",
      version: 0,
      payload: {},
      path: "assets/Embers.particlegraph.babasset",
    });
    expect(loaded.version).toBe(1);
    expect(loaded.pending).not.toBeNull();
    expect(loaded.payload.nodes).toEqual([
      expect.objectContaining({ type: "particle.output" }),
    ]);
  });
});
