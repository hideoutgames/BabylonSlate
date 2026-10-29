import { expect, it } from "vitest";
import { deviceProfile, deviceTextureLimits, isMobileGpuDevice } from "./device-profile";
import { HAPTIC_LIGHT_MAXIMUM } from "./haptic-lights";

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

it("draws as many lights as the light block holds, and half of each type on a phone or tablet", () => {
  expect(deviceProfile(MAC).lightMaximum).toEqual(HAPTIC_LIGHT_MAXIMUM);
  const mobile = deviceProfile(IPAD).lightMaximum;
  for (const [type, maximum] of Object.entries(HAPTIC_LIGHT_MAXIMUM)) expect(mobile[type as keyof typeof mobile], type).toBe(maximum / 2);
});
