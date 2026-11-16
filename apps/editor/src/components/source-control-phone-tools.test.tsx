import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { integratedSync } from "../testing/integrated-sync";
import { SourceControlActionsProvider } from "./source-control-actions";
import { SourceControlPhoneTools } from "./source-control-phone-tools";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  setActiveDocument: vi.fn(),
  activateDockPanel: vi.fn(),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    setActiveDocument: state.setActiveDocument,
    activateDockPanel: state.activateDockPanel,
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.setActiveDocument.mockClear();
  state.activateDockPanel.mockClear();
});

function renderTools(onAction = vi.fn()) {
  render(
    <SourceControlActionsProvider>
      <SourceControlPhoneTools onAction={onAction} />
    </SourceControlActionsProvider>,
  );
  return onAction;
}

describe("More Tools in Integrated mode", () => {
  it("switches branch from a menu of this copy's and the remote's branches", async () => {
    const { service, remote } = await integratedSync();
    remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
    state.sync = service;
    const onAction = renderTools();
    fireEvent.click(screen.getByTestId("phone-source-control-switch-branch"));
    expect(screen.getByTestId("phone-source-control-switch-branch").textContent).toContain("main");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("phone-source-control-remote-art"));
    });
    // Choosing closes the sheet, and the switch asks first.
    expect(onAction).toHaveBeenCalled();
    expect((await screen.findByTestId("source-control-switch-confirm")).textContent).toContain("Switch To art?");
  });

  it("starts New Branch… and opens History", async () => {
    const { service } = await integratedSync();
    state.sync = service;
    const onAction = renderTools();
    await act(async () => {
      fireEvent.click(screen.getByTestId("phone-source-control-new-branch"));
    });
    expect(await screen.findByTestId("source-control-new-branch")).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    try {
      fireEvent.click(screen.getByTestId("phone-source-control-history"));
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(state.setActiveDocument).toHaveBeenCalledWith("source-control");
    expect(state.activateDockPanel).toHaveBeenCalledWith("history");
  });
});
