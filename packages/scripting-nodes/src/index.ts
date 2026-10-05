import { waterNodes } from "./water";
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
import { sceneStreamingNodes } from "./scene-streaming";
import { projectNodes } from "./project";
import { gameInstanceNodes } from "./game-instance";
import { subsystemNodes } from "./subsystem";
import { sceneLayerNodes, registerSceneLayerValidationRules } from "./scene-layer";
import { scalabilityNodes } from "./scalability";
import { renderNodes } from "./render";
import { renderTargetNodes } from "./render-target";
import { materialNodes } from "./material";
import { debugNodes } from "./debug";
import { debugDrawNodes } from "./debug-draw";
import { interfaceNodes } from "./interface";
import { variableNodes } from "./variables";
import { functionCallNodes } from "./functions";
import { castingNodes } from "./casting";
import { timerNodes } from "./timers";
import { tweenNodes } from "./tween";
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
import { tagNodes } from "./tags";

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
export * from "./water";
export * from "./input";
export * from "./audio";
export * from "./particles";
export * from "./scene";
export * from "./scene-streaming";
export * from "./project";
export * from "./game-instance";
export * from "./subsystem";
export * from "./scene-layer";
export * from "./render";
export * from "./render-target";
export * from "./scalability";
export * from "./material";
export * from "./debug";
export * from "./debug-draw";
export * from "./interface";
export * from "./variables";
export * from "./functions";
export * from "./member-pins";
export * from "./casting";
export * from "./timers";
export * from "./tween";
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
export * from "./tags";

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
    ...waterNodes,
    ...inputNodes,
    ...audioNodes,
    ...particleNodes,
    ...sceneNodes,
    ...sceneStreamingNodes,
    ...projectNodes,
    ...gameInstanceNodes,
    ...subsystemNodes,
    ...sceneLayerNodes,
    ...renderNodes,
    ...renderTargetNodes,
    ...scalabilityNodes,
    ...materialNodes,
    ...debugNodes,
    ...debugDrawNodes,
    ...interfaceNodes,
    ...variableNodes,
    ...functionCallNodes,
    ...castingNodes,
    ...timerNodes,
    ...tweenNodes,
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
    ...tagNodes,
  ];
}

export function createDefaultNodeRegistry(): NodeRegistry {
  registerPhysicsValidationRules();
  registerSceneLayerValidationRules();
  const registry = new NodeRegistry();
  registry.registerAll(allNodeDefinitions());
  return registry;
}
