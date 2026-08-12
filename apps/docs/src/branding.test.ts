import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docsBrand } from "./branding";

const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(docsRoot, "../..");

describe("docsBrand", () => {
  it("uses themeable Slate wordmark and icon from engine-logos", () => {
    expect(docsBrand.logo.light).toBe("/branding/SlateLogoDark.png");
    expect(docsBrand.logo.dark).toBe("/branding/SlateLogoLight.png");
    expect(docsBrand.logo.alt).toBe("BabylonSlate");
    expect(docsBrand.navLogo.light).toBe("/branding/SlateIconDark.png");
    expect(docsBrand.navLogo.dark).toBe("/branding/SlateIconLight.png");
    expect(docsBrand.favicon).toBe("/favicon.svg");
  });

  it("is wired into the VitePress config", () => {
    const config = readFileSync(
      path.join(docsRoot, ".vitepress/config.ts"),
      "utf8",
    );
    expect(config).toContain("docsBrand");
    expect(config).toContain("docsBrand.navLogo");
    expect(config).toContain("docsBrand.favicon");
  });

  it("puts the wordmark on the docs home hero", () => {
    const index = readFileSync(path.join(repoRoot, "docs/index.md"), "utf8");
    expect(index).toContain("light: /branding/SlateLogoDark.png");
    expect(index).toContain("dark: /branding/SlateLogoLight.png");
    expect(index).toContain("alt: BabylonSlate");
  });
});

describe("public brand assets", () => {
  const files = [
    "SlateLogoDark.png",
    "SlateLogoLight.png",
    "SlateIconDark.png",
    "SlateIconLight.png",
  ];
  const editorRoot = path.join(repoRoot, "apps/editor");

  it("copies engine-logos into the docs and editor public branding folders", () => {
    for (const file of files) {
      const source = path.join(repoRoot, "engine-logos", file);
      const docsServed = path.join(docsRoot, "public/branding", file);
      const editorServed = path.join(editorRoot, "public/branding", file);
      expect(existsSync(docsServed), docsServed).toBe(true);
      expect(existsSync(editorServed), editorServed).toBe(true);
      const bytes = readFileSync(source);
      expect(readFileSync(docsServed)).toEqual(bytes);
      expect(readFileSync(editorServed)).toEqual(bytes);
    }
  });

  it("replaces the default Vite favicon with a theme-aware Slate mark", () => {
    for (const appRoot of [docsRoot, editorRoot]) {
      const svg = readFileSync(path.join(appRoot, "public/favicon.svg"), "utf8");
      expect(svg).not.toContain("#863bff");
      expect(svg).toContain("prefers-color-scheme: dark");
      expect(existsSync(path.join(appRoot, "public/apple-touch-icon.png"))).toBe(
        true,
      );
      expect(existsSync(path.join(appRoot, "public/favicon.ico"))).toBe(true);
    }
  });
});
