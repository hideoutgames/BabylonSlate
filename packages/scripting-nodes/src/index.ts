import { withNodeDescriptions } from "./node-descriptions";
import { waterNodes } from "./water";
import { EVENT_BY_TYPE_ID, NodeRegistry, type NodeDefinition } from "@haptic/scripting";
import { catalogEventDefinitions, flowNodes } from "./flow";
import { mathNodes } from "./math";
import { vectorNodes } from "./vector";
import { stringNodes } from "./string";
import { utilityHelperNodes } from "./utility-helpers";
import { selectNodes } from "./select";
import { arrayMapNodes } from "./array-map";
import { mapNodes } from "./map";
import { actorNodes } from "./actor";
import { objectNodes } from "./objects";
import { componentNodes } from "./component";
import { transformNodes } from "./transform";
import { physicsNodes } from "./physics";
import { registerPhysicsValidationRules } from "./physics";
import { inputNodes } from "./input";
import { audioNodes } from "./audio";
import { particleNodes } from "./particles";
import { globalParameterNodes } from "./global-parameters";
import { sceneNodes } from "./scene";
import { sceneStreamingNodes } from "./scene-streaming";
import { assetLoadingNodes } from "./asset-loading";
import { assetRegistryNodes } from "./asset-registry";
import { projectNodes } from "./project";
import { saveGameNodes } from "./save-game";
import { gameInstanceNodes } from "./game-instance";
import { subsystemNodes } from "./subsystem";
import { sceneOwnedNodes } from "./scene-owned";
import { timelineClipNodes } from "./timeline-clips";
import { timelineAssetNodes } from "./timeline-assets";
import { timelineProxyNodes } from "./timeline-proxies";
import { sceneLayerNodes, registerSceneLayerValidationRules } from "./scene-layer";
import { scalabilityNodes } from "./scalability";
import { renderTargetNodes } from "./render-target";
import { materialNodes } from "./material";
import { debugNodes } from "./debug";
import { debugDrawNodes } from "./debug-draw";
import { interfaceNodes } from "./interface";
import { variableNodes } from "./variables";
import { functionCallNodes } from "./functions";
import { castingNodes } from "./casting";
import { timerNodes } from "./timers";
import { cameraShakeNodes } from "./camera-shake";
import { timeNodes } from "./time";
import { systemNodes } from "./system";
import { randomNodes } from "./random";
import { sceneObjectNodes } from "./scene-objects";
import { tweenNodes } from "./tween";
import { behaviourTreeNodes } from "./behaviour-tree";
import { navigationNodes } from "./navigation";
import { illuminationNodes } from "./illumination";
import { animationNodes } from "./animation";
import { animPoseNodes } from "./anim-pose";
import { structNodes } from "./struct";
import { dataNodes } from "./data";
import { editorDataNodes } from "./editor-data";
import { enumNodes } from "./enum";
import { literalNodes } from "./literal";
import { rotatorNodes } from "./rotator";
import { colorNodes } from "./color";
import { quatNodes } from "./quat";
import { tagNodes } from "./tags";
import { dispatcherNodes } from "./dispatchers";
import { curveRangeNodes } from "./curves-ranges";

export * from "./flow";
export * from "./anim-pose";
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
export * from "./asset-loading";
export * from "./asset-registry";
export * from "./project";
export * from "./save-game";
export * from "./game-instance";
export * from "./subsystem";
export * from "./scene-owned";
export * from "./timeline-clips";
export * from "./timeline-assets";
export * from "./timeline-proxies";
export * from "./scene-layer";
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
export * from "./time";
export * from "./system";
export * from "./tween";
export * from "./behaviour-tree";
export * from "./navigation";
export * from "./illumination";
export * from "./animation";
export * from "./struct";
export * from "./data";
export * from "./editor-data";
export * from "./enum";
export * from "./literal";
export * from "./rotator";
export * from "./color";
export * from "./quat";
export * from "./tags";
export * from "./dispatchers";
export * from "./objects";
export * from "./curves-ranges";

export function allNodeDefinitions(): NodeDefinition[] {
  return withNodeDescriptions([
    ...flowNodes,
    ...mathNodes,
    ...vectorNodes,
    ...stringNodes,
    ...utilityHelperNodes,
    ...selectNodes,
    ...arrayMapNodes,
    ...mapNodes,
    ...actorNodes,
    ...objectNodes,
    ...componentNodes,
    ...transformNodes,
    ...physicsNodes,
    ...waterNodes,
    ...inputNodes,
    ...audioNodes,
    ...particleNodes,
    ...globalParameterNodes,
    ...sceneNodes,
    ...sceneStreamingNodes,
    ...assetLoadingNodes,
    ...assetRegistryNodes,
    ...projectNodes,
    ...saveGameNodes,
    ...gameInstanceNodes,
    ...subsystemNodes,
    ...sceneOwnedNodes,
    ...timelineClipNodes,
    ...timelineAssetNodes,
    ...timelineProxyNodes,
    ...sceneLayerNodes,
    ...renderTargetNodes,
    ...scalabilityNodes,
    ...materialNodes,
    ...debugNodes,
    ...debugDrawNodes,
    ...interfaceNodes,
    ...variableNodes,
    ...functionCallNodes,
    ...dispatcherNodes,
    ...castingNodes,
    ...timerNodes,
    ...cameraShakeNodes,
    ...timeNodes,
    ...systemNodes,
    ...randomNodes,
    ...sceneObjectNodes,
    ...tweenNodes,
    ...behaviourTreeNodes,
    ...navigationNodes,
    ...illuminationNodes,
    ...animationNodes,
    ...animPoseNodes,
    ...structNodes,
    ...dataNodes,
    ...editorDataNodes,
    ...enumNodes,
    ...literalNodes,
    ...rotatorNodes,
    ...colorNodes,
    ...quatNodes,
    ...tagNodes,
    ...curveRangeNodes,
  ]);
}

// Call Parent takes its pins from the event it calls, wherever that event is defined.
for (const definition of allNodeDefinitions()) {
  if (Object.hasOwn(EVENT_BY_TYPE_ID, definition.id)) catalogEventDefinitions.set(definition.id, definition);
}

export function createDefaultNodeRegistry(): NodeRegistry {
  registerPhysicsValidationRules();
  registerSceneLayerValidationRules();
  const registry = new NodeRegistry();
  registry.registerAll(allNodeDefinitions());
  return registry;
}
