import { saveGamePropertyRows } from "./save-game-property-rows";
import { isUIControl2DClass } from "@haptic/core";
import { uiControlPropertyRows } from "./ui-control-property-rows";
import { waterKindForClass } from "@haptic/core";
import { isOverlayLayoutClass } from "@haptic/core";
import { overlayLayoutPropertyRows } from "./overlay-layout-property-rows";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  walkAncestry,
  type ClassPickerEntry,
} from "@haptic/editor-kit";
import {
  quaternionToEulerDegrees,
  isEditorGraphClass,
  parseDeformerProperties,
  type EngineComponentClassId,
  type SerializedComponent,
} from "@haptic/core";
import { MODEL_MATERIALS_PICKER_VALUE } from "./mesh-material-properties";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_COMPONENT_CLASS_IDS,
  isCreatableObjectChain,
  isHiddenEngineBaseClassId,
} from "@haptic/object-model";
import { classParentLookup, classIdFromClassAsset } from "./content-browser-helpers";
import { physicsConstraintPropertyRows } from "./physics-constraint-property-rows";
import { deformerPropertyRows } from "./deformer-property-rows";
import { movementPropertyRows } from "./movement-property-rows";
import { focusPropertyRows } from "./focus-property-rows";
import { painterPropertyRows } from "./painter-property-rows";
import {
  assetRow,
  genericRows,
  guidValue,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
  type ComponentRowBuilder,
} from "./component-property-row-helpers";
import {
  animationGraphPropertyRows,
  audioPropertyRows,
  behaviourTreePropertyRows,
  particlePropertyRows,
  sceneStreamingPropertyRows,
  spritePropertyRows,
  tilemapPropertyRows,
} from "./asset-component-property-rows";
import { cameraPropertyRows, renderTargetCapturePropertyRows, springArmPropertyRows } from "./camera-property-rows";
import { areaRectLightPropertyRows, hemisphericFillLightPropertyRows, lightPropertyRows } from "./light-property-rows";
import { cableComponentPropertyRows, dynamicRuntimeMeshPropertyRows, meshPropertyRows } from "./mesh-property-rows";
import { navAgentPropertyRows, navMeshBlockerPropertyRows, navMeshPropertyRows } from "./navigation-property-rows";
import { anchor2DPropertyRows, joystick2DPropertyRows, panel2DPropertyRows, visual2DPropertyRows } from "./overlay-element-property-rows";
import { splinePropertyRows } from "./path-property-rows";
import { foliagePropertyRows, landscapePropertyRows } from "./landscape-property-rows";
import { colliderPropertyRows, ragdollPropertyRows, rigidBodyPropertyRows } from "./physics-body-property-rows";
import {
  fogVolumePropertyRows,
  mirrorPropertyRows,
  outlinePropertyRows,
  reflectionProbePropertyRows,
  skyboxPropertyRows,
} from "./render-feature-property-rows";
import { text2DPropertyRows, text3DPropertyRows } from "./text-property-rows";
import { waterBodyPropertyRows, waterBuoyancyPropertyRows, waterRemovalPropertyRows } from "./water-property-rows";

export type { AssetPickRequest, ComponentPropertyContext, ComponentPropertyUpdate } from "./component-property-row-helpers";

function uiControlComponentRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return uiControlPropertyRows(actorId, component, update, context, (key, label, types) => assetRow(actorId, component, key, label, types, update, context, `Pick ${label}`));
}

function overlayLayoutComponentRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return overlayLayoutPropertyRows(actorId, component, update, context.sceneLayerClasses);
}

function focusTargetComponentRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return focusPropertyRows(actorId, component, update, context.focusTargets);
}

function genericComponentRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  return genericRows(actorId, component, update, new Set());
}

