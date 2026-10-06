import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import type { OpenDocument } from "../services/document-service";
import { AssetRegistry, projectContentRoot } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createDocumentTypeVisualResolver } from "../lib/document-type-visual";
import { DocumentSwitcher } from "./document-switcher";
import { KeybindProvider } from "../context/keybind-context";

afterEach(cleanup);

const documents: OpenDocument[] = [
  {
    id: CONTENT_BROWSER_ID,
    ref: CONTENT_BROWSER_REF,
    content: null,
    layout: null,
    dirty: false,
  },
  {
    id: "scene",
    ref: createDocumentRef("scene", "assets/main.scene.babasset"),
    content: null,
    layout: null,
    dirty: true,
  },
  {
    id: "graph",
    ref: createDocumentRef("graph", "assets/Hero.class.babasset"),
    content: null,
    layout: null,
    dirty: false,
  },
];

describe("DocumentSwitcher", () => {
  it("cycles documents, opens Content Browser, and uses the existing close handlers", () => {
    const close = vi.fn();
    const closeAll = vi.fn();
    function Workspace() {
      const [active, setActive] = useState("scene");
      return <KeybindProvider><DocumentSwitcher documents={documents} activeDocumentId={active}
        onSelect={setActive} onClose={close} onCloseAll={closeAll} compact /></KeybindProvider>;
    }
    const view = render(<Workspace />);
    fireEvent.keyDown(document.body, { key: "w", code: "KeyW", altKey: true });
    expect(close).toHaveBeenCalledExactlyOnceWith("scene");
    fireEvent.keyDown(document.body, { key: "PageDown", code: "PageDown", altKey: true });
    expect(view.getByRole("button", { name: "Open Documents" }).textContent).toContain("Hero");
    fireEvent.keyDown(document.body, { key: "PageDown", code: "PageDown", altKey: true });
    expect(view.getByRole("button", { name: "Open Documents" }).textContent).toContain("Content Browser");
    fireEvent.keyDown(document.body, { key: "w", code: "KeyW", altKey: true });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "PageUp", code: "PageUp", altKey: true });
    expect(view.getByRole("button", { name: "Open Documents" }).textContent).toContain("Hero");
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", altKey: true });
    expect(view.getByRole("button", { name: "Open Documents" }).textContent).toContain("Content Browser");
    fireEvent.keyDown(document.body, { key: "W", code: "KeyW", altKey: true, shiftKey: true });
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it("shows the inherited engine-class icon for a project Class", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("test.babproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    for (const { name, parentClass } of [
      { name: "Hero", parentClass: "BaseHero" },
      { name: "BaseHero", parentClass: "Actor" },
    ]) {
      await registry.createAsset("project", `${name}.class.babasset`, {
        guid: name,
        type: "Class",
        name,
        version: 1,
        dependencies: [],
        parentClass,
        payload: {},
        chunks: [],
      });
    }
    const screen = render(
      <DocumentSwitcher documents={documents} resolveVisual={createDocumentTypeVisualResolver(registry)} activeDocumentId="graph" onSelect={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    const hero = screen.getByRole("menuitemradio", { name: /Hero/i });
    expect(hero.querySelector("[data-type-icon]")?.getAttribute("data-type-icon")).toBe("Actor");
  });

  it("lets a touch user switch directly to any document and identifies unsaved work", async () => {
    function Workspace() {
      const [active, setActive] = useState(CONTENT_BROWSER_ID);
      return (
        <DocumentSwitcher
          documents={documents}
          activeDocumentId={active}
          onSelect={setActive}
          onClose={() => {}}
          compact
        />
      );
    }
    const screen = render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    const scene = screen.getByRole("menuitemradio", {
      name: /main.*Unsaved Changes/i,
    });
    expect(scene.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(scene);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Documents" }).textContent,
      ).toContain("Main Scene"),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(
      screen
        .getByRole("menuitemradio", { name: /main.*Unsaved Changes/i })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("routes closing the active document through the unsaved-close handler and keeps Content Browser pinned", async () => {
    const close = vi.fn();
    const screen = render(
      <DocumentSwitcher
        documents={documents}
        activeDocumentId="scene"
        onSelect={() => {}}
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Close main/i }));
    expect(close).toHaveBeenCalledWith("scene");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    screen.rerender(
      <DocumentSwitcher
        documents={documents}
        activeDocumentId={CONTENT_BROWSER_ID}
        onSelect={() => {}}
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.queryByRole("menuitem", { name: /Close main/i })).toBeNull();
  });

  it("offers bulk close from Content Browser and disables it when no document tabs remain", () => {
    const closeAll = vi.fn();
    const screen = render(
      <DocumentSwitcher
        documents={documents}
        activeDocumentId={CONTENT_BROWSER_ID}
        onSelect={() => {}}
        onClose={() => {}}
        onCloseAll={closeAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Close Open Tab(s)" }),
    );
    expect(closeAll).toHaveBeenCalledOnce();
    screen.rerender(
      <DocumentSwitcher
        documents={[documents[0]!]}
        activeDocumentId={CONTENT_BROWSER_ID}
        onSelect={() => {}}
        onClose={() => {}}
        onCloseAll={closeAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(
      screen
        .getByRole("menuitem", { name: "Close Open Tab(s)" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps the bulk-close menu and shortcut available for background records without adding navigation entries", async () => {
    const closeAll = vi.fn();
    const view = (hasClosableDocuments: boolean) => <KeybindProvider>
      <DocumentSwitcher documents={[documents[0]!]} activeDocumentId={CONTENT_BROWSER_ID}
        onSelect={() => {}} onClose={() => {}} onCloseAll={closeAll} hasClosableDocuments={hasClosableDocuments} />
    </KeybindProvider>;
    const screen = render(view(true));
    fireEvent.keyDown(document.body, { key: "W", code: "KeyW", altKey: true, shiftKey: true });
    expect(closeAll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }));
    expect(closeAll).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    screen.rerender(view(false));
    fireEvent.keyDown(document.body, { key: "W", code: "KeyW", altKey: true, shiftKey: true });
    expect(closeAll).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }).getAttribute("aria-disabled")).toBe("true");
  });
});
