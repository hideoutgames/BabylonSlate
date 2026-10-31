// The Babylon-free module: Home reads and restores the setting before any Engine loads.
import { preserveDrawingBufferSetting, setPreserveDrawingBufferSetting } from "@haptic/render/preserve-drawing-buffer-setting";
import type { BreakdownAbDeps } from "./feature-test-breakdown-ab";

/** The stored preserveDrawingBuffer setting (read when the project Engine is created) the Breakdown's A/B switches and stores back. */
export const FEATURE_TEST_AB_DEPS: BreakdownAbDeps = {
  preserve: preserveDrawingBufferSetting,
  setPreserve: setPreserveDrawingBufferSetting,
  now: () => Date.now(),
};