/** Engine components with their own Details rows, by class id. Any other class gets generic rows. */
const COMPONENT_ROW_BUILDERS = {
  SaveGameComponent: saveGamePropertyRows,
  MovementComponent: movementPropertyRows,
  PhysicsConstraintComponent: physicsConstraintPropertyRows,
  DeformerComponent: deformerPropertyRows,

  MeshComponent: meshPropertyRows,
  DynamicRuntimeMeshComponent: dynamicRuntimeMeshPropertyRows,
  CableComponent: cableComponentPropertyRows,

  SpriteComponent: spritePropertyRows,
  TilemapComponent: tilemapPropertyRows,
  AnimationGraphComponent: animationGraphPropertyRows,
  BehaviourTreeComponent: behaviourTreePropertyRows,
  AudioComponent: audioPropertyRows,
  ParticleComponent: particlePropertyRows,
  SceneStreamingComponent: sceneStreamingPropertyRows,

  RigidBodyComponent: rigidBodyPropertyRows,
  ColliderComponent: colliderPropertyRows,
  RagdollComponent: ragdollPropertyRows,

  NavMeshComponent: navMeshPropertyRows,
  NavAgentComponent: navAgentPropertyRows,
  NavMeshBlockerComponent: navMeshBlockerPropertyRows,

  LightComponent: lightPropertyRows,
  HemisphericFillLightComponent: hemisphericFillLightPropertyRows,
  AreaRectLightComponent: areaRectLightPropertyRows,

  CameraComponent: cameraPropertyRows,
  SpringArmComponent: springArmPropertyRows,
  RenderTargetCaptureComponent: renderTargetCapturePropertyRows,

  SkyboxComponent: skyboxPropertyRows,
  OutlineComponent: outlinePropertyRows,
  FogVolumeComponent: fogVolumePropertyRows,
  MirrorComponent: mirrorPropertyRows,
  ReflectionProbeComponent: reflectionProbePropertyRows,

  SplineComponent: splinePropertyRows,
  LandscapeComponent: landscapePropertyRows,
  FoliageComponent: foliagePropertyRows,
  WaterRemovalVolumeComponent: waterRemovalPropertyRows,
  WaterBuoyancyComponent: waterBuoyancyPropertyRows,

  Text3DComponent: text3DPropertyRows,
  "2DTextComponent": text2DPropertyRows,
  "2DRichTextComponent": text2DPropertyRows,

  "2DAnchorComponent": anchor2DPropertyRows,
  "2DPainterComponent": painterPropertyRows,
  "2DJoystickComponent": joystick2DPropertyRows,
  "2DFocusTargetComponent": focusTargetComponentRows,
  "2DButtonComponent": visual2DPropertyRows,
  "2DTextureComponent": visual2DPropertyRows,
  "2DMaterialComponent": visual2DPropertyRows,
  "2DPanelComponent": panel2DPropertyRows,
} satisfies Partial<Record<EngineComponentClassId, ComponentRowBuilder>>;

/** A Map, not property access, so a project class named toString or constructor still gets generic rows. */
const BUILDERS: ReadonlyMap<string, ComponentRowBuilder> = new Map(Object.entries(COMPONENT_ROW_BUILDERS));

/** UI controls, overlay layouts and water bodies match by family before any exact class id. */
function builderFor(classId: string): ComponentRowBuilder {
  if (isUIControl2DClass(classId)) return uiControlComponentRows;
  if (isOverlayLayoutClass(classId)) return overlayLayoutComponentRows;
  if (waterKindForClass(classId)) return waterBodyPropertyRows;
  return BUILDERS.get(classId) ?? genericComponentRows;
}

/** Typed Details rows for a serialized component (asset picks, physics flatten). */
export function componentPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return builderFor(component.classId)(actorId, component, update, context);
}

/** Engine GameInstance plus project Class assets in that lineage. */
export function gameInstanceClassEntries(
  assets: ReadonlyArray<{
    path?: string;
    header: { type: string; name: string; parentClass?: string | null };
  }>,
): ClassPickerEntry[] {
  const parentOf = classParentLookup(assets);
  const entries: ClassPickerEntry[] = [
    { id: "GameInstance", name: "Game Instance", group: "Engine" },
  ];
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    if (id === "GameInstance") continue;
    const ancestry = walkAncestry(id, parentOf);
    if (!ancestry.includes("GameInstance")) continue;
    entries.push({ id, name: id, group: "Project", ancestry });
  }
  return entries;
}

