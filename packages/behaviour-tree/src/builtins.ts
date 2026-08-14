/** IR class ids and authoring aliases (BTTask_Wait → bt.task.wait). */
export const BT_CLASS_ALIASES: Record<string, string> = {
  BTTask_Wait: "bt.task.wait",
  BTTask_MoveTo: "bt.task.moveTo",
  BTTask_RotateToFace: "bt.task.rotateToFace",
  BTTask_PlayAnimation: "bt.task.playAnimation",
  BTTask_PlaySound: "bt.task.playSound",
  BTTask_SetBlackboardValue: "bt.task.setBlackboard",
  BTDecorator_Loop: "bt.decorator.loop",
  BTDecorator_Cooldown: "bt.decorator.cooldown",
  BTDecorator_TimeLimit: "bt.decorator.timeLimit",
  BTDecorator_BlackboardIsSet: "bt.decorator.blackboardIsSet",
  BTDecorator_CompareBlackboardValue: "bt.decorator.compareBlackboardValue",
  BTService_SetBlackboardValue: "bt.service.setBlackboard",
  BTComposite_Selector: "bt.composite.selector",
  BTComposite_Sequence: "bt.composite.sequence",
  BTComposite_Parallel: "bt.composite.parallel",
};

export const BUILTIN_TASKS = new Set([
  "bt.task.succeed",
  "bt.task.fail",
  "bt.task.wait",
  "bt.task.setBlackboard",
  "bt.task.moveTo",
  "bt.task.rotateToFace",
  "bt.task.playAnimation",
  "bt.task.playSound",
]);

export function builtinClassId(classId: string): string {
  return BT_CLASS_ALIASES[classId] ?? classId;
}
