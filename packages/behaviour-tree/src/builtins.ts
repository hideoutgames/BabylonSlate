import { BT_CLASS_ALIASES } from "@babylonslate/core";

export { BT_CLASS_ALIASES } from "@babylonslate/core";

export const BUILTIN_TASKS = new Set([
  "bt.task.succeed",
  "bt.task.fail",
  "bt.task.wait",
  "bt.task.setBlackboard",
  "bt.task.moveTo",
  "bt.task.moveToBlackboardKey",
  "bt.task.rotateToFace",
  "bt.task.playAnimation",
  "bt.task.playSound",
]);

/** Built-ins that need a runtime host when one is attached (else package stubs succeed). */
export const HOST_TASKS = new Set([
  "bt.task.moveTo",
  "bt.task.moveToBlackboardKey",
  "bt.task.rotateToFace",
  "bt.task.playAnimation",
  "bt.task.playSound",
]);

export function builtinClassId(classId: string): string {
  return BT_CLASS_ALIASES[classId] ?? classId;
}
