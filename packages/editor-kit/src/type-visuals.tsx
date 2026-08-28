import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  AnchorIcon,
  BoxIcon,
  BoxesIcon,
  BracesIcon,
  CameraIcon,
  CircleDashedIcon,
  CloudIcon,
  CylinderIcon,
  FileIcon,
  FileJsonIcon,
  FilmIcon,
  Grid3x3Icon,
  HexagonIcon,
  ImageIcon,
  ImagesIcon,
  Layers2Icon,
  LayersIcon,
  LayoutGridIcon,
  LightbulbIcon,
  ListIcon,
  ListTreeIcon,
  MapIcon,
  MousePointerClickIcon,
  NavigationIcon,
  PaintbrushIcon,
  PersonStandingIcon,
  PlugIcon,
  PuzzleIcon,
  SparklesIcon,
  SquareDashedIcon,
  TypeIcon,
  Volume2Icon,
  WindIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@babylonslate/ui/lib/utils";
import { ASSET_COLOR_TOKENS, assetColorVar } from "@babylonslate/ui/lib/data-types";

export type AssetVisualFamily =
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
  | "struct"
  | "component"
  | "folder"
  | "unknown";

export type TypeVisual = {
  family: AssetVisualFamily;
  colorVar: string;
  icon: LucideIcon;
  iconKey: string;
};

export type TypeVisualQuery = {
  assetType?: string;
  classId?: string;
  parentClass?: string | null;
  /** Most-specific first. */
  ancestry?: string[];
  family?: AssetVisualFamily;
};

const OBJECT_ICON = HexagonIcon;
const ACTOR_ICON = PersonStandingIcon;

const ENGINE_PARENT: Record<string, string | null> = {
  BObject: null,
  Actor: "BObject",
  Scene: "BObject",
  SceneLayer: "BObject",
  SceneLayerActor: "Actor",
  ActorComponent: "BObject",
  GameInstance: "BObject",
  FunctionLibrary: "BObject",
  BDebugCommand: "BObject",
  EditorUtilityObject: "BObject",
  EditorFunctionLibrary: "FunctionLibrary",
  BTTask: "BObject",
  BTDecorator: "BObject",
  BTService: "BObject",
  BTComposite: "BObject",
  BTTask_Wait: "BTTask",
  BTTask_MoveTo: "BTTask",
  BTTask_RotateToFace: "BTTask",
  BTTask_PlayAnimation: "BTTask",
  BTTask_PlaySound: "BTTask",
  BTTask_SetBlackboardValue: "BTTask",
  BTDecorator_Loop: "BTDecorator",
  BTDecorator_Cooldown: "BTDecorator",
  BTDecorator_TimeLimit: "BTDecorator",
  BTDecorator_BlackboardIsSet: "BTDecorator",
  BTDecorator_CompareBlackboardValue: "BTDecorator",
  BTService_SetBlackboardValue: "BTService",
  BTComposite_Selector: "BTComposite",
  BTComposite_Sequence: "BTComposite",
  BTComposite_Parallel: "BTComposite",
  MeshComponent: "ActorComponent",
  SpriteComponent: "ActorComponent",
  TilemapComponent: "ActorComponent",
  CameraComponent: "ActorComponent",
  LightComponent: "ActorComponent",
  HemisphericFillLightComponent: "ActorComponent",
  SkyboxComponent: "ActorComponent",
  Text3DComponent: "ActorComponent",
  AudioComponent: "ActorComponent",
  ParticleComponent: "ActorComponent",
  RigidBodyComponent: "ActorComponent",
  ColliderComponent: "ActorComponent",
  AnimationGraphComponent: "ActorComponent",
  BehaviourTreeComponent: "ActorComponent",
  NavAgentComponent: "ActorComponent",
  NavMeshComponent: "ActorComponent",
  NavMeshBlockerComponent: "ActorComponent",
  BlockingVolumeComponent: "ActorComponent",
  "2DAnchorComponent": "ActorComponent",
  "2DButtonComponent": "ActorComponent",
  "2DMaterialComponent": "ActorComponent",
  "2DTextureComponent": "ActorComponent",
  "2DTextComponent": "ActorComponent",
  "2DRichTextComponent": "ActorComponent",
  "2DPanelComponent": "ActorComponent",
};

