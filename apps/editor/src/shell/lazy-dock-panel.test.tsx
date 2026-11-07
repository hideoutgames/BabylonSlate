import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { WorkspaceErrorBoundary } from "../components/workspace-error-boundary";
import { lazyPanel } from "./lazy-dock-panel";

afterEach(() => {
  cleanup();
});

const panelProps = {} as IDockviewPanelProps;

const family = {
  PaintPanel: () => <div>Tilemap Paint</div>,
  DetailsPanel: () => <div>Tilemap Details</div>,
};

// How Vite's preload helper ends a family import whose chunk did not download: it rejects, or it resolves `undefined`
// when `installPreloadErrorReload` took the error to reload the page and the user chose to stay on it.
const DOWNLOAD_FAILURES: [string, () => Promise<unknown>, string][] = [
  [
    "rejects",
    () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/2d.js")),
    "Failed to fetch dynamically imported module",
  ],
  ["resolves without a module", () => Promise.resolve(undefined), "This editor's files didn't download."],
];

describe("lazyPanel", () => {
  it.each(DOWNLOAD_FAILURES)("downloads the family again on Retry after its import %s", async (_name, fail, message) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let downloaded = false;
    const load = vi.fn(() => (downloaded ? Promise.resolve(family) : fail()) as Promise<typeof family>);
    const Paint = lazyPanel(load, (m) => m.PaintPanel);
    const Details = lazyPanel(load, (m) => m.DetailsPanel);
    try {
      render(
        <WorkspaceErrorBoundary>
          <Paint {...panelProps} />
          <Details {...panelProps} />
        </WorkspaceErrorBoundary>,
      );
      expect((await screen.findByTestId("workspace-error")).textContent).toContain(message);

      // Still unavailable: Retry tries the download again and reports it failing again.
      const attempts = load.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect((await screen.findByTestId("workspace-error")).textContent).toContain(message);
      expect(load.mock.calls.length).toBeGreaterThan(attempts);

      downloaded = true;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("Tilemap Paint")).toBeTruthy();
      expect(screen.getByText("Tilemap Details")).toBeTruthy();
      expect(screen.queryByTestId("workspace-error")).toBeNull();
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
