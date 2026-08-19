import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BrandIcon } from "./brand-icon";
import { brandIconSrc } from "../lib/branding";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("BrandIcon", () => {
  it("renders the dark-ink mark for light chrome", () => {
    const { getByTestId } = render(<BrandIcon />);
    const icon = getByTestId("brand-icon");
    expect(icon.tagName).toBe("IMG");
    expect(icon.getAttribute("alt")).toBe("BabylonSlate");
    expect(icon.getAttribute("src")).toBe(brandIconSrc("light"));
    expect(icon.className).toContain("dark:hidden");
  });

  it("renders the light-ink mark for dark chrome", () => {
    const { getByTestId } = render(<BrandIcon />);
    const icon = getByTestId("brand-icon-dark");
    expect(icon.getAttribute("src")).toBe(brandIconSrc("dark"));
    expect(icon.getAttribute("alt")).toBe("");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.className).toContain("dark:block");
  });
});
