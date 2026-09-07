import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { StrictMode } from "react";
import { DockviewShell } from "./dockview-shell";
import { captureAdaptiveDockviewLayout } from "./phone-dock-layout";

const device = vi.hoisted(() => ({ phone: true }));
vi.mock("./use-platform-layout", () => ({
  usePlatformLayoutOptions: () => ({
    singleWindow: device.phone,
    disableFloatingGroups: device.phone,
    disablePopout: device.phone,
    dndStrategy: "pointer",
  }),
}));

// Keep real Dockview, replacing scene/engine contents outside this shell's contract.
vi.mock("./panel-registry", () => {
  const panel = ({ api }: IDockviewPanelProps) => (
    <div>{api.title} Content</div>
  );
  return {
    panelComponents: {
      viewport: panel,
      "scene-outliner": panel,
      "scene-details": panel,
      "output-log": panel,
      "compiler-results": panel,
    },
  };
});

afterEach(() => {
  cleanup();
  device.phone = true;
  vi.restoreAllMocks();
});

describe("phone window navigation", () => {
  it("selects a full-window dock panel through the accessible chooser", () => {
    let dock: DockviewApi | undefined;
    render(
      <StrictMode>
        <DockviewShell
          documentKind="scene"
          onReady={(api) => {
            dock = api;
          }}
        />
      </StrictMode>,
    );
    const chooser = screen.getByRole("combobox", { name: "Window" });
    expect(chooser.textContent).toContain("Viewport");
    fireEvent.click(chooser);
    const outliner = screen.getByRole("option", { name: "Outliner" });
    fireEvent.pointerDown(outliner);
    fireEvent.click(outliner);
    expect(dock!.activePanel?.id).toBe("scene-outliner");
    expect(dock!.getPanel("scene-outliner")!.api.isMaximized()).toBe(true);
    expect(chooser.textContent).toContain("Outliner");
  });

  it("restores the docked layout on resize while keeping the same Dockview API", () => {
    device.phone = false;
    let dock: DockviewApi | undefined;
    const onReady = (api: DockviewApi) => {
      dock = api;
    };
    const { rerender } = render(
      <DockviewShell documentKind="scene" onReady={onReady} />,
    );
    const originalApi = dock;
    const desktop = captureAdaptiveDockviewLayout(dock!);
    device.phone = true;
    rerender(<DockviewShell documentKind="scene" onReady={onReady} />);
    expect(screen.getByRole("combobox", { name: "Window" })).toBeTruthy();
    act(() => dock!.getPanel("scene-details")!.api.setActive());
    expect(captureAdaptiveDockviewLayout(dock!)).toEqual(desktop);
    device.phone = false;
    rerender(<DockviewShell documentKind="scene" onReady={onReady} />);
    expect(screen.queryByRole("combobox", { name: "Window" })).toBeNull();
    expect(dock).toBe(originalApi);
    expect(dock!.hasMaximizedGroup()).toBe(false);
    expect(dock!.panels).toHaveLength(5);
  });

  it("restores saved detached panels without opening a phone browser window", () => {
    device.phone = false;
    let dock: DockviewApi | undefined;
    const onReady = (api: DockviewApi) => {
      dock = api;
    };
    const desktop = render(
      <DockviewShell documentKind="scene" onReady={onReady} />,
    );
    act(() => dock!.addFloatingGroup(dock!.getPanel("scene-details")!));
    const saved = dock!.toJSON();
    const detached = saved.floatingGroups![0]!;
    const popout = {
      ...saved,
      floatingGroups: undefined,
      popoutGroups: [{ data: detached.data, position: null }],
    };
    desktop.unmount();
    device.phone = true;
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <DockviewShell
        documentKind="scene"
        initialLayout={popout as unknown as Record<string, unknown>}
        onReady={onReady}
      />,
    );
    expect(dock!.getPanel("scene-details")?.api.location.type).toBe("grid");
    expect(open).not.toHaveBeenCalled();
    expect(captureAdaptiveDockviewLayout(dock!)).toEqual(popout);
    open.mockRestore();
  });
});
