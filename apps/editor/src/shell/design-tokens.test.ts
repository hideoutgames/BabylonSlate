import { describe, expect, it } from "vitest";
import {
  findHardcodedRadii,
  findRadiusDeclarations,
} from "@babylonslate/test-kit/style-audit";
import { toggleVariants } from "@babylonslate/ui/components/toggle";
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

const ASSET_TOKENS = [
  "--asset-scene",
  "--asset-graph",
  "--asset-texture",
  "--asset-material",
  "--asset-model",
  "--asset-audio",
  "--asset-font",
  "--asset-animation",
  "--asset-class",
  "--asset-script-type",
  "--asset-component",
  "--asset-folder",
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

function oklchHue(value: string): number {
  const match = value.match(/oklch\(\s*[0-9.]+\s+[0-9.]+\s+([0-9.]+)/i);
  return match ? Number(match[1]) : Number.NaN;
}

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
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

describe("Minimal Neutral theme tokens", () => {
  const root = cssBlock(globalsCss, ":root");
  const dark = cssBlock(globalsCss, ".dark");

  it("uses ink primary in both schemes", () => {
    expect(oklchChroma(tokenValue(root, "--primary"))).toBeLessThan(0.01);
    expect(oklchChroma(tokenValue(dark, "--primary"))).toBeLessThan(0.01);
  });

  it("uses Neutral light and dark backgrounds", () => {
    expect(tokenValue(root, "--background")).toBe("oklch(1 0 0)");
    expect(tokenValue(dark, "--background")).toBe("oklch(0.145 0 0)");
  });

  it("points the chrome tab accent at foreground", () => {
    expect(tokenValue(root, "--chrome-tab-accent")).toBe("var(--foreground)");
    expect(tokenValue(dark, "--chrome-tab-accent")).toBe("var(--foreground)");
  });

  it("keeps a chromatic Z axis independent of ink primary", () => {
    expect(tokenValue(root, "--axis-z")).not.toBe("var(--primary)");
    expect(oklchChroma(tokenValue(root, "--axis-z"))).toBeGreaterThan(0.05);
    expect(tokenValue(dark, "--axis-z")).not.toBe("var(--primary)");
    expect(oklchChroma(tokenValue(dark, "--axis-z"))).toBeGreaterThan(0.05);
  });

  it("uses a darker exec pin in light than in dark", () => {
    expect(oklchLightness(tokenValue(root, "--pin-exec"))).toBeLessThan(
      oklchLightness(tokenValue(dark, "--pin-exec")),
    );
  });

  it("defines pin type tokens", () => {
    for (const name of PIN_TOKENS) {
      expect(tokenValue(dark, name), name).not.toBe("");
      expect(tokenValue(root, name), name).not.toBe("");
    }
  });

  it("defines asset type tokens", () => {
    for (const name of ASSET_TOKENS) {
      expect(tokenValue(root, name), name).not.toBe("");
      expect(tokenValue(dark, name), name).not.toBe("");
    }
  });

  it("keeps asset type hues at least 25 degrees apart", () => {
    const hues = ASSET_TOKENS.map((name) => {
      const hue = oklchHue(tokenValue(root, name));
      expect(hue, name).not.toBeNaN();
      expect(oklchHue(tokenValue(dark, name)), `${name} dark`).toBe(hue);
      return { name, hue };
    });
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const distance = circularHueDistance(hues[i]!.hue, hues[j]!.hue);
        expect(
          distance,
          `${hues[i]!.name} (${hues[i]!.hue}) vs ${hues[j]!.name} (${hues[j]!.hue})`,
        ).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it("defines node role tokens", () => {
    for (const name of NODE_TOKENS) {
      expect(tokenValue(dark, name), name).not.toBe("");
    }
  });

  it("defines touch-sized graph pin and edge tokens", () => {
    expect(tokenValue(dark, "--graph-pin-size")).toBe("22px");
    expect(tokenValue(dark, "--graph-edge-exec")).toBe("5px");
    expect(tokenValue(dark, "--graph-edge-data")).toBe("4px");
  });

  it("defines a compact chrome row token", () => {
    expect(tokenValue(root, "--chrome-row")).toBe("28px");
  });

  it("fills pressed toggles with accent so tools read as on", () => {
    expect(toggleVariants()).toContain("aria-pressed:bg-accent");
    expect(toggleVariants()).toContain("data-[state=on]:bg-accent");
  });

  it("keeps dark category and muted fills distinct from popover", () => {
    expect(oklchLightness(tokenValue(dark, "--secondary"))).not.toBe(
      oklchLightness(tokenValue(dark, "--popover")),
    );
    expect(oklchLightness(tokenValue(dark, "--muted"))).not.toBe(
      oklchLightness(tokenValue(dark, "--popover")),
    );
  });
});

describe("compact dock tab strips", () => {
  it("halves dockview tab min-heights", () => {
    expect(dockviewCss).toMatch(/min-height:\s*18px/);
    expect(dockviewCss).toMatch(/min-height:\s*26px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*36px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*52px/);
  });

  it("gives dockview tabs slight horizontal margins without changing height", () => {
    const theme = cssBlock(dockviewCss, ".dockview-theme-babylonslate");
    expect(tokenValue(theme, "--dv-tab-margin")).toBe("0 2px");
  });
});

describe("dockview theme contrast", () => {
  const theme = cssBlock(dockviewCss, ".dockview-theme-babylonslate");

  it("paints tab strips with card chrome and tab labels with foreground tokens", () => {
    expect(
      tokenValue(theme, "--dv-tabs-and-actions-container-background-color"),
    ).toBe("var(--card)");
    expect(tokenValue(theme, "--dv-activegroup-visiblepanel-tab-color")).toBe(
      "var(--foreground)",
    );
    expect(tokenValue(theme, "--dv-inactivegroup-visiblepanel-tab-color")).toBe(
      "var(--foreground)",
    );
    expect(tokenValue(theme, "--dv-activegroup-hiddenpanel-tab-color")).toBe(
      "var(--muted-foreground)",
    );
    expect(tokenValue(theme, "--dv-inactivegroup-hiddenpanel-tab-color")).toBe(
      "var(--muted-foreground)",
    );
  });

  it("outlines each panel content container with a 1px bound", () => {
    expect(dockviewCss).toMatch(
      /\.dockview-theme-babylonslate\s+\.dv-content-container\s*\{[^}]*outline:\s*1px solid/,
    );
    expect(dockviewCss).not.toMatch(
      /\.dockview-theme-babylonslate\s+\.dv-groupview\s*\{[^}]*outline:/,
    );
  });
});

