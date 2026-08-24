import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AnimDocumentDocks } from "./document-workspace";

const docs = vi.hoisted(() => ({
  animEditorMode: "stateMachine" as "stateMachine" | "animationObject",
  activeDocumentId: "anim:hero",
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
    animEditorMode?: string;
    documentKind: string;
  }) => (
    <div
      data-testid={`mock-dock-${props.animEditorMode ?? props.documentKind}`}
    />
  ),
}));

vi.mock("./document-lock-banner", () => ({
  DocumentLockBanner: () => null,
}));

afterEach(() => {
  cleanup();
  docs.animEditorMode = "stateMachine";
  docs.activeDocumentId = "anim:hero";
  docs.captureLayoutForId.mockClear();
  docs.unregisterDockviewApi.mockClear();
});

describe("mode DockView unmount", () => {
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
