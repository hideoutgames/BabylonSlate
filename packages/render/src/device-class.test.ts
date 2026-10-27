import { expect, it } from "vitest";
import { isMobileGpuDevice } from "./device-class";

it.each([
  ["iPadOS Safari, which reports a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15", 5, true],
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5, true],
  ["Android", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", 5, true],
  ["a Mac without touch", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15", 0, false],
  ["Windows with a touch screen", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", 10, false],
])("classes %s", (_name, userAgent, maxTouchPoints, mobile) => {
  expect(isMobileGpuDevice({ userAgent, maxTouchPoints })).toBe(mobile);
});
