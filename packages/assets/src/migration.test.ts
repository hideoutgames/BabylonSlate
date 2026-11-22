import { describe, expect, it } from "vitest";
import { ASSET_TYPES, extensionAssetType } from "@haptic/core";
import {
  AssetFormatVersionError,
  MigrationRegistry,
  RELEASED_VERSIONS,
  createDefaultMigrationRegistry,
} from "./migration";

describe("asset format registry", () => {
  it("reads only the current version and names older and newer ones for the user", () => {
    const registry = new MigrationRegistry();
    registry.register({ type: "Thing", currentVersion: 3 });
    expect(() => registry.requireCurrent("Thing", 3)).not.toThrow();
    const refused = [
      [2, /version 2 uses an unsupported old format\. This engine reads version 3; older files are not upgraded\./],
      [0, /version 0 uses an unsupported old format/],
      [4, /version 4 was made with a newer engine version \(current 3\)/],
    ] as const;
    for (const [version, message] of refused) {
      const read = () => registry.requireCurrent("Thing", version);
      expect(read).toThrow(AssetFormatVersionError);
      expect(read).toThrow(message);
    }
  });

  it("refuses to register version 0 and refuses types it does not know", () => {
    const registry = new MigrationRegistry();
    expect(() => registry.register({ type: "Thing", currentVersion: 0 })).toThrow(/whole number from 1/);
    expect(() => registry.currentVersion("Thing")).toThrow(/no registered schema version/);
    expect(() => registry.requireCurrent("Thing", 1)).toThrow(AssetFormatVersionError);
  });
});

describe("default asset format registry", () => {
  it("never hands a save version 0, for every built-in type, the manifest and extension assets", () => {
    const registry = createDefaultMigrationRegistry();
    for (const type of [...ASSET_TYPES, "Project", extensionAssetType("ext-guid", "Note")]) {
      expect(registry.currentVersion(type), type).toBeGreaterThanOrEqual(1);
    }
  });

  it("refuses version 2 of types the registry used to leave unversioned", () => {
    const registry = createDefaultMigrationRegistry();
    for (const type of ["Tilemap", "Model", "Texture", "BehaviourTree", "PluginSettings"]) {
      const read = () => registry.requireCurrent(type, 2);
      expect(read, type).toThrow(AssetFormatVersionError);
      expect(read, type).toThrow(/newer engine version \(current 1\)/);
    }
  });

  it("starts every type at its released version before the first release", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.types().sort()).toEqual(Object.keys(RELEASED_VERSIONS).sort());
    for (const [type, released] of Object.entries(RELEASED_VERSIONS)) {
      expect(registry.currentVersion(type), type).toBe(released);
    }
  });
});
