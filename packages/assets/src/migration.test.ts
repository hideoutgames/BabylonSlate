import { describe, expect, it } from "vitest";
import { SCENE_SCHEMA_VERSION } from "@babylonslate/core";
import {
  AssetFormatVersionError,
  MATERIAL_PAYLOAD_VERSION,
  MigrationRegistry,
  createDefaultMigrationRegistry,
  type MigrationFn,
} from "./migration";
import { loadPayloadWithMigration } from "./migrate-on-load";

const appendStep =
  (step: number): MigrationFn =>
  (payload) => ({ ...payload, steps: [...(payload.steps as number[]), step] });

function registryWithSteps(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({
    type: "Thing",
    currentVersion: 3,
    migrations: [appendStep(2), appendStep(3)],
  });
  return registry;
}

describe("migration harness", () => {
  it("runs registered steps in order and reports the pending save", () => {
    const loaded = loadPayloadWithMigration(registryWithSteps(), {
      type: "Thing",
      version: 1,
      payload: { steps: [] },
      path: "assets/Thing.babasset",
    });
    expect(loaded.payload).toEqual({ steps: [2, 3] });
    expect(loaded.version).toBe(3);
    expect(loaded.pending).toEqual({
      type: "Thing",
      fromVersion: 1,
      toVersion: 3,
      path: "assets/Thing.babasset",
    });
    expect(registryWithSteps().migrate("Thing", 2, { steps: [] })).toEqual({
      version: 3,
      payload: { steps: [3] },
      migrated: true,
    });
  });

  it("refuses versions before its first step and after its current version", () => {
    const registry = registryWithSteps();
    expect(() => registry.migrate("Thing", 0, { steps: [] })).toThrow(
      /version 0 uses an unsupported old format/,
    );
    expect(() => registry.migrate("Thing", 4, { steps: [] })).toThrow(
      /newer engine version/,
    );
    expect(() =>
      new MigrationRegistry().register({
        type: "Broken",
        currentVersion: 1,
        migrations: [appendStep(1), appendStep(2)],
      }),
    ).toThrow(/cannot follow 2 migration steps/);
  });
});

describe("default migration registry", () => {
  it("refuses every older stored version instead of upgrading it", () => {
    const registry = createDefaultMigrationRegistry();
    const old = [
      ["Class", 0],
      ["Scene", 0],
      ["Scene", SCENE_SCHEMA_VERSION - 1],
      ["Material", MATERIAL_PAYLOAD_VERSION - 1],
      ["Project", 0],
      ["DataTree", 0],
      ["Audio", 0],
      ["ParticleSystem", 0],
    ] as const;
    for (const [type, version] of old) {
      const load = () =>
        loadPayloadWithMigration(registry, {
          type,
          version,
          payload: {},
          path: "assets/Old.babasset",
        });
      // The editor shows this error type's message to the user.
      expect(load).toThrow(AssetFormatVersionError);
      expect(load).toThrow(/unsupported old format/);
    }
  });

  it("loads current payloads unchanged with no pending save and refuses newer ones", () => {
    const registry = createDefaultMigrationRegistry();
    const payload = {
      id: "player-progress",
      schemaVersion: 7,
      fields: [{ id: "stable-score", name: "Coins", type: "int", defaultValue: 0 }],
    };
    const options = { type: "SaveGame", payload, path: "assets/Progress.savegame.babasset" };
    const loaded = loadPayloadWithMigration(registry, { ...options, version: 1 });
    expect(loaded.pending).toBeNull();
    expect(loaded.payload).toBe(payload);
    expect(() =>
      loadPayloadWithMigration(registry, { ...options, version: 2 }),
    ).toThrow(/newer engine/);
  });
});
