/** Canonical type-color maps. CSS values live in `styles/globals.css`. */

export const PIN_COLOR_VAR = {
  exec: "var(--pin-exec)",
  bool: "var(--pin-bool)",
  int: "var(--pin-int)",
  float: "var(--pin-float)",
  string: "var(--pin-string)",
  vector: "var(--pin-vector)",
  rotator: "var(--pin-rotator)",
  quat: "var(--pin-quat)",
  transform: "var(--pin-transform)",
  color: "var(--pin-color)",
  object: "var(--pin-object)",
  actor: "var(--pin-actor)",
  class: "var(--pin-class)",
  struct: "var(--pin-struct)",
  enum: "var(--pin-enum)",
  wildcard: "var(--pin-wildcard)",
  delegate: "var(--pin-delegate)",
  particle: "var(--pin-particle)",
} as const;

export const PIN_KIND_COLOR_VAR: Record<string, string> = {
  exec: PIN_COLOR_VAR.exec,
  bool: PIN_COLOR_VAR.bool,
  int: PIN_COLOR_VAR.int,
  float: PIN_COLOR_VAR.float,
  string: PIN_COLOR_VAR.string,
  vec2: PIN_COLOR_VAR.vector,
  vec3: PIN_COLOR_VAR.vector,
  vec4: PIN_COLOR_VAR.vector,
  rotator: PIN_COLOR_VAR.rotator,
  quat: PIN_COLOR_VAR.quat,
  transform: PIN_COLOR_VAR.transform,
  color: PIN_COLOR_VAR.color,
  objectRef: PIN_COLOR_VAR.object,
  actorRef: PIN_COLOR_VAR.actor,
  classRef: PIN_COLOR_VAR.class,
  assetRef: PIN_COLOR_VAR.object,
  texture: PIN_COLOR_VAR.object,
  structRef: PIN_COLOR_VAR.struct,
  enumRef: PIN_COLOR_VAR.enum,
  resolvingWildcard: PIN_COLOR_VAR.wildcard,
  boxedWildcard: PIN_COLOR_VAR.wildcard,
  delegate: PIN_COLOR_VAR.delegate,
  particle: PIN_COLOR_VAR.particle,
};

export const PIN_COLOR_TOKENS = [
  "--pin-exec",
  "--pin-bool",
  "--pin-int",
  "--pin-float",
  "--pin-string",
  "--pin-vector",
  "--pin-rotator",
  "--pin-quat",
  "--pin-transform",
  "--pin-color",
  "--pin-object",
  "--pin-actor",
  "--pin-class",
  "--pin-struct",
  "--pin-enum",
  "--pin-wildcard",
  "--pin-delegate",
  "--pin-particle",
] as const;

/** Graph node header roles; `--node-*` values live in `styles/globals.css`. */
export const NODE_ROLE_COLOR_VAR = {
  event: "var(--node-event)",
  "call-parent": "var(--node-call-parent)",
  function: "var(--node-function)",
  pure: "var(--node-pure)",
  flow: "var(--node-flow)",
  variable: "var(--node-variable)",
  "variable-set": "var(--node-variable-set)",
  latent: "var(--node-latent)",
  debug: "var(--node-debug)",
  "bt-root": "var(--node-bt-root)",
  "bt-composite": "var(--node-bt-composite)",
  "bt-task": "var(--node-bt-task)",
} as const;

export type NodeRole = keyof typeof NODE_ROLE_COLOR_VAR;

export function nodeRoleColorVar(role: NodeRole): string {
  return NODE_ROLE_COLOR_VAR[role];
}

/**
 * Particle stages shared by Basic Particle Emitter stage accents and Particle
 * Graph node headers, so both editors show the same colour sequence.
 */
export type ParticleStage =
  | "output"
  | "create"
  | "shape"
  | "update"
  | "input"
  | "value";

export const PARTICLE_STAGE_ROLE: Record<ParticleStage, NodeRole> = {
  output: "event",
  create: "function",
  shape: "latent",
  update: "pure",
  input: "variable",
  value: "flow",
};

/** Basic Particle Emitter module-stack stages, in their fixed display order. */
export type BasicParticleStage =
  | "emitter"
  | "spawn"
  | "shape"
  | "initialize"
  | "overLife"
  | "forces"
  | "render";

export const BASIC_PARTICLE_STAGE: Record<BasicParticleStage, ParticleStage> = {
  emitter: "output",
  spawn: "output",
  shape: "shape",
  initialize: "create",
  overLife: "update",
  forces: "update",
  render: "output",
};

export function basicParticleStageRole(stage: BasicParticleStage): NodeRole {
  return PARTICLE_STAGE_ROLE[BASIC_PARTICLE_STAGE[stage]];
}

export type AssetColorFamily =
  | "scene"
  | "graph"
  | "texture"
  | "material"
  | "model"
  | "audio"
  | "font"
  | "animation"
  | "class"
  | "scriptType"
  | "component"
  | "folder"
  | "unknown";

export const ASSET_COLOR_VAR: Record<AssetColorFamily, string> = {
  scene: "var(--asset-scene)",
  graph: "var(--asset-graph)",
  texture: "var(--asset-texture)",
  material: "var(--asset-material)",
  model: "var(--asset-model)",
  audio: "var(--asset-audio)",
  font: "var(--asset-font)",
  animation: "var(--asset-animation)",
  class: "var(--asset-class)",
  scriptType: "var(--asset-script-type)",
  component: "var(--asset-component)",
  folder: "var(--asset-folder)",
  unknown: "var(--muted-foreground)",
};

export const ASSET_COLOR_TOKENS = [
  "--asset-scene",
  "--asset-graph",
  "--asset-texture",
  "--asset-material",
  "--asset-model",
  "--asset-audio",
  "--asset-font",
  "--asset-animation",
  "--asset-class",
  "--asset-script-type",
  "--asset-component",
  "--asset-folder",
] as const;

export function pinColorVar(kind: string): string {
  return PIN_KIND_COLOR_VAR[kind] ?? PIN_COLOR_VAR.wildcard;
}

export function assetColorVar(family: string): string {
  if (family in ASSET_COLOR_VAR) {
    return ASSET_COLOR_VAR[family as AssetColorFamily];
  }
  return ASSET_COLOR_VAR.unknown;
}

export function typeColorThumbAccent(colorVar: string): {
  border: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
} {
  return {
    border: `2px solid ${colorVar}`,
    borderTopLeftRadius: "calc(var(--radius-xl) - 2px)",
    borderTopRightRadius: "calc(var(--radius-xl) - 2px)",
  };
}
