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
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    projectName: "Test",
    openDocuments: state.documents,
    activeDocumentId: "first",
    dirtyDocuments: state.documents.filter((doc) => doc.dirty),
    projectDirty: false,
    assetRegistry: state.registry,
  }),
}));
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

function Chrome() {
  return (
    <MaterialRenderControlProvider>
      <TooltipProvider>
        <EditorChromeBar />
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.registry = null;
  state.documents = [];
  state.phone = false;
  state.errorCount = 0;
});

describe("chrome document icons", () => {
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
        const tabs = within(screen.getByTestId("document-tab-bar"));
        expect(
          typeIcon(tabs.getByRole("button", { name: "First Class" })),
        ).toBe("Actor");
        expect(
          typeIcon(tabs.getByRole("button", { name: "Second Class" })),
        ).toBe("Actor");
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

      registry.getByGuid("base")!.header.parentClass = "ActorComponent";
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
        const tabs = within(screen.getByTestId("document-tab-bar"));
        expect(
          typeIcon(tabs.getByRole("button", { name: "First Class *" })),
        ).toBe("ActorComponent");
        expect(
          typeIcon(tabs.getByRole("button", { name: "Second Class" })),
        ).toBe("ActorComponent");
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
    expect(
      typeIcon(screen.getByRole("button", { name: "Sheet.texture Texture" })),
    ).toBe("Sprite");
    expect(
      typeIcon(screen.getByRole("button", { name: "Missing.texture Texture" })),
    ).toBe("Texture");
    expect(list).not.toHaveBeenCalled();

    state.registry = null;
    view.rerender(<Chrome />);
    expect(
      typeIcon(screen.getByRole("button", { name: "Sheet.texture Texture" })),
    ).toBe("Texture");
    expect(list).not.toHaveBeenCalled();
  });
});
