import { afterEach, describe, expect, it, vi } from "vitest";
import { resetUiHostStats } from "@babylonslate/render";
import { pinLayout, stretchLayout } from "@babylonslate/ui-runtime";
import { createUiDesignerSession } from "./ui-designer-session";

function createHarness() {
  const host = {
    setGestureLocked: vi.fn(),
    patchLiveLayout: vi.fn(),
    markAsDirty: vi.fn(),
  };
  const present = vi.fn();
  const commitLayout = vi.fn();
  const onOverlay = vi.fn();
  const frames: FrameRequestCallback[] = [];
  const session = createUiDesignerSession({
    getHost: () => host,
    present,
    schedule: (work) => {
      frames.push(work);
    },
    commitLayout,
    onOverlay,
  });
  return { host, present, commitLayout, onOverlay, frames, session };
}

afterEach(() => {
  resetUiHostStats();
});

describe("createUiDesignerSession", () => {
  it("locks the host and patches live layout without committing on preview", () => {
    const { host, commitLayout, onOverlay, frames, session } = createHarness();
    const layout = pinLayout("left", "top", 160, 36, 12, 8);
    session.preview("btn", layout);
    expect(host.setGestureLocked).toHaveBeenCalledWith(true);
    expect(host.patchLiveLayout).toHaveBeenCalledWith("btn", layout);
    expect(host.markAsDirty).toHaveBeenCalled();
    expect(onOverlay).toHaveBeenCalledWith("btn", layout);
    expect(commitLayout).not.toHaveBeenCalled();
    expect(session.locked).toBe(true);
    frames[0]?.(0);
  });

  it("coalesces presents onto the scheduler and commits once", () => {
    const { present, commitLayout, frames, session } = createHarness();
    const first = pinLayout("left", "top", 160, 36, 0, 0);
    const second = pinLayout("left", "top", 160, 36, 20, 0);
    session.preview("btn", first);
    session.preview("btn", second);
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(present).toHaveBeenCalledTimes(1);
    session.commit();
    expect(commitLayout).toHaveBeenCalledTimes(1);
    const [id, layout, mergeKey] = commitLayout.mock.calls[0] as [
      string,
      { left: number },
      string,
    ];
    expect(id).toBe("btn");
    expect(layout.left).toBe(20);
    expect(mergeKey).toMatch(/^ui-design-stroke:/);
    expect(session.locked).toBe(false);
  });

  it("unlocks the host after commit", () => {
    const { host, session } = createHarness();
    session.preview("btn", pinLayout("left", "top", 80, 32));
    session.commit();
    expect(host.setGestureLocked).toHaveBeenLastCalledWith(false);
  });

  it("cancel restores the layout from the first preview of the stroke", () => {
    const { host, commitLayout, onOverlay, session } = createHarness();
    const original = pinLayout("left", "top", 160, 36, 12, 8);
    const moved = pinLayout("left", "top", 160, 36, 40, 8);
    session.preview("btn", original);
    session.preview("btn", moved);
    session.cancel();
    expect(commitLayout).not.toHaveBeenCalled();
    expect(host.patchLiveLayout).toHaveBeenLastCalledWith("btn", original);
    expect(onOverlay).toHaveBeenLastCalledWith("btn", original);
    expect(session.locked).toBe(false);
  });

  it("schedules a present on the next stroke after commit", () => {
    const { frames, session } = createHarness();
    session.preview("btn", pinLayout("left", "top", 80, 32));
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    session.commit();
    session.preview("btn", pinLayout("left", "top", 90, 32));
    expect(frames).toHaveLength(2);
  });
});
