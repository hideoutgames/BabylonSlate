import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceErrorBoundary } from "./workspace-error-boundary";

afterEach(() => {
  cleanup();
});

function Boom(): never {
  throw new Error("scene settings.grid is missing");
}

describe("WorkspaceErrorBoundary", () => {
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
