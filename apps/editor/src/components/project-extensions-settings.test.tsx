import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyProject } from "@babylonslate/core";
import { createDefaultExtensionSettings, decodeExtensionSettings, exportExtensionZip, writeProjectExtension } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { convertGlslToMaterial } from "@babylonslate/shader-graph";
import { EditorExtensionService, type ExtensionOverrides } from "../services/editor-extension-service";
import { ProjectExtensionsSettings } from "./project-extensions-settings";

const harness = vi.hoisted(() => ({
  service: null as EditorExtensionService | null,
  overrides: {} as ExtensionOverrides,
  pick: vi.fn(),
}));

vi.mock("@babylonslate/vfs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@babylonslate/vfs")>(),
  pickImportFiles: harness.pick,
}));
vi.mock("../context/document-context", () => ({
  useDocuments: () => {
    const [project, setProject] = useState(() => {
      const empty = createEmptyProject("Extensions");
      return { ...empty, settings: { ...empty.settings, extensionOverrides: harness.overrides } };
    });
    return {
      extensionService: harness.service,
      projectDocument: project,
      updateProjectSettings: (patch: { extensionOverrides: ExtensionOverrides }) => {
        harness.overrides = patch.extensionOverrides;
        setProject((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }));
      },
    };
  },
}));

const source = `export function activate(api) {
  api.registerCommand({ id: "write", title: "Write Code", fields: [
    { id: "source", label: "Source", type: "multiline", defaultValue: "initial" }
  ], async execute(values) {
    if (values.source === "invalid") throw new Error("Fix the source before saving");
    await api.code.write("scripts/output.ts", values.source);
  }});
}`;
let storage: MemoryStorageAdapter;

beforeEach(async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  harness.pick.mockReset();
  harness.overrides = {};
  storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject("extension-ui");
  await storage.mkdir("scripts", true);
  await writeProjectExtension(storage, "tools", {
    ...createDefaultExtensionSettings({ extensionGuid: "tools", displayName: "Tools" }), beta: true,
  }, source);
  harness.service = new EditorExtensionService(storage, {
    assets: {
      list: async () => [],
      read: async () => { throw new Error("No test assets"); },
      create: async () => { throw new Error("No test assets"); },
      update: async () => { throw new Error("No test assets"); },
    },
    code: { read: (path) => storage.readText(path), write: (path, value) => storage.writeText(path, value) },
    materials: { convertGlsl: convertGlslToMaterial },
  });
  await harness.service.refresh();
});

afterEach(async () => {
  cleanup();
  await harness.service?.close();
  vi.unstubAllGlobals();
});

describe("ProjectExtensionsSettings", () => {
  it("requires enable confirmation and preserves command inputs for retry after an error", async () => {
    render(<ProjectExtensionsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Tools" }));
    expect(await screen.findByRole("alertdialog", { name: "Enable Beta Extension" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(harness.service!.getSnapshot().commands).toEqual([]);

    fireEvent.click(screen.getByRole("switch", { name: "Enable Tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));
    fireEvent.click(await screen.findByRole("button", { name: "Write Code" }));
    const input = await screen.findByRole("textbox", { name: "Source" });
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Fix the source before saving")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("invalid");
    expect(await storage.exists("scripts/output.ts")).toBe(false);

    fireEvent.change(input, { target: { value: "export const value = 42;" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Command Completed")).toBeTruthy();
    expect(await storage.readText("scripts/output.ts")).toBe("export const value = 42;");
    expect(harness.overrides.tools).toEqual({ enabled: true });
  });

  it("saves edited metadata while preserving extension identity and entry source", async () => {
    render(<ProjectExtensionsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Tools" }));
    const name = await screen.findByRole("textbox", { name: "Display Name" });
    expect((screen.getByRole("textbox", { name: "Extension ID" }) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(name, { target: { value: "Renamed Tools" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Version" }), { target: { value: "2.0.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Extension" })).toBeNull());

    const settings = decodeExtensionSettings(await storage.readBinary("extensions/tools/extension.json"));
    expect(settings).toMatchObject({ extensionGuid: "tools", displayName: "Renamed Tools", version: "2.0.0", entryPoint: "index.ts" });
    expect(await storage.readText("extensions/tools/index.ts")).toBe(source);
    expect(screen.getByRole("switch", { name: "Enable Renamed Tools" })).toBeTruthy();
  });

  it("keeps installed code until import replacement is confirmed and leaves the replacement disabled", async () => {
    await harness.service!.refresh({ tools: { enabled: true } });
    harness.overrides = harness.service!.getOverrides();
    const incomingStorage = new MemoryStorageAdapter("opfs");
    await incomingStorage.openDocumentsProject("incoming-extension");
    const incoming = await writeProjectExtension(incomingStorage, "tools", {
      ...createDefaultExtensionSettings({ extensionGuid: "tools", displayName: "Tools" }), enabledByDefault: true,
    }, "export function activate() {}");
    const bytes = await exportExtensionZip(incomingStorage, incoming);
    harness.pick.mockResolvedValue([{ name: "Tools.babextension", bytes }]);
    render(<ProjectExtensionsSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Import Extension" }));
    expect(await screen.findByRole("alertdialog", { name: "Extension Already Installed" })).toBeTruthy();
    expect(await storage.readText("extensions/tools/index.ts")).toBe(source);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(harness.overrides.tools).toEqual({ enabled: false }));

    expect(await storage.readText("extensions/tools/index.ts")).toBe("export function activate() {}");
    expect(harness.service!.getSnapshot().commands).toEqual([]);
    expect(screen.getByRole("switch", { name: "Enable Tools" }).getAttribute("aria-checked")).toBe("false");
  });
});