/**
 * Engine plus project Class assets assignable to a classRef constraint;
 * `creatableOnly` keeps the plain Object classes Create Object accepts.
 */
export function subclassClassEntries(
  baseClassId: string,
  assets: ReadonlyArray<{
    path?: string;
    header: {
      type: string;
      name: string;
      parentClass?: string | null;
      guid?: string;
    };
  }>,
  options?: { editorGraph?: boolean; creatableOnly?: boolean },
): ClassPickerEntry[] {
  const parentOf = classParentLookup(assets);
  const entries: ClassPickerEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, group: string) => {
    if (seen.has(id)) return;
    // Hidden engine bases (Subsystem) stay known but are never offered.
    if (isHiddenEngineBaseClassId(id)) return;
    const ancestry = walkAncestry(id, parentOf);
    if (!ancestry.includes(baseClassId)) return;
    if (options?.editorGraph !== true && isEditorGraphClass(id, parentOf)) {
      return;
    }
    if (options?.creatableOnly && !isCreatableObjectChain(ancestry)) return;
    seen.add(id);
    entries.push({ id, name, group, ancestry });
  };
  add(baseClassId, baseClassId, "Engine");
  for (const id of ENGINE_BASE_CLASS_IDS) add(id, id, "Engine");
  for (const id of ENGINE_COMPONENT_CLASS_IDS) add(id, id, "Engine");
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    add(id, id, "Project");
  }
  return entries;
}

/** Point Details Reset at the Class prefab value for a sourced instance row. */
export function applyPrefabPropertyDefaults(
  rows: PropertyRow[],
  prefab: SerializedComponent | undefined,
): PropertyRow[] {
  if (!prefab) return rows;
  // Save Game rows end in user variable names, not property keys.
  if (prefab.classId === "SaveGameComponent") return rows;
  return rows.map((row) => {
    if (prefab.classId === "DeformerComponent" && row.kind === "vector3") {
      const index = /-offset-(\d+)$/.exec(row.id)?.[1];
      if (index !== undefined) {
        const offsets = parseDeformerProperties(prefab.properties).offsets;
        const first = Number(index) * 3;
        return { ...row, defaultValue: [offsets[first] ?? 0, offsets[first + 1] ?? 0, offsets[first + 2] ?? 0] as [number, number, number] };
      }
    }
    for (const key of Object.keys(prefab.properties)) {
      if (!row.id.endsWith(`-${key}`)) continue;
      if (prefab.classId === "PhysicsConstraintComponent" && row.kind === "vector3") {
        const value = prefab.properties[key] as { x: number; y: number; z: number; w?: number };
        if (key === "frameA" || key === "frameB") {
          const angles = quaternionToEulerDegrees([value.x, value.y, value.z, value.w ?? 1]);
          return { ...row, defaultValue: (row.axes?.length === 1 ? [angles[2], 0, 0] : angles) as [number, number, number] };
        }
        return { ...row, defaultValue: [value.x, value.y, value.z] as [number, number, number] };
      }
      if ((prefab.classId === "PhysicsConstraintComponent" || prefab.classId === "CableComponent") && row.kind === "asset" && key === "targetActorId") {
        return { ...row, defaultValue: String(prefab.properties[key] ?? "") || null };
      }
      if (prefab.classId === "CableComponent" && row.kind === "enum" && key === "targetComponentId") {
        return { ...row, defaultValue: String(prefab.properties[key] ?? "") };
      }
      if (
        key === "materialGuid" && prefab.classId === "MeshComponent" &&
        prefab.properties.assetGuid && !guidValue(prefab.properties.materialGuid) &&
        prefab.properties.materialSource !== "override"
      ) {
        return { ...row, defaultValue: MODEL_MATERIALS_PICKER_VALUE } as PropertyRow;
      }
      return { ...row, defaultValue: prefab.properties[key] } as PropertyRow;
    }
    return row;
  });
}
