import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";

const editorRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(editorRoot, "../..");

describe("editor public brand assets", () => {
  const files = [
    "SlateLogoDark.png",
    "SlateLogoLight.png",
    "SlateIconDark.png",
    "SlateIconLight.png",
  ];

  it("copies engine-logos into the editor public branding folder", () => {
    for (const file of files) {
      const source = path.join(repoRoot, "engine-logos", file);
      const served = path.join(editorRoot, "public/branding", file);
      expect(existsSync(served), served).toBe(true);
      expect(readFileSync(served)).toEqual(readFileSync(source));
    }
  });

  it("replaces the default Vite favicon with a theme-aware Slate mark", () => {
    const svg = readFileSync(
      path.join(editorRoot, "public/favicon.svg"),
      "utf8",
    );
    expect(svg).not.toContain("#863bff");
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(existsSync(path.join(editorRoot, "public/apple-touch-icon.png"))).toBe(
      true,
    );
    expect(existsSync(path.join(editorRoot, "public/favicon.ico"))).toBe(true);
  });

  it("links the brand favicon and apple touch icon from index.html", () => {
    expect(indexHtml).toContain('href="/favicon.svg"');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('href="/apple-touch-icon.png"');
  });
});
