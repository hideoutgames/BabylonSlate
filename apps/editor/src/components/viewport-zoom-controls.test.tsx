import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { holdDelayMs, useContextMenu } from "@haptic/editor-kit";
import { defaultEngineSettings } from "@haptic/vfs";
import type { ViewportZoomDrive } from "@haptic/render";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { MemoryAppSettingsStore } from "../../../../packages/vfs/src/test-support/memory-app-settings";
import { AppSettingsProvider, useAppSettings } from "../context/app-settings-context";
import { ViewportZoomControls } from "./viewport-zoom-controls";

afterEach(cleanup);

function fakeDrive() {
  return { start: vi.fn(), stop: vi.fn(), step: vi.fn(), dispose: vi.fn() } satisfies ViewportZoomDrive;
}

let setDisabled: (disabled: boolean) => void = () => {};
let toggleSetting: (on: boolean) => Promise<void> = async () => {};

let closeViewportMenu: () => void = () => {};

/** The viewport panel's shape: a root bound to the real context menu gesture, with the controls inside it. */
function MenuViewport({ drive }: { drive: () => ViewportZoomDrive | null }) {
  const { menu, closeMenu, bind } = useContextMenu({ items: [{ id: "reload", label: "Reload Scene", onSelect: () => {} }] });
  closeViewportMenu = () => act(() => closeMenu());
  return (
    <div {...bind}>
      <div data-testid="menu-surface" />
      <span data-testid="menu-state">{menu?.open ? "open" : "closed"}</span>
      <ViewportZoomControls drive={drive} />
    </div>
  );
}

function Harness({ drive }: { drive: () => ViewportZoomDrive | null }) {
  const [disabled, setDisabledState] = useState(false);
  const { updateSettings } = useAppSettings();
  setDisabled = (next) => act(() => setDisabledState(next));
  toggleSetting = (on) => act(() => updateSettings((settings) => { settings.viewportZoomButtons = on; }));
  return (
    <ViewportZoomControls drive={drive} disabled={disabled} />
  );
}

async function renderControls(options: { on?: boolean; drive?: ViewportZoomDrive } = {}) {
  const store = new MemoryAppSettingsStore();
  await store.save({ ...defaultEngineSettings(), viewportZoomButtons: options.on ?? true });
  const drive = options.drive ?? fakeDrive();
  const view = render(<AppSettingsProvider store={store}>
    <Harness drive={() => drive} />
  </AppSettingsProvider>);
  if (options.on ?? true) await screen.findByRole("group", { name: "Viewport Zoom" });
  return { view, drive };
}

const zoomIn = () => screen.getByRole("button", { name: "Zoom In" });
const zoomOut = () => screen.getByRole("button", { name: "Zoom Out" });

/** A pointer press as a browser sends it: down, up, then the trailing click. */
function tap(button: HTMLElement, pointerId = 1) {
  dispatchPointerEvent(button, "pointerdown", { pointerId, pointerType: "mouse" });
  dispatchPointerEvent(button, "pointerup", { pointerId, pointerType: "mouse" });
  fireEvent.click(button, { detail: 1 });
}

