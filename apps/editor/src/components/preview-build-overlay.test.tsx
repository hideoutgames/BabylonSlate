import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { PreviewBuildOverlay } from "./preview-build-overlay";

afterEach(() => {
  cleanup();
});

describe("PreviewBuildOverlay", () => {
  it("opens a console, retains play warnings, and executes in the expected player frame", async () => {
    const iframeRef = createRef<HTMLIFrameElement>();
    const view = render(<PreviewBuildOverlay src="/player/index.html?preview=1" iframeRef={iframeRef} onClose={() => undefined} />);
    const frame = iframeRef.current!.contentWindow!;
    const post = vi.spyOn(frame, "postMessage");
    const receive = (data: unknown, source: Window = frame) => window.dispatchEvent(new MessageEvent("message", { data, source, origin: window.location.origin }));
    receive({ type: "babylonslate-preview-console-event", command: { type: "log", severity: "warning", message: "Agent cannot reach goal" } }, window);
    receive({ type: "babylonslate-preview-console-event", command: { type: "log", severity: "warning", message: "Path is partial" } });
    fireEvent.click(view.getByRole("button", { name: "Console" }));
    expect(view.queryByText("Agent cannot reach goal")).toBeNull();
    await waitFor(() => expect(view.getByText("Path is partial")).toBeTruthy());
    fireEvent.change(view.getByRole("combobox", { name: "Console Command" }), { target: { value: "showpathfinding on" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "babylonslate-preview-console-request", line: "showpathfinding on" }), window.location.origin));
    const request = post.mock.calls.find(([value]) => value.type === "babylonslate-preview-console-request")![0];
    receive({ type: "babylonslate-preview-console-result", requestId: request.requestId, success: true, output: "Path Overlay Enabled" });
    await waitFor(() => expect(view.getByText("Path Overlay Enabled")).toBeTruthy());
  });
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
    const overlay = view.getByTestId("preview-build-overlay");
    const chrome = stop.parentElement;
    expect(overlay.className).not.toContain("safe-overlay-chrome");
    expect(iframe.className).not.toContain("safe-overlay-chrome");
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
