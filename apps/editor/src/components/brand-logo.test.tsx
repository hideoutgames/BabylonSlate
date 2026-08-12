import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BrandLogo } from "./brand-logo";
import { brandLogoSrc } from "../lib/branding";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("BrandLogo", () => {
  it("renders the dark-ink wordmark for light chrome", () => {
    const { getByTestId } = render(<BrandLogo />);
    const logo = getByTestId("brand-logo");
    expect(logo.tagName).toBe("IMG");
    expect(logo.getAttribute("alt")).toBe("BabylonSlate");
    expect(logo.getAttribute("src")).toBe(brandLogoSrc("light"));
    expect(logo.className).toContain("dark:hidden");
    expect(logo.className).toContain("h-8");
  });

  it("renders the light-ink wordmark for dark chrome", () => {
    const { getByTestId } = render(<BrandLogo />);
    const logo = getByTestId("brand-logo-dark");
    expect(logo.getAttribute("src")).toBe(brandLogoSrc("dark"));
    expect(logo.getAttribute("alt")).toBe("");
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(logo.className).toContain("dark:block");
    expect(logo.className).toContain("h-8");
  });
});
