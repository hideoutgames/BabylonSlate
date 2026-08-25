import { NodeRegistry, type NodeDefinition } from "@babylonslate/scripting";
import { flowNodes } from "./flow";
import { mathNodes } from "./math";
import { vectorNodes } from "./vector";
import { stringNodes } from "./string";
import { selectNodes } from "./select";
import { arrayMapNodes } from "./array-map";
import { mapNodes } from "./map";
import { actorNodes } from "./actor";
import { componentNodes } from "./component";
import { transformNodes } from "./transform";
import { physicsNodes } from "./physics";
import { registerPhysicsValidationRules } from "./physics";
import { inputNodes } from "./input";
import { audioNodes } from "./audio";
import { particleNodes } from "./particles";
import { sceneNodes } from "./scene";
import { renderNodes } from "./render";
import { debugNodes } from "./debug";
import { debugDrawNodes } from "./debug-draw";
import { interfaceNodes } from "./interface";
import { variableNodes } from "./variables";
import { functionCallNodes } from "./functions";
import { castingNodes } from "./casting";
import { timerNodes } from "./timers";
import { behaviourTreeNodes } from "./behaviour-tree";
import { navigationNodes } from "./navigation";
import { illuminationNodes } from "./illumination";
import { animationNodes } from "./animation";
import { structNodes } from "./struct";
import { enumNodes } from "./enum";
import { literalNodes } from "./literal";
import { rotatorNodes } from "./rotator";
import { colorNodes } from "./color";
import { quatNodes } from "./quat";

export * from "./flow";
export * from "./math";
export * from "./vector";
export * from "./string";
export * from "./select";
export * from "./array-map";
export * from "./map";
export * from "./actor";
export * from "./component";
export * from "./transform";
export * from "./physics";
export * from "./input";
export * from "./audio";
export * from "./particles";
export * from "./scene";
export * from "./render";
export * from "./debug";
export * from "./debug-draw";
export * from "./interface";
export * from "./variables";
export * from "./functions";
export * from "./member-pins";
export * from "./casting";
export * from "./timers";
export * from "./behaviour-tree";
export * from "./navigation";
export * from "./illumination";
export * from "./animation";
export * from "./struct";
export * from "./enum";
export * from "./literal";
export * from "./rotator";
export * from "./color";
export * from "./quat";

export const ALL_NODE_CATEGORIES = [
  "flow",
  "math",
  "vector",
  "string",
  "select",
  "array",
  "map",
  "actor",
  "component",
  "transform",
  "physics",
  "input",
  "audio",
  "particles",
  "scene",
  "render",
  "debug",
  "interface",
  "variables",
  "functions",
  "casting",
  "timers",
  "behaviour-tree",
  "navigation",
  "camera",
  "light",
  "animation",
  "struct",
  "enum",
  "literal",
  "rotator",
  "color",
  "quaternion",
] as const;

export function allNodeDefinitions(): NodeDefinition[] {
  return [
    ...flowNodes,
    ...mathNodes,
    ...vectorNodes,
    ...stringNodes,
    ...selectNodes,
    ...arrayMapNodes,
    ...mapNodes,
    ...actorNodes,
    ...componentNodes,
    ...transformNodes,
    ...physicsNodes,
    ...inputNodes,
    ...audioNodes,
    ...particleNodes,
    ...sceneNodes,
    ...renderNodes,
    ...debugNodes,
    ...debugDrawNodes,
    ...interfaceNodes,
    ...variableNodes,
    ...functionCallNodes,
    ...castingNodes,
    ...timerNodes,
    ...behaviourTreeNodes,
    ...navigationNodes,
    ...illuminationNodes,
    ...animationNodes,
    ...structNodes,
    ...enumNodes,
    ...literalNodes,
    ...rotatorNodes,
    ...colorNodes,
    ...quatNodes,
  ];
}

export function createDefaultNodeRegistry(): NodeRegistry {
  registerPhysicsValidationRules();
  const registry = new NodeRegistry();
  registry.registerAll(allNodeDefinitions());
  return registry;
}
