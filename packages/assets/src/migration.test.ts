import { describe, expect, it } from "vitest";
import { SCENE_SCHEMA_VERSION } from "@babylonslate/core";
import { createDefaultMigrationRegistry } from "./migration";
import { loadPayloadWithMigration } from "./migrate-on-load";

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
});

describe("Audio schema versions", () => {
  it("registers Audio mixer, channel, and attenuation at version 1", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("Audio")).toBe(1);
    expect(registry.currentVersion("AudioMixer")).toBe(1);
    expect(registry.currentVersion("AudioChannel")).toBe(1);
    expect(registry.currentVersion("SoundAttenuation")).toBe(1);
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
