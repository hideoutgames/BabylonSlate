import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPlayerSceneLoading } from "./scene-loading-overlay";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("player Scene Loading", () => {
  it("holds a modal across phases and reloads, permits Stop, and removes it on disposal", () => {
    // jsdom has no top layer; model the native open/close boundary only.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const stop = vi.fn();
    const loading = mountPlayerSceneLoading(document.body, stop);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.open).toBe(false);
    loading.update({ sceneAssetGuid: "scene", sceneLoadId: 1, phase: "Removing Previous Scene", progress: 10 });
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("Loading Scene");
    expect(dialog.textContent).toContain("Removing Previous Scene");
    loading.update({ sceneAssetGuid: "scene", sceneLoadId: 1, phase: "Presenting First Frame", progress: 90 });
    expect(dialog.querySelector("progress")!.value).toBe(90);
    dialog.querySelector("button")!.click();
    expect(stop).toHaveBeenCalledOnce();
    loading.update(null);
    expect(dialog.open).toBe(false);
    loading.update({ sceneAssetGuid: "scene", sceneLoadId: 2, phase: "Preparing Scene", progress: 0 });
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.sceneLoadId).toBe("2");
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    loading.dispose();
    loading.update({ sceneAssetGuid: "scene", sceneLoadId: 3, phase: "Preparing Scene", progress: 0 });
    expect(document.querySelector("dialog")).toBeNull();
  });
});
