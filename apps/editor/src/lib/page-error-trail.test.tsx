import { afterEach, describe, expect, it } from "vitest";
import { resetSessionTrail, sessionTrailEvents } from "@haptic/core";
import { describeError, installPageErrorTrail, recordErrorScreen } from "./page-error-trail";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  resetSessionTrail();
});

const recorded = () => sessionTrailEvents().map((event) => `${event.kind}: ${event.detail}${event.count > 1 ? ` x${event.count}` : ""}`);

/** An error with a synthetic WebKit-style stack. */
function thrown(message: string, frames: string[]): Error {
  const error = new TypeError(message);
  error.stack = frames.join("\n");
  return error;
}

describe("the page's error trail", () => {
  it("records uncaught errors with their first stack lines, rejections, and repeats as one counted event", () => {
    const target = new EventTarget() as unknown as Window;
    stop = installPageErrorTrail(target);
    const error = thrown("a is null", ["render@https://example.test/assets/a.js:1:10", "frame@https://example.test/assets/a.js:2:20",
      "loop@https://example.test/assets/a.js:3:30", "tick@https://example.test/assets/a.js:4:40", "run@https://example.test/assets/a.js:5:50"]);
    const fire = () => target.dispatchEvent(Object.assign(new Event("error"), { error, message: "TypeError: a is null" }));
    fire();
    fire();
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "lost" }));
    expect(recorded()).toEqual([
      "uncaught error: TypeError: a is null | render@https://example.test/assets/a.js:1:10 | frame@https://example.test/assets/a.js:2:20 | loop@https://example.test/assets/a.js:3:30 | tick@https://example.test/assets/a.js:4:40 x2",
      "unhandled rejection: lost",
    ]);
  });

  it("records a script, stylesheet or image that failed to load, from the capture phase, by its URL", () => {
    stop = installPageErrorTrail(window);
    const link = document.createElement("link");
    link.setAttribute("href", "https://example.test/assets/index-1a2b3c.css");
    document.head.append(link);
    // A resource's error does not bubble: only a capture listener on the window hears it.
    link.dispatchEvent(new Event("error", { bubbles: false }));
    link.remove();
    expect(recorded()).toEqual(["resource failed to load: <link> https://example.test/assets/index-1a2b3c.css"]);
  });

  it("records an error screen with the head of its component stack", () => {
    const error = new Error("chunk gone");
    error.stack = "";
    recordErrorScreen("Couldn't Load Haptic", error, { componentStack: "\n    at Editor\n    at Route\n    at App\n    at Root" });
    expect(recorded()).toEqual(["error screen: Couldn't Load Haptic: Error: chunk gone | in at Editor < at Route < at App"]);
  });

  it("describes what is not an Error by its text, and cuts long stack lines", () => {
    expect(describeError("lost", "a.js:1:2")).toBe("lost (a.js:1:2)");
    const long = thrown("x", [`f@https://example.test/${"a".repeat(300)}.js:1:1`]);
    expect(describeError(long).split(" | ")[1]).toHaveLength(160);
  });
});
