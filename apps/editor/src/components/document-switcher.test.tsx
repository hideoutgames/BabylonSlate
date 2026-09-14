import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import type { OpenDocument } from "../services/document-service";
import type { IndexedAsset } from "@babylonslate/assets";
import { DocumentSwitcher } from "./document-switcher";

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
  it("shows the inherited engine-class icon for a project Class", () => {
    const assets: IndexedAsset[] = [
      { name: "Hero", parentClass: "BaseHero" },
      { name: "BaseHero", parentClass: "Actor" },
    ].map(({ name, parentClass }) => ({
      rootId: "project",
      path: `assets/${name}.class.babasset`,
      header: {
        guid: name,
        type: "Class",
        name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass,
        payload: {},
        chunks: [],
      },
    }));
    const screen = render(
      <DocumentSwitcher documents={documents} assets={assets} activeDocumentId="graph" onSelect={() => {}} onClose={() => {}} />,
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
});
