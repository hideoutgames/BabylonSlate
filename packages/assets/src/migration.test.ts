import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readGoldenBinary } from "@haptic/test-kit";
import { decodeAssetDocument } from "./asset-document";
import {
  AssetFormatVersionError,
  MigrationRegistry,
  RELEASED_VERSIONS,
  createDefaultMigrationRegistry,
  type MigrationFn,
} from "./migration";
import { loadPayloadWithMigration } from "./migrate-on-load";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

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
      path: "assets/Thing.hasset",
    });
    expect(loaded.payload).toEqual({ steps: [2, 3] });
    expect(loaded.version).toBe(3);
    expect(loaded.pending).toEqual({
      type: "Thing",
      fromVersion: 1,
      toVersion: 3,
      path: "assets/Thing.hasset",
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

  it("requires the current version where payloads are read without migrating", () => {
    const registry = registryWithSteps();
    expect(() => registry.requireCurrent("Thing", 3)).not.toThrow();
    // Unregistered types pass through, as in migrate.
    expect(() => registry.requireCurrent("Texture", 7)).not.toThrow();
    const refused = [
      [1, /version 1 must be upgraded to version 3 before it can be played or exported/],
      [0, /version 0 uses an unsupported old format/],
      [4, /newer engine version/],
    ] as const;
    for (const [version, message] of refused) {
      const read = () => registry.requireCurrent("Thing", version);
      expect(read).toThrow(AssetFormatVersionError);
      expect(read).toThrow(message);
    }
  });
});

describe("default migration registry", () => {
  it("upgrades every released version, each step proven on a committed golden", async () => {
    const registry = createDefaultMigrationRegistry();
    // A versioned type without a released version would never be held to this.
    expect(registry.types().sort()).toEqual(Object.keys(RELEASED_VERSIONS).sort());
    for (const [type, released] of Object.entries(RELEASED_VERSIONS)) {
      const current = registry.currentVersion(type);
      expect(current, `${type} current version`).toBeGreaterThanOrEqual(released);
      for (let version = released; version < current; version++) {
        const relative = `__fixtures__/migrations/${type}-v${version}.hasset`;
        expect(existsSync(`${FIXTURE_DIR}/${relative}`), `${relative} must hold a ${type} saved at version ${version}`).toBe(true);
        const stored = await decodeAssetDocument(readGoldenBinary(FIXTURE_DIR, relative));
        expect([stored.type, stored.version]).toEqual([type, version]);
        expect(registry.migrate(type, version, stored.payload).version).toBe(current);
      }
    }
  });

  it("refuses versions from before the release instead of upgrading them", () => {
    const registry = createDefaultMigrationRegistry();
    for (const [type, released] of Object.entries(RELEASED_VERSIONS)) {
      const version = released - 1;
      const load = () =>
        loadPayloadWithMigration(registry, {
          type,
          version,
          payload: {},
          path: "assets/Old.hasset",
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
    const options = { type: "SaveGame", payload, path: "assets/Progress.savegame.hasset" };
    const loaded = loadPayloadWithMigration(registry, { ...options, version: 1 });
    expect(loaded.pending).toBeNull();
    expect(loaded.payload).toBe(payload);
    expect(() =>
      loadPayloadWithMigration(registry, { ...options, version: 2 }),
    ).toThrow(/newer engine/);
  });
});
