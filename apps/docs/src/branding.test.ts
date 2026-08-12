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

describe("docs public brand assets", () => {
  const files = [
    "SlateLogoDark.png",
    "SlateLogoLight.png",
    "SlateIconDark.png",
    "SlateIconLight.png",
  ];

  it("copies engine-logos into the docs public branding folder", () => {
    for (const file of files) {
      const source = path.join(repoRoot, "engine-logos", file);
      const served = path.join(docsRoot, "public/branding", file);
      expect(existsSync(served), served).toBe(true);
      expect(readFileSync(served)).toEqual(readFileSync(source));
    }
  });

  it("replaces the default Vite favicon with a theme-aware Slate mark", () => {
    const svg = readFileSync(path.join(docsRoot, "public/favicon.svg"), "utf8");
    expect(svg).not.toContain("#863bff");
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(existsSync(path.join(docsRoot, "public/apple-touch-icon.png"))).toBe(
      true,
    );
    expect(existsSync(path.join(docsRoot, "public/favicon.ico"))).toBe(true);
  });
});
