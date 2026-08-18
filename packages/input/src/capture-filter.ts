import {
  inputModeAllowsGameInput,
  type InputMode,
} from "@babylonslate/core";
import type { RawInputEvent } from "./ring-buffer";

/** Whether a captured event should enter the Play / player input ring. */
export function shouldPushRawInput(
  mode: InputMode,
  kind: RawInputEvent["kind"],
): boolean {
  if (kind === "touchAxis") return true;
  return inputModeAllowsGameInput(mode);
}
