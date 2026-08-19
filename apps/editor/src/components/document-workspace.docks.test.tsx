import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  AnimDocumentDocks,
  UiDocumentDocks,
} from "./document-workspace";

const docs = vi.hoisted(() => ({
  uiEditorMode: "designer" as "designer" | "logic",
  animEditorMode: "stateMachine" as "stateMachine" | "animationObject",
  activeDocumentId: "ui:hud",
  setUiEditorMode: vi.fn(),
  setAnimEditorMode: vi.fn(),
  registerDockviewApi: vi.fn(),
  captureLayoutForId: vi.fn(),
  unregisterDockviewApi: vi.fn(),
  sourceControl: { enabled: false },
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => docs,
}));

vi.mock("../shell/dockview-shell", () => ({
  DockviewShell: (props: {
    uiEditorMode?: string;
    animEditorMode?: string;
    documentKind: string;
  }) => (
    <div
      data-testid={`mock-dock-${props.uiEditorMode ?? props.animEditorMode ?? props.documentKind}`}
    />
  ),
}));

vi.mock("./document-lock-banner", () => ({
  DocumentLockBanner: () => null,
}));

afterEach(() => {
  cleanup();
  docs.uiEditorMode = "designer";
  docs.animEditorMode = "stateMachine";
  docs.activeDocumentId = "ui:hud";
  docs.captureLayoutForId.mockClear();
  docs.unregisterDockviewApi.mockClear();
});

describe("mode DockView unmount", () => {
  it("mounts only the active UserInterface DockView", () => {
    docs.uiEditorMode = "designer";
    docs.activeDocumentId = "ui:hud";
    const { rerender } = render(
      <UiDocumentDocks
        id="ui:hud"
        layout={null}
      />,
    );
    expect(screen.getByTestId("mock-dock-designer")).toBeTruthy();
    expect(screen.queryByTestId("mock-dock-logic")).toBeNull();
    docs.uiEditorMode = "logic";
    rerender(
      <UiDocumentDocks
        id="ui:hud"
        layout={null}
      />,
    );
    expect(screen.queryByTestId("mock-dock-designer")).toBeNull();
    expect(screen.getByTestId("mock-dock-logic")).toBeTruthy();
    expect(docs.captureLayoutForId).toHaveBeenCalledWith("ui:hud");
    expect(docs.unregisterDockviewApi).toHaveBeenCalled();
  });

  it("mounts only the active Animation Graph DockView", () => {
    docs.animEditorMode = "stateMachine";
    docs.activeDocumentId = "anim:hero";
    const { rerender } = render(
      <AnimDocumentDocks id="anim:hero" layout={null} />,
    );
    expect(screen.getByTestId("mock-dock-stateMachine")).toBeTruthy();
    expect(screen.queryByTestId("mock-dock-animationObject")).toBeNull();
    docs.animEditorMode = "animationObject";
    rerender(<AnimDocumentDocks id="anim:hero" layout={null} />);
    expect(screen.queryByTestId("mock-dock-stateMachine")).toBeNull();
    expect(screen.getByTestId("mock-dock-animationObject")).toBeTruthy();
  });
});