const ICON_BY_ID: Record<string, LucideIcon> = {
  BObject: OBJECT_ICON,
  GameInstance: OBJECT_ICON,
  FunctionLibrary: OBJECT_ICON,
  BDebugCommand: OBJECT_ICON,
  EditorUtilityObject: OBJECT_ICON,
  EditorFunctionLibrary: OBJECT_ICON,
  BTTask: OBJECT_ICON,
  BTDecorator: OBJECT_ICON,
  BTService: OBJECT_ICON,
  BTComposite: OBJECT_ICON,
  ActorComponent: OBJECT_ICON,
  Actor: ACTOR_ICON,
  SceneLayer: Layers2Icon,
  SceneLayerActor: ACTOR_ICON,
  AnimationGraphComponent: WorkflowIcon,
  BehaviourTreeComponent: ListTreeIcon,
  NavAgentComponent: NavigationIcon,
  NavMeshComponent: MapIcon,
  NavMeshBlockerComponent: BoxIcon,
  BlockingVolumeComponent: SquareDashedIcon,
  "2DAnchorComponent": AnchorIcon,
  "2DButtonComponent": MousePointerClickIcon,
  "2DMaterialComponent": PaintbrushIcon,
  "2DTextureComponent": ImageIcon,
  "2DTextComponent": TypeIcon,
  "2DRichTextComponent": SparklesIcon,
  "2DPanelComponent": LayoutGridIcon,
  MeshComponent: BoxIcon,
  SpriteComponent: ImagesIcon,
  TilemapComponent: Grid3x3Icon,
  CameraComponent: CameraIcon,
  LightComponent: LightbulbIcon,
  HemisphericFillLightComponent: LightbulbIcon,
  SkyboxComponent: CloudIcon,
  Text3DComponent: TypeIcon,
  AudioComponent: Volume2Icon,
  ParticleComponent: SparklesIcon,
  RigidBodyComponent: CylinderIcon,
  ColliderComponent: CircleDashedIcon,
  Scene: LayersIcon,
  Graph: FileJsonIcon,
  Texture: ImageIcon,
  Material: PaintbrushIcon,
  MaterialFunction: PaintbrushIcon,
  Model: BoxesIcon,
  Mesh: BoxesIcon,
  Audio: Volume2Icon,
  AudioMixer: Volume2Icon,
  AudioChannel: Volume2Icon,
  SoundAttenuation: Volume2Icon,
  ParticleEmitter: WindIcon,
  ParticleSystem: SparklesIcon,
  SkyboxCreator: CloudIcon,
  Trace: ActivityIcon,
  Font: TypeIcon,
  Animation: FilmIcon,
  Skeleton: PersonStandingIcon,
  AnimationGraph: WorkflowIcon,
  SpriteAnimation: FilmIcon,
  BehaviourTree: ListTreeIcon,
  Blackboard: ListIcon,
  Shader: PaintbrushIcon,
  Sprite: ImagesIcon,
  Tileset: LayoutGridIcon,
  Tilemap: Grid3x3Icon,
  Class: OBJECT_ICON,
  Enum: ListIcon,
  Structure: BracesIcon,
  ScriptInterface: PlugIcon,
  PluginSettings: PuzzleIcon,
};

const COMPONENT_CLASS_IDS = new Set([
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "HemisphericFillLightComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "AudioComponent",
  "ParticleComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "AnimationGraphComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
  "NavMeshComponent",
  "NavMeshBlockerComponent",
  "BlockingVolumeComponent",
  "2DAnchorComponent",
  "2DButtonComponent",
  "2DMaterialComponent",
  "2DTextureComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DPanelComponent",
]);

const FAMILY_BY_ASSET_TYPE: Record<string, AssetVisualFamily> = {
  Scene: "scene",
  SceneLayer: "scene",
  Graph: "graph",
  Texture: "texture",
  Material: "material",
  MaterialFunction: "material",
  Model: "model",
  Mesh: "model",
  Audio: "class",
  AudioMixer: "scene",
  AudioChannel: "struct",
  SoundAttenuation: "class",
  ParticleEmitter: "material",
  ParticleSystem: "material",
  SkyboxCreator: "material",
  Trace: "class",
  Font: "font",
  Animation: "animation",
  Skeleton: "animation",
  AnimationGraph: "animation",
  SpriteAnimation: "animation",
  BehaviourTree: "class",
  Blackboard: "struct",
  Shader: "material",
  Sprite: "texture",
  Tileset: "texture",
  Tilemap: "texture",
  Class: "class",
  Enum: "scriptType",
  Structure: "struct",
  ScriptInterface: "class",
  PluginSettings: "scriptType",
};

