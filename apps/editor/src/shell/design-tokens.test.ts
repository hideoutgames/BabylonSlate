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
  "--pin-quat",
  "--pin-transform",
  "--pin-color",
  "--pin-object",
  "--pin-actor",
  "--pin-class",
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
  "--node-call-parent",
  "--node-function",
  "--node-pure",
  "--node-flow",
  "--node-variable",
  "--node-variable-set",
  "--node-latent",
  "--node-debug",
  "--node-dev-only-tape",
  "--node-dev-only-stripe",
  "--node-editor-only-tape",
  "--node-editor-only-stripe",
  "--node-bt-root",
  "--node-bt-composite",
  "--node-bt-task",
  "--node-bt-decorator",
  "--node-bt-service",
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

/** OKLCH to linear sRGB luminance, so unreadable palette pairs fail the audit. */
function luminance(value: string): number {
  const lightness = oklchLightness(value);
  const chroma = oklchChroma(value);
  const radians = (oklchHue(value) * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (channel: number) => Math.max(0, Math.min(1, channel));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

function contrast(block: string, foreground: string, background: string): number {
  const resolve = (name: string): string => {
    const value = tokenValue(block, name);
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    return alias ? resolve(alias[1]!) : value;
  };
  const first = luminance(resolve(foreground));
  const second = luminance(resolve(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
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

describe("Graphite theme tokens", () => {
  const root = cssBlock(globalsCss, ":root");
  const dark = cssBlock(globalsCss, ".dark");

  it("uses ink primary in both schemes", () => {
    expect(oklchChroma(tokenValue(root, "--primary"))).toBeLessThan(0.01);
    expect(oklchChroma(tokenValue(dark, "--primary"))).toBeLessThan(0.01);
  });

  it.each([":root", ".dark"])("keeps secondary text and keyboard focus readable in %s", (scheme) => {
    const block = cssBlock(globalsCss, scheme);
    for (const surface of ["--background", "--sidebar", "--card", "--popover", "--muted", "--accent", "--control", "--panel-header"]) {
      expect(contrast(block, "--foreground", surface), `text on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(block, "--muted-foreground", surface), `secondary text on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(block, "--ring", surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(block, "--primary-foreground", "--primary")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(block, "--play-foreground", "--play")).toBeGreaterThanOrEqual(4.5);
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

  it("matches Structure and Enum pin colors to their asset tokens", () => {
    expect(tokenValue(root, "--pin-struct")).toBe(
      tokenValue(root, "--asset-class"),
    );
    expect(tokenValue(dark, "--pin-struct")).toBe(
      tokenValue(dark, "--asset-class"),
    );
    expect(tokenValue(root, "--pin-enum")).toBe(
      tokenValue(root, "--asset-script-type"),
    );
    expect(tokenValue(dark, "--pin-enum")).toBe(
      tokenValue(dark, "--asset-script-type"),
    );
  });

  it("defines asset type tokens", () => {
    for (const name of ASSET_TOKENS) {
      expect(tokenValue(root, name), name).not.toBe("");
      expect(tokenValue(dark, name), name).not.toBe("");
    }
  });

  it("uses the former Audio green for Material, lime for Audio, and gold for folders", () => {
    expect(oklchHue(tokenValue(root, "--asset-material"))).toBe(145);
    expect(oklchHue(tokenValue(dark, "--asset-material"))).toBe(145);
    expect(oklchHue(tokenValue(root, "--asset-audio"))).toBe(120);
    expect(oklchHue(tokenValue(dark, "--asset-audio"))).toBe(120);
    expect(oklchHue(tokenValue(root, "--asset-folder"))).toBe(70);
    expect(oklchHue(tokenValue(dark, "--asset-folder"))).toBe(70);
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
      expect(tokenValue(root, name), name).not.toBe("");
    }
  });

  it("keeps Development Only tape hues identical in both schemes", () => {
    for (const name of [
      "--node-dev-only-tape",
      "--node-dev-only-stripe",
    ] as const) {
      expect(tokenValue(dark, name), name).toBe(tokenValue(root, name));
    }
  });

  it("keeps Editor Only tape hues identical in both schemes", () => {
    for (const name of [
      "--node-editor-only-tape",
      "--node-editor-only-stripe",
    ] as const) {
      expect(tokenValue(dark, name), name).toBe(tokenValue(root, name));
    }
  });

  it("defines touch-sized graph pin and edge tokens", () => {
    expect(tokenValue(dark, "--graph-pin-size")).toBe("22px");
    expect(tokenValue(dark, "--graph-edge-exec")).toBe("5px");
    expect(tokenValue(dark, "--graph-edge-data")).toBe("4px");
    expect(tokenValue(root, "--graph-pin-default-max-width")).toBe("12rem");
    expect(tokenValue(dark, "--graph-pin-default-max-width")).toBe("12rem");
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

  it("keeps dark field and panel boundaries visible against modal surfaces", () => {
    const surface = oklchLightness(tokenValue(dark, "--popover")) ** 3;
    for (const name of ["--border", "--input", "--sidebar-border"]) {
      // Achromatic OKLCH lightness cubed is relative luminance.
      const boundary = oklchLightness(tokenValue(dark, name)) ** 3;
      expect((boundary + 0.05) / (surface + 0.05), name).toBeGreaterThanOrEqual(
        1.5,
      );
    }
  });
});

describe("compact dock tab strips", () => {
  it("halves dockview tab min-heights", () => {
    expect(dockviewCss).toMatch(/min-height:\s*18px/);
    expect(dockviewCss).toMatch(/min-height:\s*26px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*36px/);
    expect(dockviewCss).not.toMatch(/min-height:\s*52px/);
  });

  it("keeps dockview tabs wide enough to click when titles are short", () => {
    expect(dockviewCss).toMatch(/min-width:\s*56px/);
    expect(dockviewCss).toMatch(/min-width:\s*64px/);
    expect(dockviewCss).not.toMatch(/min-width:\s*28px/);
  });

  it("gives dockview tabs slight horizontal margins without changing height", () => {
    const theme = cssBlock(dockviewCss, ".dockview-theme-babylonslate");
    expect(tokenValue(theme, "--dv-tab-margin")).toBe("0 2px");
  });
});

describe("dockview theme contrast", () => {
  const theme = cssBlock(dockviewCss, ".dockview-theme-babylonslate");

  it("paints tab strips with panel-header chrome and tab labels with foreground tokens", () => {
    expect(
      tokenValue(theme, "--dv-tabs-and-actions-container-background-color"),
    ).toBe("var(--panel-header)");
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

describe("UI Designer/Logic stacked surfaces", () => {
  it("disables hit testing on inactive surface descendants", () => {
    expect(chromeCss).toMatch(
      /\.ui-dock-surface-inactive\s+\*\s*\{[^}]*pointer-events:\s*none/,
    );
  });
});

describe("document tab strip", () => {
  it("keeps Content Browser outside the closable-tab scroller", () => {
    const tabs = cssBlock(chromeCss, ".editor-chrome-tabs");
    expect(tokenValue(tabs, "overflow-x")).not.toBe("auto");
    expect(tokenValue(tabs, "overflow-x")).not.toBe("scroll");
  });

  it("keeps the pinned tab group from shrinking into the closable scroller", () => {
    const pinned = cssBlock(chromeCss, ".editor-chrome-tabs-pinned");
    expect(tokenValue(pinned, "flex-shrink")).toBe("0");
    expect(tokenValue(pinned, "overflow-x")).not.toBe("auto");
    expect(tokenValue(pinned, "overflow-x")).not.toBe("scroll");
  });

  it("hides scrollbars on the closable-tab scroller", () => {
    const scroller = cssBlock(chromeCss, ".editor-chrome-tabs-scroll");
    expect(tokenValue(scroller, "overflow-x")).toBe("auto");
    expect(tokenValue(scroller, "scrollbar-width")).toBe("none");
    expect(chromeCss).toMatch(
      /\.editor-chrome-tabs-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    );
  });
});
