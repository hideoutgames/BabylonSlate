import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@haptic/vfs";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { HomepageUpdateBadge } from "./homepage-update-badge";

/** The desktop preload's `updates` bridge, as main would answer it. */
function installBridge(initial: AppUpdateStatus) {
  let push: (status: AppUpdateStatus) => void = () => {};
  const bridge = {
    status: vi.fn(async () => initial),
    restart: vi.fn(async () => true),
    onStatus: vi.fn((listener: (status: AppUpdateStatus) => void) => {
      push = listener;
      return vi.fn();
    }),
  };
  (globalThis as { haptic?: unknown }).haptic = { updates: bridge };
  return { bridge, push: (status: AppUpdateStatus) => act(() => push(status)) };
}

function renderBadge() {
  return render(
    <TooltipProvider>
      <HomepageUpdateBadge />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete (globalThis as { haptic?: unknown }).haptic;
});

describe("Homepage update badge", () => {
  it("shows nothing where the host does not update itself", () => {
    const { container } = renderBadge();
    expect(container.textContent).toBe("");
  });

  it("shows the download's progress, then restarts into the downloaded update", async () => {
    const { bridge, push } = installBridge({
      state: "downloading",
      version: "1.2.4",
      percent: 40,
    });
    const { unmount } = renderBadge();
    const progress = await screen.findByRole("progressbar", { name: "Downloading Update" });
    expect(progress.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.queryByRole("button")).toBeNull();

    push({ state: "ready", version: "1.2.4" });
    const restart = screen.getByRole("button", { name: "Restart to Update" });
    fireEvent.click(restart);
    expect(bridge.restart).toHaveBeenCalledOnce();
    expect(restart).toHaveProperty("disabled", true);

    push({ state: "idle" });
    expect(screen.queryByRole("button", { name: "Restart to Update" })).toBeNull();
    const unsubscribe = bridge.onStatus.mock.results[0]!.value;
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("offers Restart to Update again when the host has nothing to install", async () => {
    const { bridge } = installBridge({ state: "ready", version: "1.2.4" });
    bridge.restart.mockResolvedValue(false);
    renderBadge();
    const restart = await screen.findByRole("button", { name: "Restart to Update" });
    fireEvent.click(restart);
    await waitFor(() => expect(restart).toHaveProperty("disabled", false));
  });
});
