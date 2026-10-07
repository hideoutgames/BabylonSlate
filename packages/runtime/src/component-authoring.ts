import { OVERLAY_CONTAINER_CLASSES, parseOverlayContainerProperties, isUIControl2DClass, parseUIControl2DProperties } from "@babylonslate/core";
import { normalizeWaterBody, normalizeWaterBuoyancy, normalizeWaterRemoval, waterKindForClass } from "@babylonslate/core";
import { isOverlayLayoutClass, parseOverlayLayoutProperties } from "@babylonslate/core";
import type {
  PhysicsWorldKind,
  ViewportMode,
} from "@babylonslate/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  emptySkyboxFaces,
  parseText3DProperties,
  parsePainter2DProperties,
  parseJoystick2DProperties,
  parseAreaRectLightProperties,
  parseFogVolumeProperties,
  parseOutlineProperties,
  parseDeformerProperties,
  parseRagdollProperties,
  parseMovementProperties,
  parseSpringArmProperties,
  parseCableProperties,
  parseSplineProperties,
  createRichText2DComponent,
  createText2DComponent,
  createDefaultRenderTargetCaptureProperties,
} from "@babylonslate/core";
import {
  parseColliderProperties,
  parseConstraintProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import {
  DEFAULT_NAV_AGENT_PARAMS,
  defaultNavMeshBlockerComponentProperties,
  defaultNavMeshComponentProperties,
} from "@babylonslate/navigation";
import { normalizeSceneStreamingProperties, parseLandscapeProperties, parseFoliageProperties } from "@babylonslate/core";

/** Canonical authorable fields shared by scene editing and final-state capture. */
export function defaultComponentAuthoringProperties(
  classId: string,
  physicsWorld: PhysicsWorldKind = "3d",
  viewportMode: ViewportMode = "3d",
): Record<string, unknown> {
  if (isUIControl2DClass(classId)) return { ...parseUIControl2DProperties(classId, {}) };
  if (isOverlayLayoutClass(classId)) return { ...parseOverlayLayoutProperties({}, classId), ...((OVERLAY_CONTAINER_CLASSES as readonly string[]).includes(classId) ? parseOverlayContainerProperties({}) : {}) };
  const waterKind = waterKindForClass(classId);
  if (waterKind) return { ...normalizeWaterBody({}, waterKind) };
  if (classId === "WaterBuoyancyComponent") return { ...normalizeWaterBuoyancy({}), mass: 1 };
  if (classId === "WaterRemovalVolumeComponent") return { ...normalizeWaterRemoval({}) };
  switch (classId) {
    case "SceneStreamingComponent":
      return { ...normalizeSceneStreamingProperties({}) };
    case "LandscapeComponent":
      return { ...parseLandscapeProperties({}) };
    case "FoliageComponent":
      return { ...parseFoliageProperties({}) };
    case "SaveGameComponent":
      return { saveTransform: true, persistDestruction: true, actorVariables: [], componentVariables: {} };
    case "MovementComponent":
      return { ...parseMovementProperties({}) };
    case "DynamicRuntimeMeshComponent":
      return { materialGuid: null, enableCollision: false, castShadows: true, receiveShadows: true, layer: 1, mask: 0xffffffff };
    case "MeshComponent":
      return {
        meshKind: "box",
        assetGuid: null,
        collisionMode: "none",
        layer: 1,
        mask: 0xffffffff,
      };
    case "SpriteComponent":
      return { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 };
    case "TilemapComponent":
      return { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 };
    case "AnimationGraphComponent":
      return { graphGuid: null };
    case "BehaviourTreeComponent":
      return { treeGuid: null, blackboardGuid: null };
    case "NavAgentComponent":
      return { ...DEFAULT_NAV_AGENT_PARAMS };
    case "NavMeshComponent":
      return { ...defaultNavMeshComponentProperties() };
    case "NavMeshBlockerComponent":
      return { ...defaultNavMeshBlockerComponentProperties() };
    case "BlockingVolumeComponent":
      return {};
    case "CameraComponent":
      return {
        fieldOfView: DEFAULT_CAMERA_FIELD_OF_VIEW,
        orthographicSize: DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
        projectionMode: viewportMode === "2d" ? "orthographic" : "perspective",
        nearClip: 0.1,
        farClip: 1000,
        attemptPossessViewTarget: false,
      };
    case "LightComponent":
      return {
        intensity: 1,
        color: [1, 1, 1],
        lightKind: "point",
        range: 10,
        outerAngle: 45,
        innerAngle: 30,
        enabled: true,
        castShadows: false,
      };
    case "AreaRectLightComponent":
      return { ...parseAreaRectLightProperties({}) };
    case "RenderTargetCaptureComponent":
      return { ...createDefaultRenderTargetCaptureProperties() };
    case "FogVolumeComponent":
      return { ...parseFogVolumeProperties({}) };
    case "OutlineComponent":
      return { ...parseOutlineProperties({}) };
    case "DeformerComponent":
      return { ...parseDeformerProperties({}) };
    case "SpringArmComponent":
      return { ...parseSpringArmProperties({}) };
    case "CableComponent":
      return { ...parseCableProperties({}) };
    case "SplineComponent":
      return { ...parseSplineProperties({}) };
    case "HemisphericFillLightComponent":
      return {
        intensity: 0.9,
        color: [1, 1, 1],
        groundColor: [0, 0, 0],
        enabled: true,
      };
    case "SkyboxComponent":
      return { size: 1000, faces: emptySkyboxFaces() };
    case "Text3DComponent":
      return { ...parseText3DProperties({}) };
    case "AudioComponent":
      return {
        audioAssetGuid: null,
        playOnStart: true,
        loop: false,
        volume: 1,
      };
    case "ParticleComponent":
      return {
        particleSystemGuid: null,
        playOnStart: true,
        sortingLayer: "Default",
        orderInLayer: 0,
      };
    case "2DAnchorComponent":
      return { anchor: "center", offsetX: 0, offsetY: 0 };
    case "2DJoystickComponent": return { ...parseJoystick2DProperties({}) };
    case "2DPainterComponent": return { ...parsePainter2DProperties({}) };
    case "2DButtonComponent":
      return { hitTest: "block", focusEnabled: true, focusInitial: false, focusUp: null, focusDown: null, focusLeft: null, focusRight: null };
    case "2DFocusTargetComponent":
      return { focusEnabled: true, focusInitial: false, focusUp: null, focusDown: null, focusLeft: null, focusRight: null };
    case "2DMaterialComponent":
      return { materialGuid: null, hitTest: "ignore" };
    case "2DTextureComponent":
      return { textureGuid: null, hitTest: "ignore" };
    case "2DPanelComponent":
      return {
        source: "texture",
        textureGuid: null,
        materialGuid: null,
        marginLeft: 0,
        marginRight: 0,
        marginTop: 0,
        marginBottom: 0,
        hitTest: "ignore",
      };
    case "2DTextComponent":
      return { ...createText2DComponent("text").properties };
    case "2DRichTextComponent":
      return { ...createRichText2DComponent("rich").properties };
    case "RigidBodyComponent":
      return { ...parseRigidBodyProperties({}) };
    case "ColliderComponent": {
      const defaults = parseColliderProperties({}, physicsWorld);
      return { ...defaults };
    }
    case "PhysicsConstraintComponent":
      return { ...parseConstraintProperties({}, physicsWorld) };
    case "RagdollComponent":
      return { ...parseRagdollProperties({}) };
    default:
      return {};
  }
}

