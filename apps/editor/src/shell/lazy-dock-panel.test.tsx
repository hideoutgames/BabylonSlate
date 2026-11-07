import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { WorkspaceErrorBoundary } from "../components/workspace-error-boundary";
import { reloadForNewBuild } from "../lib/preload-error-reload";
import { lazyPanel } from "./lazy-dock-panel";

// The page reload is the one boundary jsdom cannot cross; the error class stays real.
vi.mock("../lib/preload-error-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/preload-error-reload")>()),
  reloadForNewBuild: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(reloadForNewBuild).mockClear();
});

const panelProps = {} as IDockviewPanelProps;

const family = {
  PaintPanel: () => <div>Tilemap Paint</div>,
  DetailsPanel: () => <div>Tilemap Details</div>,
};

// How Vite's preload helper ends a family import whose chunk did not load: it rejects, or it resolves `undefined`
// when `installPreloadErrorReload` took the error to reload the page and the user chose to stay on it.
const LOAD_FAILURES: [string, () => Promise<unknown>][] = [
  ["rejects", () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/2d.js"))],
  ["resolves without a module", () => Promise.resolve(undefined)],
];

describe("lazyPanel", () => {
  it.each(LOAD_FAILURES)("loads the family again on Retry after its import %s, and offers Reload Editor", async (_name, fail) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let available = false;
    const load = vi.fn(() => (available ? Promise.resolve(family) : fail()) as Promise<typeof family>);
    const Paint = lazyPanel(load, (m) => m.PaintPanel);
    const Details = lazyPanel(load, (m) => m.DetailsPanel);
    try {
      render(
        <WorkspaceErrorBoundary>
          <Paint {...panelProps} />
          <Details {...panelProps} />
        </WorkspaceErrorBoundary>,
      );
      expect((await screen.findByTestId("workspace-error")).textContent).toContain("This document's editor didn't load.");
      // One attempt per panel, and none while the error shows.
      expect(load).toHaveBeenCalledTimes(2);

      // A newer deploy may have replaced the chunk: Reload Editor loads the deployed build.
      fireEvent.click(screen.getByRole("button", { name: "Reload Editor" }));
      expect(reloadForNewBuild).toHaveBeenCalledTimes(1);

      // Still unavailable: Retry loads it again and reports it failing again.
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect((await screen.findByTestId("workspace-error")).textContent).toContain("This document's editor didn't load.");
      expect(load).toHaveBeenCalledTimes(4);

      available = true;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("Tilemap Paint")).toBeTruthy();
      expect(screen.getByText("Tilemap Details")).toBeTruthy();
      expect(screen.queryByTestId("workspace-error")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the failure when the panel re-renders as its load fails, instead of loading again", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectLoad!: (error: unknown) => void;
    const load = vi.fn(() => new Promise<typeof family>((_resolve, reject) => (rejectLoad = reject)));
    const Paint = lazyPanel(load, (m) => m.PaintPanel);
    let updateParams!: () => void;
    // DockView re-renders a panel when its parameters change, in the same render as the failed load here.
    function DockHost() {
      const [revision, setRevision] = useState(0);
      updateParams = () => setRevision((value) => value + 1);
      return <Paint {...({ params: { revision } } as unknown as IDockviewPanelProps)} />;
    }
    try {
      render(
        <WorkspaceErrorBoundary>
          <DockHost />
        </WorkspaceErrorBoundary>,
      );
      await act(async () => {
        rejectLoad(new TypeError("Failed to fetch dynamically imported module: /assets/2d.js"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        updateParams();
      });
      expect(screen.getByTestId("workspace-error").textContent).toContain("This document's editor didn't load.");
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("shows a loaded family's panel at once when it mounts again", async () => {
    const load = vi.fn(() => Promise.resolve(family));
    const Paint = lazyPanel(load, (m) => m.PaintPanel);
    render(<Paint {...panelProps} />);
    expect(await screen.findByText("Tilemap Paint")).toBeTruthy();
    cleanup();

    render(<Paint {...panelProps} />);
    expect(screen.getByText("Tilemap Paint")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
