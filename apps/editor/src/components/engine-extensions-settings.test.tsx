import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createExtensionSettings, exportExtensionZip, unpackEngineExtensionZip, writeProjectExtension } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EngineExtensionLibrary } from "../lib/engine-extension-library";
import { EngineExtensionsSettings } from "./engine-extensions-settings";

const harness = vi.hoisted(() => ({ library: null as EngineExtensionLibrary | null }));
vi.mock("../lib/engine-extension-library", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/engine-extension-library")>(),
  ensureEngineExtensionLibrary: async () => harness.library,
}));

let bundled: MemoryStorageAdapter;
let saved: MemoryStorageAdapter;

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("shows corrupted archives as disabled recovery rows without blocking healthy defaults", async () => {
    await saved.writeBinary("broken.babextension", new Uint8Array([1, 2, 3]));
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

    expect(await saved.exists("broken.babextension")).toBe(false);
    expect((await harness.library!.list()).find((entry) => entry.extensionGuid === "custom")).toMatchObject({ enabledByDefault: true });
    expect(screen.getByTestId("engine-extension-row-bundled")).toBeTruthy();
  });
});
