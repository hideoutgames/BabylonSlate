import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { PreviewBuildOverlay } from "./preview-build-overlay";

afterEach(() => {
  cleanup();
});

describe("PreviewBuildOverlay", () => {
  it("labels Stop on a 44px target above the player iframe", () => {
    const view = render(
      <PreviewBuildOverlay
        src="/player/index.html?preview=1"
        iframeRef={createRef<HTMLIFrameElement>()}
        onClose={() => undefined}
      />,
    );
    const stop = view.getByTestId("preview-build-close");
    expect(stop.textContent).toContain("Stop");
    expect(stop.getAttribute("aria-label")).toBe("Stop");
    expect(stop.className).toContain("min-h-[var(--touch-target,44px)]");
    const iframe = view.getByTestId("preview-build-iframe");
    const chrome = stop.parentElement;
    expect(chrome?.className).toContain("z-10");
    expect(chrome?.className).toContain("safe-overlay-chrome");
    expect(chrome?.className).not.toContain("p-3");
    expect(iframe.className).toContain("outline-none");
    expect(iframe.className).toContain("focus-visible:outline-none");
  });

  it("keeps the error alert padded inside the safe overlay box", () => {
    const view = render(
      <PreviewBuildOverlay
        src="/player/index.html?preview=1"
        iframeRef={createRef<HTMLIFrameElement>()}
        onClose={() => undefined}
        error="Build failed"
      />,
    );
    const error = view.getByTestId("preview-build-error");
    const container = error.parentElement;
    expect(container?.className).toContain("safe-overlay-chrome");
    expect(container?.className).toContain("top-16");
    expect(container?.style.getPropertyValue("--safe-overlay-pad")).toBe("1rem");
  });

  it("invokes onClose from Stop so Preview Build can leave the editor", () => {
    const onClose = vi.fn();
    const view = render(
      <PreviewBuildOverlay
        src="/player/index.html?preview=1"
        iframeRef={createRef<HTMLIFrameElement>()}
        onClose={onClose}
      />,
    );
    fireEvent.click(view.getByTestId("preview-build-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
