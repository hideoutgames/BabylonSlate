import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createDefaultExtensionSettings, normalizeExtensionContributions, writeProjectExtension } from "@haptic/assets";
import type { ExtensionMenuId } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { convertGlslToMaterial } from "@haptic/shader-graph";
import { EditorExtensionService } from "../services/editor-extension-service";
import { ExtensionCommandHost } from "./extension-commands";
import { useExtensionMenuItems } from "./use-extension-menu-items";

const harness = vi.hoisted(() => ({ service: null as EditorExtensionService | null }));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({ extensionService: harness.service })),
);

const source = `export function activate(api) {
  api.registerCommand({ id: "inspect", title: "Inspect", async execute(values, context) {
    await api.code.write("code/inspect.json", JSON.stringify(context));
    return "Inspected " + context.assets.length + " assets.";
  }});
  api.registerCommand({ id: "tag", title: "Tag Assets", fields: [{ id: "tag", label: "Tag", type: "text", default: "hero" }], async execute(values, context) {
    await api.code.write("code/tag.json", JSON.stringify({ values, context }));
  }});
  api.registerCommand({ id: "broken", title: "Broken", execute() { throw new Error("Nothing selected"); } });
}`;
let storage: MemoryStorageAdapter;

function Menu({ menu, context }: { menu: ExtensionMenuId; context: Record<string, unknown> }) {
  const items = useExtensionMenuItems(menu, () => context);
  return <div data-testid={`menu-${menu}`}>{items.map((item) => item.type === "separator" ? <hr key={item.id} />
    : item.type === undefined || item.type === "item" ? <button key={item.id} onClick={item.onSelect}>{item.label}</button> : null)}</div>;
}

beforeEach(async () => {
  storage = new MemoryStorageAdapter("opfs");
  await storage.openDocumentsProject("extension-menus");
  await writeProjectExtension(storage, "tools", {
    ...createDefaultExtensionSettings({ extensionGuid: "tools", displayName: "Tools" }), enabledByDefault: true,
    contributes: normalizeExtensionContributions({ menus: [
      { menu: "contentBrowser.asset", command: "inspect", title: "Inspect Assets" },
      { menu: "contentBrowser.asset", command: "tag" },
      { menu: "contentBrowser.asset", command: "broken" },
      { menu: "contentBrowser.asset", command: "notRegistered", title: "Never Shown" },
      { menu: "outliner.actor", command: "inspect" },
    ] }),
  }, source);
  harness.service = new EditorExtensionService(storage, {
    assets: { list: async () => [], read: async () => { throw new Error("none"); }, create: async () => {}, update: async () => {} },
    code: { read: (path) => storage.readText(path), write: async (path, value) => { await storage.mkdir("code", true); await storage.writeText(path, value); } },
    materials: { convertGlsl: convertGlslToMaterial },
  });
  await harness.service.refresh();
});

afterEach(async () => {
  cleanup();
  await harness.service?.close();
});

describe("Extension menu entries", () => {
  it("list registered commands for their menu only, labelled by the entry or the command", () => {
    render(<ExtensionCommandHost>
      <Menu menu="contentBrowser.asset" context={{}} />
      <Menu menu="outliner.actor" context={{}} />
      <Menu menu="viewport" context={{}} />
    </ExtensionCommandHost>);
    expect(within(screen.getByTestId("menu-contentBrowser.asset")).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Inspect Assets", "Tag Assets", "Broken"]);
    expect(within(screen.getByTestId("menu-outliner.actor")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Inspect"]);
    expect(screen.getByTestId("menu-viewport").children).toHaveLength(0);
  });

  it("run a command without fields at once with the menu context and show its message", async () => {
    const context = { assets: [{ path: "assets/Hero.class.hasset", type: "Class", name: "Hero", guid: "hero" }] };
    render(<ExtensionCommandHost><Menu menu="contentBrowser.asset" context={context} /></ExtensionCommandHost>);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Assets" }));
    expect(await screen.findByText("Inspected 1 assets.")).toBeTruthy();
    expect(JSON.parse(await storage.readText("code/inspect.json"))).toEqual(context);
  });

  it("open the dialog of a command with fields and pass it the menu context", async () => {
    render(<ExtensionCommandHost><Menu menu="contentBrowser.asset" context={{ assets: [] }} /></ExtensionCommandHost>);
    fireEvent.click(screen.getByRole("button", { name: "Tag Assets" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Tag Assets" }));
    fireEvent.click(dialog.getByRole("button", { name: "Run" }));
    await waitFor(async () => expect(await storage.exists("code/tag.json")).toBe(true));
    expect(JSON.parse(await storage.readText("code/tag.json"))).toEqual({ values: { tag: "hero" }, context: { assets: [] } });
  });

  it("report a failing command by name", async () => {
    render(<ExtensionCommandHost><Menu menu="contentBrowser.asset" context={{}} /></ExtensionCommandHost>);
    fireEvent.click(screen.getByRole("button", { name: "Broken" }));
    const result = within(await screen.findByRole("alertdialog", { name: "Broken Failed" }));
    expect(result.getByText("Nothing selected")).toBeTruthy();
  });

  it("disappear when the extension is disabled", async () => {
    render(<ExtensionCommandHost><Menu menu="contentBrowser.asset" context={{}} /></ExtensionCommandHost>);
    await harness.service!.refresh({ tools: { enabled: false } });
    await waitFor(() => expect(screen.getByTestId("menu-contentBrowser.asset").children).toHaveLength(0));
  });
});
