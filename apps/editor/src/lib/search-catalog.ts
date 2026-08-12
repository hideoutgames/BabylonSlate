import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ENGINE_BASE_CLASSES } from "./content-browser-helpers";

/** Engine class ids indexed as catalog hits (mirrors object-model ids). */
export const SEARCH_CATALOG_CLASS_IDS: readonly string[] = [
  ...ENGINE_BASE_CLASSES,
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "WidgetComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
];

const nodeRegistry = createDefaultNodeRegistry();

/** Graph node type id → palette title, plus the legacy logMessage alias. */
export const SEARCH_NODE_TITLES: Record<string, string> = {
  logMessage: "Log",
};

for (const definition of nodeRegistry.list()) {
  SEARCH_NODE_TITLES[definition.id] = definition.title;
}
