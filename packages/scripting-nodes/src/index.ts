import { NodeRegistry, type NodeDefinition } from "@babylonslate/scripting";
import { flowNodes } from "./flow";
import { mathNodes } from "./math";
import { vectorNodes } from "./vector";
import { stringNodes } from "./string";
import { arrayMapNodes } from "./array-map";
import { actorNodes } from "./actor";
import { componentNodes } from "./component";
import { transformNodes } from "./transform";
import { physicsNodes } from "./physics";
import { inputNodes } from "./input";
import { audioNodes } from "./audio";
import { uiNodes } from "./ui";
import { sceneNodes } from "./scene";
import { debugNodes } from "./debug";
import { interfaceNodes } from "./interface";
import { variableNodes } from "./variables";
import { castingNodes } from "./casting";
import { timerNodes } from "./timers";

export * from "./flow";
export * from "./math";
export * from "./vector";
export * from "./string";
export * from "./array-map";
export * from "./actor";
export * from "./component";
export * from "./transform";
export * from "./physics";
export * from "./input";
export * from "./audio";
export * from "./ui";
export * from "./scene";
export * from "./debug";
export * from "./interface";
export * from "./variables";
export * from "./casting";
export * from "./timers";

export const ALL_NODE_CATEGORIES = [
  "flow",
  "math",
  "vector",
  "string",
  "array",
  "actor",
  "component",
  "transform",
  "physics",
  "input",
  "audio",
  "ui",
  "scene",
  "debug",
  "interface",
  "variables",
  "casting",
  "timers",
] as const;

export function allNodeDefinitions(): NodeDefinition[] {
  return [
    ...flowNodes,
    ...mathNodes,
    ...vectorNodes,
    ...stringNodes,
    ...arrayMapNodes,
    ...actorNodes,
    ...componentNodes,
    ...transformNodes,
    ...physicsNodes,
    ...inputNodes,
    ...audioNodes,
    ...uiNodes,
    ...sceneNodes,
    ...debugNodes,
    ...interfaceNodes,
    ...variableNodes,
    ...castingNodes,
    ...timerNodes,
  ];
}

export function createDefaultNodeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerAll(allNodeDefinitions());
  return registry;
}
