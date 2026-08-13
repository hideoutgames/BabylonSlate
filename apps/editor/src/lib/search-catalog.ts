import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ENGINE_BASE_CLASSES } from "./content-browser-helpers";

/** Engine class ids indexed as catalog hits (shipped types only; unbuilt P10/P11 ids stay in object-model). */
export const SEARCH_CATALOG_CLASS_IDS: readonly string[] = [
  ...ENGINE_BASE_CLASSES,
  "MeshComponent",
  "SpriteComponent",
  "CameraComponent",
  "LightComponent",
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "AnimationGraphComponent",
];

const nodeRegistry = createDefaultNodeRegistry();

/** Graph node type id → palette title, plus the legacy logMessage alias. */
export const SEARCH_NODE_TITLES: Record<string, string> = {
  logMessage: "Log",
};

for (const definition of nodeRegistry.list()) {
  SEARCH_NODE_TITLES[definition.id] = definition.title;
}
