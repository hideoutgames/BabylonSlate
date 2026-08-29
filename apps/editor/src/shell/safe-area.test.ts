import { describe, expect, it } from "vitest";
import chromeCss from "./editor-chrome.css?raw";
import homepageCss from "../components/homepage.css?raw";
import dockviewCss from "./dockview-theme.css?raw";
import contextMenuCss from "../../../../packages/editor-kit/src/styles/context-menu.css?raw";
import graphCss from "../../../../packages/graph-ui/src/graph-editor.css?raw";
import globalsCss from "../../../../packages/ui/src/styles/globals.css?raw";
import playOverlaySource from "../components/play-overlay-chrome.tsx?raw";
import previewOverlaySource from "../components/preview-build-overlay.tsx?raw";
import capacitorConfig from "../../capacitor.config";

function cssBlock(css: string, selector: string): string {
  const pattern = new RegExp(`${selector.replaceAll(".", "\\.")}\\s*\\{`);
  const match = pattern.exec(css);
  const start = match?.index ?? -1;
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

function tokenValue(block: string, name: string): string {
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? "";
}

describe("safe-area tokens", () => {
  const root = cssBlock(globalsCss, ":root");
  const dark = cssBlock(globalsCss, ".dark");

  it("defines all four env-backed tokens in both color schemes", () => {
    for (const [name, inset] of [
      ["--safe-top", "top"],
      ["--safe-right", "right"],
      ["--safe-bottom", "bottom"],
      ["--safe-left", "left"],
    ] as const) {
      expect(tokenValue(root, name)).toBe(`env(safe-area-inset-${inset}, 0px)`);
      expect(tokenValue(dark, name)).toBe(`env(safe-area-inset-${inset}, 0px)`);
    }
  });

  it("keeps safe-area ownership in globals.css", () => {
    expect(
      [
        chromeCss,
        homepageCss,
        dockviewCss,
        contextMenuCss,
        graphCss,
      ].join("\n"),
    ).not.toContain("env(safe-area-inset");
  });

  it("pads the shell above the interactive chrome rows", () => {
    expect(cssBlock(chromeCss, ".editor-chrome-shell")).toContain(
      "padding-top: var(--safe-top)",
    );
    expect(cssBlock(chromeCss, ".editor-chrome-bar")).toContain(
      "height: var(--chrome-row, 28px)",
    );
    expect(cssBlock(chromeCss, ".editor-chrome-bar")).toContain(
      "min-height: var(--chrome-row, 28px)",
    );
    expect(cssBlock(chromeCss, ".editor-global-toolbar")).toContain(
      "min-height: var(--chrome-row, 28px)",
    );
  });

  it("shares safe padding across fixed overlay chrome", () => {
    expect(cssBlock(chromeCss, ".safe-overlay-chrome")).toContain(
      "--safe-overlay-pad: 0.75rem",
    );
    expect(cssBlock(chromeCss, ".safe-overlay-chrome")).toContain(
      "var(--safe-top) + var(--safe-overlay-pad)",
    );
    expect(playOverlaySource).toContain("safe-overlay-chrome");
    expect(previewOverlaySource).toContain("safe-overlay-chrome");
    expect(previewOverlaySource).toContain(
      'style={{ "--safe-overlay-pad": "1rem" }',
    );
    expect(previewOverlaySource).not.toContain(
      "top-0 z-10 flex items-start justify-end p-3",
    );
  });

  it("uses contentInset never so CSS owns the viewport insets", () => {
    expect(capacitorConfig.ios?.contentInset).toBe("never");
  });
});
