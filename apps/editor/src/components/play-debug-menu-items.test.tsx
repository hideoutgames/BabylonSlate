import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { PlayDebugMenuItems } from "./play-debug-menu-items";

function renderMenu(
  overrides: Partial<Parameters<typeof PlayDebugMenuItems>[0]> = {},
) {
  const onOverlayStatsChange = vi.fn();
  const onOverlayConsoleChange = vi.fn();
  const onOverlayInspectorChange = vi.fn();
  const onPauseOnPlayChange = vi.fn();
  const onPreviewBuildChange = vi.fn();
  const view = render(
    <DropdownMenu open>
      <DropdownMenuTrigger render={<Button data-testid="debug-menu">Debug</Button>} />
      <PlayDebugMenuItems
        overlayStats
        overlayConsole
        overlayInspector
        pauseOnPlay={false}
        previewBuild={false}
        sessionLocked={false}
        onOverlayStatsChange={onOverlayStatsChange}
        onOverlayConsoleChange={onOverlayConsoleChange}
        onOverlayInspectorChange={onOverlayInspectorChange}
        onPauseOnPlayChange={onPauseOnPlayChange}
        onPreviewBuildChange={onPreviewBuildChange}
        {...overrides}
      />
    </DropdownMenu>,
  );
  return {
    ...view,
  };
}

describe("PlayDebugMenuItems", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists Play Overlay and Session checkboxes with overlay chrome on", () => {
    renderMenu();
    expect(screen.getByTestId("overlay-stats-toggle").textContent).toContain(
      "Stats",
    );
    expect(screen.getByTestId("overlay-console-toggle").textContent).toContain(
      "Console",
    );
    expect(screen.getByTestId("overlay-inspector-toggle").textContent).toContain(
      "Inspector",
    );
    expect(screen.getByTestId("pause-on-play-toggle").textContent).toContain(
      "Pause On Play",
    );
    expect(screen.getByTestId("preview-build-toggle").textContent).toContain(
      "Preview Build",
    );
    expect(screen.getByTestId("overlay-stats-toggle").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("overlay-console-toggle").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("overlay-inspector-toggle").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("pause-on-play-toggle").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByTestId("preview-build-toggle").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("keeps overlay chrome toggles enabled while a session is locked", () => {
    renderMenu({
      sessionLocked: true,
    });
    expect(
      screen.getByTestId("overlay-stats-toggle").getAttribute("data-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("overlay-console-toggle").getAttribute("data-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("overlay-inspector-toggle").getAttribute("data-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("pause-on-play-toggle").getAttribute("data-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("preview-build-toggle").getAttribute("data-disabled"),
    ).not.toBeNull();
  });
});
