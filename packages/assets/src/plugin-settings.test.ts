import { describe, expect, it } from "vitest";
import { decodeAssetDocument } from "./asset-document";
import {
  createDefaultPluginSettings,
  encodePluginSettingsDocument,
  normalizePluginSettings,
  PLUGIN_FILE_SUFFIX,
  PLUGIN_SETTINGS_TYPE,
} from "./plugin-settings";

describe("PluginSettings payload", () => {
  it.each(["0.1", "2.7", "1.0.0", "preview-2"])("preserves the author version %s and imported engine identity", (version) => {
    const settings = normalizePluginSettings({ version, engineVersion: "older" }, { pluginGuid: "pack" });
    expect(settings.version).toBe(version);
    expect(settings.engineVersion).toBe("older");
    expect(normalizePluginSettings({}, { pluginGuid: "pack" }).engineVersion).toBe("");
  });

  it("creates identity, maturity, EUO, export-default, and dependency fields", () => {
    const payload = createDefaultPluginSettings({
      pluginGuid: "plug-1",
      displayName: "Starter Content",
    });
    expect(payload.pluginGuid).toBe("plug-1");
    expect(payload.displayName).toBe("Starter Content");
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(payload.description).toBe("");
    expect(payload.author).toBe("");
    expect(payload.category).toBe("");
    expect(payload.iconKey).toBeNull();
    expect(payload.experimental).toBe(false);
    expect(payload.beta).toBe(false);
    expect(payload.editorUtilityObjects).toEqual([]);
    expect(payload.enabledByDefault).toBe(false);
    expect(payload.engineVersion).toBe("0.0.1");
    expect(payload.pluginDependencies).toEqual([]);
  });

  it("normalizes missing fields and unique EUO class ids", () => {
    const payload = normalizePluginSettings(
      {
        displayName: "  Pack  ",
        version: "1.2.0",
        editorUtilityObjects: [" Tools ", "Tools", "", "Inspector"],
        pluginDependencies: [
          { guid: " dep-1 ", version: "1.0.0" },
          { guid: "", version: "2.0.0" },
        ],
        experimental: true,
        enabledByDefault: true,
      },
      { pluginGuid: "plug-1", displayName: "Fallback" },
    );
    expect(payload.pluginGuid).toBe("plug-1");
    expect(payload.displayName).toBe("Pack");
    expect(payload.version).toBe("1.2.0");
    expect(payload.experimental).toBe(true);
    expect(payload.enabledByDefault).toBe(true);
    expect(payload.editorUtilityObjects).toEqual(["Tools", "Inspector"]);
    expect(payload.pluginDependencies).toEqual([
      { guid: "dep-1", version: "1.0.0" },
    ]);
  });

  it("round-trips through a .plugin.babasset document", async () => {
    const payload = createDefaultPluginSettings({
      pluginGuid: "plug-1",
      displayName: "Pack",
    });
    payload.description = "A pack";
    payload.author = "Hideout";
    const bytes = await encodePluginSettingsDocument(payload);
    const decoded = await decodeAssetDocument(bytes);
    expect(decoded.type).toBe(PLUGIN_SETTINGS_TYPE);
    expect(decoded.guid).toBe("plug-1");
    expect(decoded.name).toBe("Pack");
    expect(normalizePluginSettings(decoded.payload, { pluginGuid: decoded.guid })).toEqual(
      payload,
    );
    expect(PLUGIN_FILE_SUFFIX).toBe(".plugin.babasset");
  });
});