describe("ViewportZoomControls", () => {
  it("renders nothing while Viewport Zoom Buttons is off and appears when it is turned on", async () => {
    await renderControls({ on: false });
    // Let hydration settle so a false negative cannot come from an unloaded store.
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Viewport Zoom" })).toBeNull();
    await toggleSetting(true);
    const group = await screen.findByRole("group", { name: "Viewport Zoom" });
    expect(group.dataset.testid).toBe("viewport-zoom-controls");
    const buttons = Array.from(group.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    expect(buttons).toEqual(["Zoom In", "Zoom Out"]);
  });

  it("zooms in while Zoom In is held and out while Zoom Out is held, without a second step from the click", async () => {
    const { drive } = await renderControls();
    tap(zoomIn());
    expect(drive.start).toHaveBeenCalledExactlyOnceWith(1);
    expect(drive.stop).toHaveBeenCalledOnce();
    tap(zoomOut(), 2);
    expect(drive.start).toHaveBeenLastCalledWith(-1);
    expect(drive.stop).toHaveBeenCalledTimes(2);
    expect(drive.step).not.toHaveBeenCalled();
  });

  it("zooms one whole step for a click that no pointer press produced (keyboard activation)", async () => {
    const { drive } = await renderControls();
    fireEvent.keyDown(zoomIn(), { key: "Enter" });
    fireEvent.click(zoomIn(), { detail: 0 });
    expect(drive.step).toHaveBeenCalledExactlyOnceWith(1);
    fireEvent.click(zoomOut(), { detail: 0 });
    expect(drive.step).toHaveBeenLastCalledWith(-1);
    expect(drive.start).not.toHaveBeenCalled();
  });

  it("stops on pointer cancel and on lost capture, but only for the pointer that pressed", async () => {
    const { drive } = await renderControls();
    dispatchPointerEvent(zoomIn(), "pointerdown", { pointerId: 4 });
    dispatchPointerEvent(zoomIn(), "pointerup", { pointerId: 9 });
    expect(drive.stop).not.toHaveBeenCalled();
    dispatchPointerEvent(zoomIn(), "pointercancel", { pointerId: 4 });
    expect(drive.stop).toHaveBeenCalledOnce();
    // A cancelled touch sends no click, so the next keyboard activation still zooms.
    fireEvent.click(zoomIn(), { detail: 0 });
    expect(drive.step).toHaveBeenCalledExactlyOnceWith(1);

    dispatchPointerEvent(zoomOut(), "pointerdown", { pointerId: 5 });
    const lost = new MouseEvent("lostpointercapture", { bubbles: true });
    Object.defineProperty(lost, "pointerId", { value: 5 });
    zoomOut().dispatchEvent(lost);
    expect(drive.stop).toHaveBeenCalledTimes(2);
  });

  it("stops a held press when the buttons become disabled, the window loses focus or the setting turns off", async () => {
    const { drive } = await renderControls();
    dispatchPointerEvent(zoomIn(), "pointerdown");
    setDisabled(true);
    expect(drive.stop).toHaveBeenCalledOnce();
    setDisabled(false);

    dispatchPointerEvent(zoomIn(), "pointerdown", { pointerId: 2 });
    fireEvent.blur(window);
    expect(drive.stop).toHaveBeenCalledTimes(2);

    dispatchPointerEvent(zoomIn(), "pointerdown", { pointerId: 3 });
    await toggleSetting(false);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Viewport Zoom" })).toBeNull());
    expect(drive.stop).toHaveBeenCalledTimes(3);
  });

  it("stops a held press when it unmounts", async () => {
    const { view, drive } = await renderControls();
    dispatchPointerEvent(zoomOut(), "pointerdown");
    expect(drive.start).toHaveBeenCalledExactlyOnceWith(-1);
    view.unmount();
    expect(drive.stop).toHaveBeenCalledOnce();
  });

  it("stops the drive the press started even after the viewport swapped its Engine", async () => {
    const first = fakeDrive();
    const second = fakeDrive();
    let current: ViewportZoomDrive = first;
    const store = new MemoryAppSettingsStore();
    await store.save({ ...defaultEngineSettings(), viewportZoomButtons: true });
    render(<AppSettingsProvider store={store}><Harness drive={() => current} /></AppSettingsProvider>);
    await screen.findByRole("group", { name: "Viewport Zoom" });
    dispatchPointerEvent(zoomIn(), "pointerdown");
    current = second;
    dispatchPointerEvent(zoomIn(), "pointerup");
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
  });

  it("ignores secondary mouse buttons and disabled buttons", async () => {
    const { drive } = await renderControls();
    dispatchPointerEvent(zoomIn(), "pointerdown", { pointerType: "mouse", button: 2 });
    dispatchPointerEvent(zoomIn(), "pointerup", { pointerType: "mouse", button: 2 });
    setDisabled(true);
    expect(zoomIn()).toHaveProperty("disabled", true);
    expect(zoomOut()).toHaveProperty("disabled", true);
    dispatchPointerEvent(zoomIn(), "pointerdown");
    dispatchPointerEvent(zoomIn(), "pointerup");
    fireEvent.click(zoomOut(), { detail: 0 });
    expect(drive.start).not.toHaveBeenCalled();
    expect(drive.step).not.toHaveBeenCalled();
    expect(drive.stop).not.toHaveBeenCalled();
  });

  it("never opens the viewport's context menu, however long a button is held or right-clicked", async () => {
    const store = new MemoryAppSettingsStore();
    await store.save({ ...defaultEngineSettings(), viewportZoomButtons: true });
    const drive = fakeDrive();
    render(<AppSettingsProvider store={store}><MenuViewport drive={() => drive} /></AppSettingsProvider>);
    await screen.findByRole("group", { name: "Viewport Zoom" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {

      // The surface's own long press does open the menu, so the hold below is a real check.
      dispatchPointerEvent(screen.getByTestId("menu-surface"), "pointerdown", { pointerId: 7 });
      act(() => { vi.advanceTimersByTime(holdDelayMs() + 50); });
      expect(screen.getByTestId("menu-state").textContent).toBe("open");
      dispatchPointerEvent(screen.getByTestId("menu-surface"), "pointerup", { pointerId: 7 });
      closeViewportMenu();

      dispatchPointerEvent(zoomIn(), "pointerdown", { pointerId: 8 });
      act(() => { vi.advanceTimersByTime(holdDelayMs() * 3); });
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      zoomIn().dispatchEvent(menu);
      dispatchPointerEvent(zoomIn(), "pointerup", { pointerId: 8 });
      expect(drive.start).toHaveBeenCalledExactlyOnceWith(1);
      expect(menu.defaultPrevented).toBe(true);
      expect(screen.getByTestId("menu-state").textContent).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });
});
