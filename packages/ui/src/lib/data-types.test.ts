import { describe, expect, it } from "vitest";
import {
  assetColorVar,
  pinColorVar,
  typeColorThumbAccent,
} from "./data-types";

describe("data-types", () => {
  it("maps Unreal-style pin kinds to CSS variables", () => {
    expect(pinColorVar("bool")).toBe("var(--pin-bool)");
    expect(pinColorVar("int")).toBe("var(--pin-int)");
    expect(pinColorVar("float")).toBe("var(--pin-float)");
    expect(pinColorVar("string")).toBe("var(--pin-string)");
    expect(pinColorVar("vec3")).toBe("var(--pin-vector)");
    expect(pinColorVar("objectRef")).toBe("var(--pin-object)");
    expect(pinColorVar("classRef")).toBe("var(--pin-class)");
    expect(pinColorVar("assetRef")).toBe("var(--pin-object)");
    expect(pinColorVar("unknown-kind")).toBe("var(--pin-wildcard)");
  });

  it("maps asset families including folder", () => {
    expect(assetColorVar("texture")).toBe("var(--asset-texture)");
    expect(assetColorVar("class")).toBe("var(--asset-class)");
    expect(assetColorVar("folder")).toBe("var(--asset-folder)");
    expect(assetColorVar("not-a-family")).toBe("var(--muted-foreground)");
  });

  it("builds a type-colored border outline without a radial wash", () => {
    const colorVar = "var(--asset-texture)";
    const accent = typeColorThumbAccent(colorVar);
    expect(accent.border).toBe("2px solid var(--asset-texture)");
    expect(accent.borderTopLeftRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect(accent.borderTopRightRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect("boxShadow" in accent).toBe(false);
    expect("backgroundImage" in accent).toBe(false);
    expect("backgroundColor" in accent).toBe(false);
  });
});
