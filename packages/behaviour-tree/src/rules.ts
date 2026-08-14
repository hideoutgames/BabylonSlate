import {
  listValidationRules,
  registerValidationRule,
  type TypeContext,
} from "@babylonslate/scripting";
import { parseBehaviourTreeDocument } from "./tree";
import { validateBehaviourTree } from "./validate";

export function registerBehaviourTreeValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "bt.structural")) return;
  registerValidationRule({
    id: "bt.structural",
    run(_graphs, ctx: TypeContext) {
      const tree = parseBehaviourTreeDocument(ctx.behaviourTree);
      if (!tree) return [];
      return validateBehaviourTree(tree, ctx);
    },
  });
}
