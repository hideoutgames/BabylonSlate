import { describe, expect, it } from "vitest";
import {
  BRAND_LOGO_ON_DARK,
  BRAND_LOGO_ON_LIGHT,
  BRAND_NAME,
  brandLogoSrc,
  publicAssetUrl,
} from "./branding";

describe("branding", () => {
  it("names the product BabylonSlate", () => {
    expect(BRAND_NAME).toBe("BabylonSlate");
  });

  it("prefixes public asset paths with the Vite base", () => {
    expect(publicAssetUrl("branding/SlateLogoDark.png")).toBe(
      "/branding/SlateLogoDark.png",
    );
  });

  it("uses dark-ink logo on light chrome and light-ink logo on dark chrome", () => {
    expect(brandLogoSrc("light")).toBe(`/${BRAND_LOGO_ON_LIGHT}`);
    expect(brandLogoSrc("dark")).toBe(`/${BRAND_LOGO_ON_DARK}`);
    expect(BRAND_LOGO_ON_LIGHT).toContain("SlateLogoDark");
    expect(BRAND_LOGO_ON_DARK).toContain("SlateLogoLight");
  });
});
