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
      locks: panel,
      "function-graph": panel,
    },
  };
});

afterEach(() => {
  cleanup();
  device.phone = true;
  vi.restoreAllMocks();
});

/**
 * A desktop scene layout saved while its Inspector tab was titled Details,
 * with that tab floating and a function graph tab open.
 */
function sceneLayoutSavedAsDetails(): Record<string, unknown> {
  device.phone = false;
  let dock: DockviewApi | undefined;
  const desktop = render(
    <DockviewShell
      documentKind="scene"
      onReady={(api) => {
        dock = api;
      }}
    />,
  );
  act(() => {
    dock!.addPanel({
      id: "function-graph:fn-jump",
      component: "function-graph",
      title: "Jump",
    });
    dock!.addFloatingGroup(dock!.getPanel("scene-details")!);
  });
  const saved = dock!.toJSON();
  saved.panels["scene-details"]!.title = "Details";
  desktop.unmount();
  return saved as unknown as Record<string, unknown>;
}

describe("saved layout titles", () => {
  it("restores a saved window under its current title and keeps function graph titles", () => {
    const saved = sceneLayoutSavedAsDetails();
    let dock: DockviewApi | undefined;
    render(
      <DockviewShell
        documentKind="scene"
        initialLayout={saved}
        onReady={(api) => {
          dock = api;
        }}
      />,
    );
    expect(dock!.getPanel("scene-details")!.api.title).toBe("Inspector");
    expect(dock!.getPanel("function-graph:fn-jump")!.api.title).toBe("Jump");
    expect(dock!.toJSON().panels["scene-details"]!.title).toBe("Inspector");
  });

  it("keeps the current title in the desktop layout a phone saves", () => {
    const saved = sceneLayoutSavedAsDetails();
    device.phone = true;
    let dock: DockviewApi | undefined;
    render(
      <DockviewShell
        documentKind="scene"
        initialLayout={saved}
        onReady={(api) => {
          dock = api;
        }}
      />,
    );
    const panels = captureAdaptiveDockviewLayout(dock!).panels as Record<
      string,
      { title?: string }
    >;
    expect(panels["scene-details"]!.title).toBe("Inspector");
    expect(panels["function-graph:fn-jump"]!.title).toBe("Jump");
  });
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

  it("shows a renamed function graph under its new title", async () => {
    let dock: DockviewApi | undefined;
    render(
      <DockviewShell
        documentKind="scene"
        onReady={(api) => {
          dock = api;
        }}
      />,
    );
    act(() => {
      dock!.addPanel({
        id: "function-graph:fn-jump",
        component: "function-graph",
        title: "Jump",
      });
    });
    const chooser = screen.getByRole("combobox", { name: "Window" });
    expect(chooser.textContent).toContain("Jump");
    await act(async () => {
      dock!.getPanel("function-graph:fn-jump")!.api.setTitle("Leap");
    });
    expect(chooser.textContent).toContain("Leap");
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

  it("closes Locks when source control turns off after the dock is ready", () => {
    device.phone = false;
    let dock: DockviewApi | undefined;
    const onReady = (api: DockviewApi) => {
      dock = api;
    };
    const { rerender } = render(
      <DockviewShell documentKind="scene" sourceControl onReady={onReady} />,
    );
    expect(dock!.getPanel("locks")).toBeDefined();
    rerender(
      <DockviewShell documentKind="scene" sourceControl={false} onReady={onReady} />,
    );
    expect(dock!.getPanel("locks")).toBeUndefined();
  });

  it("returns to the saved floating windows when a phone open also closes Locks", () => {
    device.phone = false;
    let dock: DockviewApi | undefined;
    const onReady = (api: DockviewApi) => {
      dock = api;
    };
    const desktop = render(
      <DockviewShell documentKind="scene" sourceControl onReady={onReady} />,
    );
    act(() => dock!.addFloatingGroup(dock!.getPanel("scene-details")!));
    const saved = dock!.toJSON() as unknown as Record<string, unknown>;
    desktop.unmount();
    device.phone = true;
    const phone = render(
      <DockviewShell documentKind="scene" initialLayout={saved} onReady={onReady} />,
    );
    expect(dock!.getPanel("locks")).toBeUndefined();
    expect(captureAdaptiveDockviewLayout(dock!)).toEqual(saved);
    device.phone = false;
    phone.rerender(
      <DockviewShell documentKind="scene" initialLayout={saved} onReady={onReady} />,
    );
    expect(dock!.getPanel("scene-details")!.api.location.type).toBe("floating");
    expect(dock!.getPanel("locks")).toBeUndefined();
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
