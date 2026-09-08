import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import type { OpenDocument } from "../services/document-service";
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
    expect(screen.queryByRole("menuitem", { name: /Close/ })).toBeNull();
  });
});
