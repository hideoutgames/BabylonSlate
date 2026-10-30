import { expect, it } from "vitest";
import { deviceProfile, deviceTextureLimits, isMobileGpuDevice } from "./device-profile";

const IPAD = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15", maxTouchPoints: 5 };
const MAC = { ...IPAD, maxTouchPoints: 0 };

it.each([
  ["iPadOS Safari, which reports a Mac", IPAD.userAgent, 5, true],
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5, true],
  ["Android", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", 5, true],
  ["a Mac without touch", MAC.userAgent, 0, false],
  ["Windows with a touch screen", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", 10, false],
])("classes %s", (_name, userAgent, maxTouchPoints, mobile) => {
  expect(isMobileGpuDevice({ userAgent, maxTouchPoints })).toBe(mobile);
});

it("lowers a texture budget above a phone or tablet's ceiling, and reports it", () => {
  const ceiling = deviceProfile(IPAD).textureByteCeiling;
  expect(ceiling).toBeLessThan(deviceProfile(MAC).textureByteCeiling);
  expect(deviceTextureLimits(ceiling, IPAD)).toEqual([]);
  expect(deviceTextureLimits(ceiling + 1, IPAD)).toEqual([expect.stringContaining("on this device class")]);
  expect(deviceTextureLimits(ceiling + 1, MAC)).toEqual([]);
});

it("gives a phone or tablet the desktop's shadow and light limits, and keeps its texture ceiling", () => {
  for (const nav of [IPAD, MAC])
    expect(deviceProfile(nav)).toMatchObject({
      shadowMapCap: null,
      shadowAtlasCap: null,
      lightMaximum: { directional: 4, point: 32, spot: 16, rect: 4 },
      areaEmissionLayers: 4,
    });
  expect(deviceProfile(IPAD).textureByteCeiling).toBe(768 * 1024 * 1024);
});
