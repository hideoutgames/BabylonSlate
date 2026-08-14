import type { LucideIcon } from "lucide-react";
import {
  AppWindowIcon,
  BoxIcon,
  BoxesIcon,
  BracesIcon,
  CameraIcon,
  CircleDashedIcon,
  CylinderIcon,
  FileIcon,
  FileJsonIcon,
  FilmIcon,
  Grid3x3Icon,
  HexagonIcon,
  ImageIcon,
  ImagesIcon,
  LayersIcon,
  LayoutGridIcon,
  LightbulbIcon,
  ListIcon,
  MapIcon,
  NavigationIcon,
  PaintbrushIcon,
  PersonStandingIcon,
  PlugIcon,
  TypeIcon,
  Volume2Icon,
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
const WIDGET_ICON = AppWindowIcon;

const ENGINE_PARENT: Record<string, string | null> = {
  BObject: null,
  Actor: "BObject",
  ActorComponent: "BObject",
  GameInstance: "BObject",
  FunctionLibrary: "BObject",
  BDebugCommand: "BObject",
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
  AudioComponent: "ActorComponent",
  RigidBodyComponent: "ActorComponent",
  ColliderComponent: "ActorComponent",
  WidgetComponent: "ActorComponent",
  AnimationGraphComponent: "ActorComponent",
  BehaviourTreeComponent: "ActorComponent",
  NavAgentComponent: "ActorComponent",
  NavMeshComponent: "ActorComponent",
};

const ICON_BY_ID: Record<string, LucideIcon> = {
  BObject: OBJECT_ICON,
  GameInstance: OBJECT_ICON,
  FunctionLibrary: OBJECT_ICON,
  BDebugCommand: OBJECT_ICON,
  BTTask: OBJECT_ICON,
  BTDecorator: OBJECT_ICON,
  BTService: OBJECT_ICON,
  BTComposite: OBJECT_ICON,
  ActorComponent: OBJECT_ICON,
  Actor: ACTOR_ICON,
  WidgetComponent: WIDGET_ICON,
  AnimationGraphComponent: FilmIcon,
  BehaviourTreeComponent: FilmIcon,
  NavAgentComponent: NavigationIcon,
  NavMeshComponent: MapIcon,
  MeshComponent: BoxIcon,
  SpriteComponent: ImagesIcon,
  TilemapComponent: Grid3x3Icon,
  CameraComponent: CameraIcon,
  LightComponent: LightbulbIcon,
  AudioComponent: Volume2Icon,
  RigidBodyComponent: CylinderIcon,
  ColliderComponent: CircleDashedIcon,
  Scene: LayersIcon,
  Graph: FileJsonIcon,
  Texture: ImageIcon,
  Material: PaintbrushIcon,
  Model: BoxesIcon,
  Audio: Volume2Icon,
  Font: TypeIcon,
  Animation: FilmIcon,
  AnimationGraph: FilmIcon,
  BehaviourTree: FilmIcon,
  Blackboard: ListIcon,
  Shader: PaintbrushIcon,
  Sprite: ImagesIcon,
  Tileset: LayoutGridIcon,
  Tilemap: Grid3x3Icon,
  UserInterface: WIDGET_ICON,
  Class: OBJECT_ICON,
  Enum: ListIcon,
  Structure: BracesIcon,
  ScriptInterface: PlugIcon,
};

const COMPONENT_CLASS_IDS = new Set([
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "WidgetComponent",
  "AnimationGraphComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
  "NavMeshComponent",
]);

const FAMILY_BY_ASSET_TYPE: Record<string, AssetVisualFamily> = {
  Scene: "scene",
  Graph: "graph",
  Texture: "texture",
  Material: "material",
  Model: "model",
  Audio: "audio",
  Font: "font",
  Animation: "animation",
  AnimationGraph: "animation",
  BehaviourTree: "graph",
  Blackboard: "scriptType",
  Shader: "material",
  Sprite: "texture",
  Tileset: "texture",
  Tilemap: "texture",
  UserInterface: "graph",
  Class: "class",
  Enum: "scriptType",
  Structure: "scriptType",
  ScriptInterface: "scriptType",
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
  class: assetColorVar("class"),
  scriptType: assetColorVar("scriptType"),
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

export function TypeVisualIcon({
  visual,
  className,
  "data-testid": testId,
}: {
  visual: TypeVisual;
  className?: string;
  "data-testid"?: string;
}) {
  const Icon = visual.icon;
  return (
    <Icon
      className={cn("size-4 shrink-0", className)}
      style={{ color: visual.colorVar }}
      data-testid={testId}
      data-type-family={visual.family}
      data-type-icon={visual.iconKey}
      aria-hidden
    />
  );
}
