import { describe, expect, it } from "vitest";
import {
  findHardcodedRadii,
  findRadiusDeclarations,
} from "@babylonslate/test-kit/style-audit";
import chromeCss from "./editor-chrome.css?raw";
import dockviewCss from "./dockview-theme.css?raw";

const AUTHORED_STYLESHEETS = {
  "editor-chrome.css": chromeCss,
  "dockview-theme.css": dockviewCss,
};

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
