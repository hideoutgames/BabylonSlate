import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import faviconSvg from "../../public/favicon.svg?raw";

describe("editor brand chrome", () => {
  it("replaces the default Vite favicon with a theme-aware Slate mark", () => {
    expect(faviconSvg).not.toContain("#863bff");
    expect(faviconSvg).toContain("prefers-color-scheme: dark");
  });

  it("links the brand favicon and apple touch icon from index.html", () => {
    expect(indexHtml).toContain('href="/favicon.svg"');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('href="/apple-touch-icon.png"');
  });
});
