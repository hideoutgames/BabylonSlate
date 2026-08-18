import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";

export type InspectControlRuntime = {
  inspectWorld(): DebugInspectSnapshot;
};

/**
 * Route `{ type: "inspect" }` onto a live runtime and emit `inspectSnapshot`.
 * Returns true when the message was handled (so the worker switch can stop).
 */
export function applyInspectControl(
  runtime: InspectControlRuntime,
  msg: ControlMessage,
  onCommand: (command: CommandMessage) => void,
): boolean {
  if (msg.type !== "inspect") return false;
  onCommand({
    type: "inspectSnapshot",
    snapshot: runtime.inspectWorld(),
  });
  return true;
}
