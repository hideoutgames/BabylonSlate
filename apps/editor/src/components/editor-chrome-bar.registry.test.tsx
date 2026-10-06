import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetRegistry, projectContentRoot } from "@babylonslate/assets";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { MaterialRenderControlProvider } from "../context/material-render-control-context";
import type { OpenDocument } from "../services/document-service";
import { EditorChromeBar } from "./editor-chrome-bar";

const state = vi.hoisted(() => ({
  registry: null as AssetRegistry | null,
  documents: [] as OpenDocument[],
  phone: false,
  errorCount: 0,
  activeId: "first",
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  projectName: "Test",
  openDocuments: state.documents,
  activeDocumentId: state.activeId,
  dirtyDocuments: state.documents.filter((doc) => doc.dirty),
  projectDirty: false,
  assetRegistry: state.registry,
  registryEpoch: state.registry?.generation ?? 0,
})));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ playing: false, preparing: false, canPlay: false }),
}));
vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ errorCount: state.errorCount }),
}));
vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => state.phone,
}));
// Keep document navigation real; isolate unrelated project tools and dialogs.
vi.mock("./settings-modal", () => ({ SettingsModal: () => null }));
vi.mock("./global-search-dialog", () => ({ GlobalSearchDialog: () => null }));
vi.mock("./windows-menu", () => ({ WindowsMenu: () => null }));

function Chrome({ onCloseAllDocuments }: { onCloseAllDocuments?: () => void }) {
  return (
    <MaterialRenderControlProvider>
      <TooltipProvider>
        <EditorChromeBar onCloseAllDocuments={onCloseAllDocuments} />
      </TooltipProvider>
    </MaterialRenderControlProvider>
  );
}

function openDocument(id: string, ref: OpenDocument["ref"]): OpenDocument {
  return { id, ref, content: null, layout: null, dirty: false };
}

async function createRegistry() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.babproject");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  state.registry = registry;
  return registry;
}

function typeIcon(element: HTMLElement) {
  return element
    .querySelector("[data-type-icon]")
    ?.getAttribute("data-type-icon");
}

function tabIcon(label: string) {
  const text = within(screen.getByTestId("document-tab-bar")).getByText(label);
  return typeIcon(text.closest("button")!);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.registry = null;
  state.documents = [];
  state.phone = false;
  state.errorCount = 0;
  state.activeId = "first";
});

describe("chrome document icons", () => {
  it("allows Close All when Content Browser is the only visible tab and a background sheet is dirty", () => {
    state.activeId = CONTENT_BROWSER_ID;
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      { ...openDocument("object", createDocumentRef("data-sheet", "assets/Sword.datasheet.babasset")), background: true, dirty: true },
    ];
    const closeAll = vi.fn();
    render(<Chrome onCloseAllDocuments={closeAll} />);
    expect(screen.getAllByTestId("document-tab")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.queryByRole("menuitemradio", { name: /Sword/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }));
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps background sheet edits out of navigation until revealed, while Save includes them (phone=%s)", (phone) => {
    state.phone = phone;
    const object = {
      ...openDocument("object", createDocumentRef("data-sheet", "assets/Sword.datasheet.babasset")),
      background: true,
      dirty: true,
    };
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      openDocument("first", createDocumentRef("data-sheet", "assets/Weapons.datasheet.babasset")),
      object,
    ];
    const view = render(<Chrome />);
    expect((screen.getByTestId("save-all-project") as HTMLButtonElement).disabled).toBe(false);
    if (!phone) expect(screen.getAllByTestId("document-tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.queryByRole("menuitemradio", { name: /Sword/ })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Weapons/ })).toBeTruthy();

    // Explicit Open Object promotes the same canonical record; it keeps dirty state.
    object.background = false;
    view.rerender(<Chrome />);
    expect(screen.getByRole("menuitemradio", { name: /Sword/ })).toBeTruthy();
    expect(within(screen.getByRole("menuitemradio", { name: /Sword/ })).getByLabelText("Unsaved Changes")).toBeTruthy();
    if (!phone) expect(screen.getAllByTestId("document-tab")).toHaveLength(3);
  });

  it.each([false, true])(
    "shares class lookups and refreshes inherited icons on registry updates (phone=%s)",
    async (phone) => {
      state.phone = phone;
      const registry = await createRegistry();
      for (const [id, name, parentClass] of [
        ["base", "Shared Base", "Actor"],
        ["first", "First", "base"],
        ["second", "Second", "Shared Base"],
      ]) {
        await registry.createAsset("project", `${id}.class.babasset`, {
          guid: id!,
          name: name!,
          type: "Class",
          parentClass,
          version: 1,
          dependencies: [],
          payload: {},
          chunks: [],
        });
      }
      state.documents = [
        openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
        openDocument(
          "scene",
          createDocumentRef("scene", "assets/main.scene.babasset"),
        ),
        openDocument(
          "first",
          createDocumentRef("graph", "assets/first.class.babasset"),
        ),
        openDocument(
          "second",
          createDocumentRef("graph", "assets/second.class.babasset"),
        ),
      ];
      const list = vi.spyOn(registry, "list");
      const view = render(<Chrome />);
      if (!phone) {
        expect(tabIcon("First Class")).toBe("Actor");
        expect(tabIcon("Second Class")).toBe("Actor");
        expect(screen.getAllByTestId("document-tab")).toHaveLength(4);
      }
      fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^First/ })),
      ).toBe("Actor");
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^Second/ })),
      ).toBe("Actor");
      expect(list.mock.calls.length).toBeLessThanOrEqual(1);

      // Resaved with another parent: the registry reindexes a new header.
      await registry.deleteAsset("base");
      await registry.createAsset("project", "base.class.babasset", {
        guid: "base",
        name: "Shared Base",
        type: "Class",
        parentClass: "ActorComponent",
        version: 1,
        dependencies: [],
        payload: {},
        chunks: [],
      });
      state.documents[2]!.dirty = true;
      state.errorCount = 2;
      list.mockClear();
      view.rerender(<Chrome />);
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^First/ })),
      ).toBe("ActorComponent");
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^Second/ })),
      ).toBe("ActorComponent");
      expect(screen.getByLabelText("Unsaved Changes")).toBeTruthy();
      if (!phone) {
        expect(tabIcon("First Class *")).toBe("ActorComponent");
        expect(tabIcon("Second Class")).toBe("ActorComponent");
      }
      expect(list.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("uses indexed asset types and missing-asset fallbacks without enumerating non-Class assets", async () => {
    const registry = await createRegistry();
    await registry.createAsset("project", "sheet.texture.babasset", {
      guid: "sheet",
      name: "Sheet",
      type: "Sprite",
      version: 1,
      dependencies: [],
      payload: {},
      chunks: [],
    });
    state.documents = [
      openDocument(
        "sheet",
        createDocumentRef("texture", "assets/sheet.texture.babasset"),
      ),
      openDocument(
        "missing",
        createDocumentRef("texture", "assets/missing.texture.babasset"),
      ),
    ];
    const list = vi.spyOn(registry, "list");
    const view = render(<Chrome />);
    expect(tabIcon("Sheet.texture Texture")).toBe("Sprite");
    expect(tabIcon("Missing.texture Texture")).toBe("Texture");
    expect(list).not.toHaveBeenCalled();

    state.registry = null;
    view.rerender(<Chrome />);
    expect(tabIcon("Sheet.texture Texture")).toBe("Texture");
    expect(list).not.toHaveBeenCalled();
  });
});
