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

  it("round-trip in the manifest and reject a malformed command form", () => {
    const contributes = normalizeExtensionContributions({ settings });
    const manifest = { ...createDefaultExtensionSettings({ extensionGuid: "discord", displayName: "Discord" }), contributes };
    expect(decodeExtensionSettings(encodeExtensionSettings(manifest)).contributes).toEqual(contributes);
    expect(() => normalizeExtensionFields([{ id: "a", label: "A", type: "text" }, { id: "a", label: "B", type: "text" }])).toThrow(/Duplicate field id/);
    expect(() => normalizeExtensionFields("fields")).toThrow(/must be a list/);
  });
});
