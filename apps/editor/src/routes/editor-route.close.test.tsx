import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import type { OpenDocument } from "../services/document-service";
import EditorRoute from "./editor-route";

const state = vi.hoisted(() => ({
  documents: [] as OpenDocument[],
  saveAll: vi.fn(async () => true),
  closeDocument: vi.fn((id: string) => {
    state.documents = state.documents.filter((doc) => doc.id !== id);
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: state.documents,
    dirtyDocuments: state.documents.filter((doc) => doc.dirty),
    migrationPending: [],
    pendingExclusiveScene: null,
    externalChangePrompt: null,
    cancelExclusiveSceneOpen: vi.fn(),
    saveAll: state.saveAll,
    closeDocument: state.closeDocument,
  }),
}));

// Keep the document menu and close dialogs real; omit unrelated engine hosts.
vi.mock("../components/editor-chrome-bar", async () => {
  const { DocumentSwitcher } = await import("../components/document-switcher");
  return {
    EditorChromeBar: ({
      onCloseDocument,
      onCloseAllDocuments,
    }: {
      onCloseDocument: (id: string) => void;
      onCloseAllDocuments: () => void;
    }) => (
      <DocumentSwitcher
        documents={state.documents}
        activeDocumentId="scene"
        onSelect={() => {}}
        onClose={onCloseDocument}
        onCloseAll={onCloseAllDocuments}
      />
    ),
  };
});
vi.mock("../context/asset-open-provider", () => ({
  AssetOpenDocumentsProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../context/validation-context", () => ({
  ValidationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/play-context", () => ({
  PlayProvider: ({ children }: { children: ReactNode }) => children,
  usePlay: () => ({}),
}));
vi.mock("../context/material-render-control-context", () => ({
  MaterialRenderControlProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../context/project-search-context", () => ({
  ProjectSearchProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/component-gallery", () => ({
  ComponentGallery: () => null,
}));
vi.mock("../components/document-workspace", () => ({
  DocumentWorkspace: () => null,
}));
vi.mock("../components/external-change-dialogs", () => ({
  ExternalChangeDialogs: () => null,
}));
vi.mock("../components/editor-utility-runtime", () => ({
  EditorUtilityRuntime: () => null,
}));
vi.mock("../components/model-thumbnail-capture-host", () => ({
  ModelThumbnailCaptureHost: () => null,
}));
vi.mock("../lib/test-audio-host-stats", () => ({
  TestAudioHostStats: () => null,
}));
vi.mock("../lib/test-particle-host-stats", () => ({
  TestParticleHostStats: () => null,
}));

beforeEach(() => {
  state.documents = [
    {
      id: CONTENT_BROWSER_ID,
      ref: CONTENT_BROWSER_REF,
      content: null,
      layout: null,
      dirty: false,
    },
    {
      id: "scene",
      ref: createDocumentRef("scene", "assets/Main.scene.babasset"),
      content: null,
      layout: null,
      dirty: true,
    },
    {
      id: "graph",
      ref: createDocumentRef("graph", "assets/Hero.class.babasset"),
      content: null,
      layout: null,
      dirty: true,
    },
    {
      id: "other",
      ref: createDocumentRef("graph", "assets/Other.class.babasset"),
      content: null,
      layout: null,
      dirty: false,
    },
  ];
  state.saveAll.mockReset().mockResolvedValue(true);
  state.closeDocument.mockClear();
});
afterEach(cleanup);

function requestBulkClose() {
  fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }));
}

describe("document tab close requests", () => {
  it("closes all clean document tabs and leaves Content Browser open", () => {
    state.documents.forEach((doc) => {
      doc.dirty = false;
    });
    render(<EditorRoute />);
    requestBulkClose();
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
    expect(screen.queryByTestId("dirty-close-dialog")).toBeNull();
  });

  it("lists every dirty tab and cancels without closing any tabs", () => {
    render(<EditorRoute />);
    requestBulkClose();
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["Main Scene", "Hero Class"]);
    fireEvent.click(screen.getByTestId("dirty-cancel"));
    expect(state.documents.map((doc) => doc.id)).toEqual([
      CONTENT_BROWSER_ID,
      "scene",
      "graph",
      "other",
    ]);
    expect(state.saveAll).not.toHaveBeenCalled();
  });

  it("discards all requested tabs through one prompt", () => {
    render(<EditorRoute />);
    requestBulkClose();
    fireEvent.click(screen.getByTestId("dirty-discard"));
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
    expect(state.saveAll).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "closes tabs only after a successful save (save result: %s)",
    async (saved) => {
      state.saveAll.mockResolvedValue(saved);
      render(<EditorRoute />);
      requestBulkClose();
      fireEvent.click(screen.getByTestId("dirty-save"));
      await waitFor(() => expect(state.saveAll).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(state.documents.map((doc) => doc.id)).toEqual(
          saved
            ? [CONTENT_BROWSER_ID]
            : [CONTENT_BROWSER_ID, "scene", "graph", "other"],
        ),
      );
    },
  );

  it("still closes only the active tab for the individual close action", () => {
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Main Scene" }));
    fireEvent.click(screen.getByTestId("dirty-discard"));
    expect(state.documents.map((doc) => doc.id)).toEqual([
      CONTENT_BROWSER_ID,
      "graph",
      "other",
    ]);
  });
});
