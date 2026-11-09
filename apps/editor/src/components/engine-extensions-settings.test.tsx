import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createEmptyProject } from "@haptic/core";
import { createExtensionSettings, discoverProjectExtensions, exportExtensionZip, unpackEngineExtensionZip, writeProjectExtension } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { EngineExtensionLibrary } from "../lib/engine-extension-library";
import { EditorExtensionService, type ExtensionOverrides } from "../services/editor-extension-service";
import { EngineExtensionsSettings } from "./engine-extensions-settings";

const harness = vi.hoisted(() => ({
  library: null as EngineExtensionLibrary | null,
  service: null as EditorExtensionService | null,
  projectOpen: false,
  overrides: {} as ExtensionOverrides,
}));
vi.mock("../lib/engine-extension-library", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/engine-extension-library")>(),
  ensureEngineExtensionLibrary: async () => harness.library,
}));
vi.mock("../context/document-context", async () => {
  const { documentContextMock, sharedMockState } = await import("../testing/document-context-mock");
  const projectState = sharedMockState(() => {
    const empty = createEmptyProject("Demo");
    return { ...empty, settings: { ...empty.settings, extensionOverrides: harness.overrides } };
  });
  return documentContextMock(() => {
    const [project, setProject] = projectState.use();
    if (!harness.projectOpen) return {};
    return {
      extensionService: harness.service,
      projectDocument: project,
      projectName: "Demo",
      updateProjectSettings: (patch: { extensionOverrides: ExtensionOverrides }) => {
        harness.overrides = patch.extensionOverrides;
        setProject((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }));
      },
    };
  });
});

let bundled: MemoryStorageAdapter;
let saved: MemoryStorageAdapter;
let projectStorage: MemoryStorageAdapter;

async function memory(name: string) {
  const storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject(name);
  return storage;
}

async function archive(guid: string, name: string) {
  const storage = await memory(`source-${guid}`);
  const entry = await writeProjectExtension(storage, "tool", createExtensionSettings(name, guid));
  return exportExtensionZip(storage, entry);
}

beforeEach(async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  bundled = await memory("bundled");
  saved = await memory("saved");
  await unpackEngineExtensionZip(bundled, await archive("bundled", "Bundled Tool"), "bundled");
  harness.library = new EngineExtensionLibrary(bundled, saved);
  await harness.library.import(await archive("custom", "Custom Tool"));
  harness.projectOpen = false;
  harness.overrides = {};
  // An existing project sees bundled Engine Extensions but holds no copy of user-added ones.
  projectStorage = await memory("project");
  const unused = async () => { throw new Error("No test assets"); };
  harness.service = new EditorExtensionService(projectStorage, {
    assets: { list: async () => [], read: unused, create: unused, update: unused },
    code: { read: (path) => projectStorage.readText(path), write: (path, value) => projectStorage.writeText(path, value) },
    materials: { convertGlsl: unused },
  });
  harness.service.setEngineStorage(bundled);
  await harness.service.refresh();
});

afterEach(async () => {
  cleanup();
  await harness.service?.close();
  vi.unstubAllGlobals();
});

async function defaults() {
  return Object.fromEntries((await new EngineExtensionLibrary(bundled, saved).list()).map((entry) => [entry.extensionGuid, entry.enabledByDefault]));
}

/** Answers the prompt and returns the text it showed. */
async function choose(title: string, choice: string) {
  const prompt = await screen.findByRole("alertdialog", { name: title });
  const text = prompt.textContent;
  fireEvent.click(within(prompt).getByRole("button", { name: choice }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  return text;
}

describe("EngineExtensionsSettings", () => {
  it("persists the selected default and deletes user extensions only after confirmation", async () => {
    render(<EngineExtensionsSettings />);
    const bundledRow = within(await screen.findByTestId("engine-extension-row-bundled"));
    expect(bundledRow.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(bundledRow.getByRole("switch", { name: "Enable Bundled Tool By Default" }));
    await waitFor(() => expect(bundledRow.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    const reloaded = new EngineExtensionLibrary(bundled, saved);
    expect((await reloaded.list()).map((entry) => [entry.extensionGuid, entry.enabledByDefault])).toEqual([
      ["bundled", true], ["custom", false],
    ]);

    const userRow = within(screen.getByTestId("engine-extension-row-custom"));
    fireEvent.click(userRow.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete Engine Extension" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((await reloaded.list()).some((entry) => entry.extensionGuid === "custom")).toBe(true);
    fireEvent.click(userRow.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByTestId("engine-extension-row-custom")).toBeNull());
    expect((await reloaded.list()).map((entry) => entry.extensionGuid)).toEqual(["bundled"]);
  });

  it("asks where a change applies while a project is open, and copies a missing extension in", async () => {
    harness.projectOpen = true;
    render(<EngineExtensionsSettings />);
    const bundledSwitch = within(await screen.findByTestId("engine-extension-row-bundled")).getByRole("switch");

    fireEvent.click(bundledSwitch);
    await choose("Enable Bundled Tool", "Project Only");
    await waitFor(() => expect(harness.overrides).toEqual({ bundled: { enabled: true } }));
    expect(harness.service!.getOverrides()).toEqual({ bundled: { enabled: true } });
    expect(await defaults()).toEqual({ bundled: false, custom: false });
    expect(bundledSwitch.getAttribute("aria-checked")).toBe("false");

    // The project already matches, so the switch changes the default without asking.
    fireEvent.click(bundledSwitch);
    await waitFor(() => expect(bundledSwitch.getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(bundledSwitch);
    await choose("Disable Bundled Tool", "Engine Only");
    await waitFor(() => expect(bundledSwitch.getAttribute("aria-checked")).toBe("false"));
    expect(harness.overrides).toEqual({ bundled: { enabled: true } });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Custom Tool By Default" }));
    const text = await choose("Enable Custom Tool", "Project & Engine");
    expect(text).toContain("It is not in Demo yet, so a project choice copies it in.");
    await waitFor(() => expect(harness.overrides).toEqual({ bundled: { enabled: true }, custom: { enabled: true } }));
    expect((await discoverProjectExtensions(projectStorage)).map((entry) => entry.extensionGuid)).toEqual(["custom"]);
    expect(await defaults()).toEqual({ bundled: false, custom: true });
  });

  it("shows corrupted archives as disabled recovery rows without blocking healthy defaults", async () => {
    await saved.writeBinary("broken.hextension", new Uint8Array([1, 2, 3]));
    const broken = (await harness.library!.list()).find((entry) => entry.invalid)!;
    render(<EngineExtensionsSettings />);
    const row = within(await screen.findByTestId(`engine-extension-row-${broken.extensionGuid}`));
    expect(row.getByText(broken.invalid!)).toBeTruthy();
    expect(row.getByRole("switch").getAttribute("aria-disabled")).toBe("true");
    expect((row.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
    expect((row.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: "Enable Custom Tool By Default" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Custom Tool By Default" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(row.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Delete Engine Extension" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByTestId(`engine-extension-row-${broken.extensionGuid}`)).toBeNull());

    expect(await saved.exists("broken.hextension")).toBe(false);
    expect((await harness.library!.list()).find((entry) => entry.extensionGuid === "custom")).toMatchObject({ enabledByDefault: true });
    expect(screen.getByTestId("engine-extension-row-bundled")).toBeTruthy();
  });
});