export { ASSET_COLOR_TOKENS };

const COLOR_BY_FAMILY: Record<AssetVisualFamily, string> = {
  scene: assetColorVar("scene"),
  graph: assetColorVar("graph"),
  texture: assetColorVar("texture"),
  material: assetColorVar("material"),
  model: assetColorVar("model"),
  audio: assetColorVar("audio"),
  font: assetColorVar("font"),
  animation: assetColorVar("animation"),
  class: assetColorVar("animation"),
  scriptType: assetColorVar("scriptType"),
  struct: assetColorVar("class"),
  component: assetColorVar("component"),
  folder: assetColorVar("folder"),
  unknown: assetColorVar("unknown"),
};

export function engineParentOf(classId: string): string | null | undefined {
  if (classId in ENGINE_PARENT) return ENGINE_PARENT[classId];
  return undefined;
}

export function walkAncestry(
  start: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): string[] {
  const chain: string[] = [];
  let current = start ?? null;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = parentOf(current) ?? null;
  }
  return chain;
}

function candidateIds(query: TypeVisualQuery): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of query.ancestry ?? []) push(id);
  push(query.classId);
  let parent = query.classId ? engineParentOf(query.classId) : undefined;
  while (parent) {
    push(parent);
    parent = engineParentOf(parent);
  }
  push(query.parentClass);
  push(query.assetType);
  return ids;
}

function iconIdFor(query: TypeVisualQuery): string | undefined {
  return candidateIds(query).find((id) => id in ICON_BY_ID);
}

function familyFor(query: TypeVisualQuery, iconId: string | undefined): AssetVisualFamily {
  if (query.family) return query.family;
  if (query.assetType) {
    return FAMILY_BY_ASSET_TYPE[query.assetType] ?? "unknown";
  }
  if (iconId && COMPONENT_CLASS_IDS.has(iconId)) return "component";
  if (iconId && iconId in ENGINE_PARENT) return "class";
  return "unknown";
}

export function resolveTypeVisual(query: TypeVisualQuery = {}): TypeVisual {
  const iconId = iconIdFor(query);
  const family = familyFor(query, iconId);
  return {
    family,
    colorVar: COLOR_BY_FAMILY[family],
    icon: iconId ? ICON_BY_ID[iconId]! : FileIcon,
    iconKey: iconId ?? "File",
  };
}

export function resolveActorTypeVisual(actor: {
  classId?: string;
  components?: Array<{ classId: string }>;
  ancestry?: string[];
}): TypeVisual {
  const classId = actor.classId ?? "Actor";
  const ancestry =
    actor.ancestry ??
    walkAncestry(classId, (id) => engineParentOf(id) ?? null);
  const engineId = ancestry.find((id) => id in ICON_BY_ID);

  if (classId === "Actor" && engineId === "Actor") {
    const hint = actor.components?.find((component) =>
      COMPONENT_CLASS_IDS.has(component.classId),
    )?.classId;
    if (hint) {
      return resolveTypeVisual({ classId: hint, family: "class" });
    }
  }

  return resolveTypeVisual({
    classId,
    ancestry,
    family: "class",
  });
}

export const TYPE_VISUAL_ICON_CHROME_SIZE = 16;
export const TYPE_VISUAL_ICON_TILE_SIZE = 40;
/** Lucide design stroke in CSS px when `absoluteStrokeWidth` is set on tiles. */
export const TYPE_VISUAL_ICON_TILE_STROKE_WIDTH = 2;

export function TypeVisualIcon({
  visual,
  size = TYPE_VISUAL_ICON_CHROME_SIZE,
  className,
  "data-testid": testId,
}: {
  visual: TypeVisual;
  size?: number;
  className?: string;
  "data-testid"?: string;
}) {
  const Icon = visual.icon;
  const isTile = size >= TYPE_VISUAL_ICON_TILE_SIZE;
  const sizeClass = isTile ? "size-10" : "size-4";
  return (
    <Icon
      size={size}
      color={visual.colorVar}
      strokeWidth={TYPE_VISUAL_ICON_TILE_STROKE_WIDTH}
      absoluteStrokeWidth={isTile}
      className={cn(sizeClass, "shrink-0 overflow-visible", className)}
      data-testid={testId}
      data-type-family={visual.family}
      data-type-icon={visual.iconKey}
      aria-hidden
    />
  );
}
