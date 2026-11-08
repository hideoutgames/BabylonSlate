import { describe, expect, it } from "vitest";
import {
  extensionSettingsFields, normalizeExtensionContributions, normalizeExtensionFields, resolveExtensionFieldValues,
} from "./extension-fields";
import { createDefaultExtensionSettings, decodeExtensionSettings, encodeExtensionSettings } from "./extension-settings";

const settings = {
  title: "Discord",
  sections: [
    { id: "app", title: "Application", fields: [
      { id: "applicationId", label: "Application ID", type: "text", hint: "From the Developer Portal." },
      { id: "showElapsed", label: "Show Elapsed Time", type: "toggle", default: true },
    ] },
    { id: "presence", title: "Presence", fields: [
      { id: "refresh", label: "Refresh Interval", type: "number", min: 5, max: 60, unit: "s" },
      { id: "count", label: "Party Size", type: "number", integer: true, default: 2.6 },
      { id: "mode", label: "Mode", type: "choice", options: [{ value: "solo", label: "Solo" }, { value: "party", label: "Party" }] },
      { id: "notes", label: "Notes", type: "code", language: "glsl" },
    ] },
  ],
};

describe("Extension fields", () => {
  it("fill each type's default and keep the category title the extension chose", () => {
    const contributions = normalizeExtensionContributions({ settings });
    expect(contributions.settings?.title).toBe("Discord");
    expect(extensionSettingsFields(contributions)).toEqual([
      { id: "applicationId", label: "Application ID", hint: "From the Developer Portal.", type: "text", default: "" },
      { id: "showElapsed", label: "Show Elapsed Time", type: "toggle", default: true },
      { id: "refresh", label: "Refresh Interval", type: "number", default: 5, integer: false, min: 5, max: 60, unit: "s" },
      { id: "count", label: "Party Size", type: "number", default: 3, integer: true },
      { id: "mode", label: "Mode", type: "choice", default: "solo", options: [{ value: "solo", label: "Solo" }, { value: "party", label: "Party" }] },
      { id: "notes", label: "Notes", type: "code", language: "glsl", default: "" },
    ]);
    expect(normalizeExtensionContributions(undefined)).toEqual({});
    expect(normalizeExtensionContributions({})).toEqual({});
  });

  it.each([
    ["a category without a title", { settings: { ...settings, title: " " } }, /title is required/],
    ["a category without sections", { settings: { title: "Empty", sections: [] } }, /at least one section/],
    ["a section without fields", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [] }] } }, /at least one field/],
    ["one field id in two sections", { settings: { title: "T", sections: [
      { id: "a", title: "A", fields: [{ id: "x", label: "X", type: "text" }] },
      { id: "b", title: "B", fields: [{ id: "x", label: "X", type: "toggle" }] },
    ] } }, /Duplicate field id: x/],
    ["an unknown field type", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "slider" }] }] } }, /unknown type/],
    ["a default of the wrong type", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "toggle", default: "yes" }] }] } }, /does not match its type/],
    ["a choice default outside its options", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [
      { id: "x", label: "X", type: "choice", options: [{ value: "a", label: "A" }], default: "b" },
    ] }] } }, /does not match its type/],
    ["a min above its max", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "number", min: 2, max: 1 }] }] } }, /min is above its max/],
    ["a field id that is not an identifier", { settings: { title: "T", sections: [{ id: "s", title: "S", fields: [{ id: "1st", label: "X", type: "text" }] }] } }, /must start with a letter/],
  ])("reject %s", (_name, contributes, message) => {
    expect(() => normalizeExtensionContributions(contributes)).toThrow(message);
  });

  it("resolve stored values by field type, falling back to defaults and dropping unknown keys", () => {
    const fields = extensionSettingsFields(normalizeExtensionContributions({ settings }));
    expect(resolveExtensionFieldValues(fields, {
      applicationId: 42, showElapsed: false, refresh: 600, count: 4.4, mode: "raid", notes: "x", stray: "kept?",
    })).toEqual({ applicationId: "", showElapsed: false, refresh: 60, count: 4, mode: "solo", notes: "x" });
    expect(resolveExtensionFieldValues(fields)).toEqual({ applicationId: "", showElapsed: true, refresh: 5, count: 3, mode: "solo", notes: "" });
  });

  it("normalize graph nodes with their pins, hosts and call", () => {
    expect(normalizeExtensionContributions({ nodes: [
      { id: "update", title: "Update Presence", call: "updatePresence", hosts: ["GameInstance"], latent: true,
        inputs: [{ id: "details", name: "Details", type: "string", default: "In Menus" }], outputs: [{ id: "ok", name: "Success", type: "bool" }] },
    ] }).nodes).toEqual([{
      id: "update", title: "Update Presence", call: "updatePresence", pure: false, latent: true, hosts: ["GameInstance"],
      inputs: [{ id: "details", name: "Details", type: "string", default: "In Menus" }], outputs: [{ id: "ok", name: "Success", type: "bool" }],
    }]);
    expect(normalizeExtensionContributions({ nodes: [] })).toEqual({});
  });

  it.each([
    ["a call that is not an identifier", { id: "n", title: "N", call: "a.b" }, /must name a game library export/],
    ["a pure latent node", { id: "n", title: "N", call: "f", pure: true, latent: true, outputs: [{ id: "o", name: "O", type: "int" }] }, /both pure and latent/],
    ["a pure node without outputs", { id: "n", title: "N", call: "f", pure: true }, /needs an output/],
    ["an exec pin id", { id: "n", title: "N", call: "f", inputs: [{ id: "execIn", name: "X", type: "int" }] }, /other than execIn or execOut/],
    ["an unknown pin type", { id: "n", title: "N", call: "f", inputs: [{ id: "x", name: "X", type: "actor" }] }, /unknown type: actor/],
    ["one pin id twice", { id: "n", title: "N", call: "f", inputs: [{ id: "x", name: "X", type: "int" }], outputs: [{ id: "x", name: "Y", type: "int" }] }, /duplicate pin ids/],
    ["an input default of the wrong type", { id: "n", title: "N", call: "f", inputs: [{ id: "x", name: "X", type: "int", default: "2" }] }, /does not match its type/],
  ])("reject a node with %s", (_name, node, message) => {
    expect(() => normalizeExtensionContributions({ nodes: [node] })).toThrow(message);
  });

  it("normalize menu entries and reject unknown menus or a command listed twice in one menu", () => {
    expect(normalizeExtensionContributions({ menus: [
      { menu: "contentBrowser.asset", command: "inspect", title: " Inspect Asset " },
      { menu: "outliner.actor", command: "inspect" },
    ] }).menus).toEqual([
      { menu: "contentBrowser.asset", command: "inspect", title: "Inspect Asset" },
      { menu: "outliner.actor", command: "inspect" },
    ]);
    expect(() => normalizeExtensionContributions({ menus: [{ menu: "toolbar", command: "x" }] })).toThrow("Unknown extension menu: toolbar");
    expect(() => normalizeExtensionContributions({ menus: [{ menu: "debug", command: "x" }, { menu: "debug", command: "x" }] })).toThrow(/appears twice/);
  });

  it("normalize asset types: Editor Only unless turned off, sections filled like settings", () => {
    expect(normalizeExtensionContributions({ assetTypes: [
      { id: "preset", title: " Weather Preset ", iconKey: "Cloud", sections: [{ id: "sky", title: "Sky", fields: [{ id: "rain", label: "Rain", type: "toggle" }] }] },
      { id: "zone", title: "Weather Zone", category: "World", editorOnly: false, description: "Where weather applies.",
        sections: [{ id: "size", title: "Size", fields: [{ id: "radius", label: "Radius", type: "number", min: 1 }] }] },
    ] }).assetTypes).toEqual([
      { id: "preset", title: "Weather Preset", iconKey: "Cloud", editorOnly: true,
        sections: [{ id: "sky", title: "Sky", fields: [{ id: "rain", label: "Rain", type: "toggle", default: false }] }] },
      { id: "zone", title: "Weather Zone", category: "World", description: "Where weather applies.", editorOnly: false,
        sections: [{ id: "size", title: "Size", fields: [{ id: "radius", label: "Radius", type: "number", default: 1, integer: false, min: 1 }] }] },
    ]);
    expect(normalizeExtensionContributions({ assetTypes: [] })).toEqual({});
  });

  it.each([
    ["without sections", [{ id: "a", title: "A", sections: [] }], /at least one section/],
    ["with one field id in two sections", [{ id: "a", title: "A", sections: [
      { id: "s", title: "S", fields: [{ id: "x", label: "X", type: "text" }] },
      { id: "t", title: "T", fields: [{ id: "x", label: "X", type: "text" }] },
    ] }], /Duplicate field id: x/],
    ["declared twice", [
      { id: "a", title: "A", sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "text" }] }] },
      { id: "a", title: "B", sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "text" }] }] },
    ], /asset type ids must be unique/],
    ["with an id that is not an identifier", [{ id: "a.b", title: "A", sections: [] }], /must start with a letter/],
    ["with a non-boolean editorOnly", [{ id: "a", title: "A", editorOnly: "no", sections: [] }], /editorOnly must be true or false/],
  ])("reject an asset type %s", (_name, assetTypes, message) => {
    expect(() => normalizeExtensionContributions({ assetTypes })).toThrow(message);
  });

  it("round-trip in the manifest and reject a malformed command form", () => {
    const contributes = normalizeExtensionContributions({ settings });
    const manifest = { ...createDefaultExtensionSettings({ extensionGuid: "discord", displayName: "Discord" }), contributes };
    expect(decodeExtensionSettings(encodeExtensionSettings(manifest)).contributes).toEqual(contributes);
    expect(() => normalizeExtensionFields([{ id: "a", label: "A", type: "text" }, { id: "a", label: "B", type: "text" }])).toThrow(/Duplicate field id/);
    expect(() => normalizeExtensionFields("fields")).toThrow(/must be a list/);
  });
});
