import { describe, expect, it, vi } from "vitest";
import { applyClipboardWrite, applyOpenUrl } from "./browser-requests";

describe("browser requests", () => {
  it("writes the text to the clipboard and ignores a refusal", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    applyClipboardWrite({ text: "Score: 42" }, { writeText });
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("Score: 42");
    expect(() => applyClipboardWrite({ text: "x" }, undefined)).not.toThrow();
    expect(() => applyClipboardWrite({ text: "x" }, { writeText: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("opens http and https addresses in a new tab without an opener", () => {
    const open = vi.fn(() => null);
    applyOpenUrl({ url: "https://example.com/store?id=1" }, open);
    applyOpenUrl({ url: "http://example.com" }, open);
    expect(open.mock.calls).toEqual([
      ["https://example.com/store?id=1", "_blank", "noopener,noreferrer"],
      ["http://example.com/", "_blank", "noopener,noreferrer"],
    ]);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "not a url", ""])(
    "never opens %j", (url) => {
      const open = vi.fn();
      applyOpenUrl({ url }, open);
      expect(open).not.toHaveBeenCalled();
    },
  );
});
