/** IR class ids and authoring aliases (BTTask_Wait → bt.task.wait). */
export const BT_CLASS_ALIASES: Record<string, string> = {
  BTTask_Wait: "bt.task.wait",
  BTTask_MoveTo: "bt.task.moveTo",
  BTTask_MoveToBlackboardKey: "bt.task.moveToBlackboardKey",
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

const BUILTIN_BEHAVIOUR_TREE_CLASS_IDS = new Set([
  ...Object.keys(BT_CLASS_ALIASES),
  ...Object.values(BT_CLASS_ALIASES),
  "bt.task.succeed",
  "bt.task.fail",
]);

/** Exact native BT identities; custom classes still require catalog resolution. */
export function isBuiltinBehaviourTreeClassId(classId: string): boolean {
  return BUILTIN_BEHAVIOUR_TREE_CLASS_IDS.has(classId);
}
