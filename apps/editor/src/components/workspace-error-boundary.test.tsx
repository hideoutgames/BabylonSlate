import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceErrorBoundary } from "./workspace-error-boundary";

afterEach(() => {
  cleanup();
});

function Boom(): never {
  throw new Error("scene settings.grid is missing");
}

describe("WorkspaceErrorBoundary", () => {
  it("retries a failed document without removing sibling chrome", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let failed = true;
    function Document() {
      if (failed) throw new Error("Temporary load failure");
      return <div>Document Ready</div>;
    }
    try {
      render(<><div>Editor Chrome</div><WorkspaceErrorBoundary><Document /></WorkspaceErrorBoundary></>);
      failed = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(screen.getByText("Document Ready")).toBeTruthy();
      expect(screen.getByText("Editor Chrome")).toBeTruthy();
      expect(screen.queryByTestId("workspace-error")).toBeNull();
    } finally { spy.mockRestore(); }
  });
  it("keeps sibling chrome mounted when a document panel throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <div data-testid="editor-chrome-bar">Chrome</div>
        <WorkspaceErrorBoundary>
          <Boom />
        </WorkspaceErrorBoundary>
      </div>,
    );
    expect(screen.getByTestId("editor-chrome-bar")).toBeTruthy();
    expect(screen.getByTestId("workspace-error")).toBeTruthy();
    expect(screen.getByTestId("workspace-error").textContent).toContain(
      "scene settings.grid is missing",
    );
    spy.mockRestore();
  });
});
