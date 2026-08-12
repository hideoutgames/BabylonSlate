import { describe, expect, it } from "vitest";
import {
  findHardcodedRadii,
  findRadiusDeclarations,
} from "@babylonslate/test-kit/style-audit";
import chromeCss from "./editor-chrome.css?raw";
import dockviewCss from "./dockview-theme.css?raw";
import globalsCss from "../../../../packages/ui/src/styles/globals.css?raw";

const AUTHORED_STYLESHEETS = {
  "editor-chrome.css": chromeCss,
  "dockview-theme.css": dockviewCss,
};

const PIN_TOKENS = [
  "--pin-exec",
  "--pin-bool",
  "--pin-int",
  "--pin-float",
  "--pin-string",
  "--pin-vector",
  "--pin-rotator",
  "--pin-transform",
  "--pin-color",
  "--pin-object",
  "--pin-actor",
  "--pin-struct",
  "--pin-enum",
  "--pin-wildcard",
  "--pin-delegate",
] as const;

const NODE_TOKENS = [
  "--node-event",
  "--node-function",
  "--node-pure",
  "--node-flow",
  "--node-variable",
  "--node-variable-set",
  "--node-latent",
  "--node-debug",
] as const;

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
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? "";
}

function oklchLightness(value: string): number {
  const match = value.match(/oklch\(\s*([0-9.]+)/i);
  return match ? Number(match[1]) : Number.NaN;
}

function oklchChroma(value: string): number {
  const match = value.match(/oklch\(\s*[0-9.]+\s+([0-9.]+)/i);
  return match ? Number(match[1]) : Number.NaN;
}

describe("authored shell stylesheets", () => {
  it.each(Object.entries(AUTHORED_STYLESHEETS))(
    "%s draws every radius from the token scale",
    (name, css) => {
      expect(findHardcodedRadii(css), `hardcoded radii in ${name}`).toEqual([]);
    },
  );

  it("rounds shell surfaces rather than leaving them square", () => {
    const all = Object.values(AUTHORED_STYLESHEETS).flatMap(
      findRadiusDeclarations,
    );
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((value) => value === "0")).toBe(false);
  });
});

describe("Unreal-inspired theme tokens", () => {
  const dark = cssBlock(globalsCss, ".dark");

  it("keeps dark background above complete black", () => {
    const background = tokenValue(dark, "--background");
    expect(oklchLightness(background)).toBeGreaterThanOrEqual(0.2);
  });

  it("uses a chromatic primary instead of ink", () => {
    const primary = tokenValue(dark, "--primary");
    expect(oklchChroma(primary)).toBeGreaterThan(0.05);
  });

  it("defines pin type tokens", () => {
    for (const name of PIN_TOKENS) {
      expect(tokenValue(dark, name), name).not.toBe("");
    }
  });

  it("defines node role tokens", () => {
    for (const name of NODE_TOKENS) {
      expect(tokenValue(dark, name), name).not.toBe("");
    }
  });

  it("defines touch-sized graph pin and edge tokens", () => {
    expect(tokenValue(dark, "--graph-pin-size")).toBe("16px");
    expect(tokenValue(dark, "--graph-edge-exec")).toBe("5px");
    expect(tokenValue(dark, "--graph-edge-data")).toBe("4px");
  });

  it("points the chrome tab accent at primary", () => {
    expect(tokenValue(dark, "--chrome-tab-accent")).toBe("var(--primary)");
  });

  it("defines a compact chrome row token", () => {
    const root = cssBlock(globalsCss, ":root");
    expect(tokenValue(root, "--chrome-row")).toBe("28px");
  });
});

describe("compact dock tab strips", () => {
  it("halves dockview tab min-heights", () => {
    expect(dockviewCss).toMatch(/min-height:\s*18px/);
    expect(dockviewCss).toMatch(/min-height:\s*26px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*36px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*52px/);
  });
});

