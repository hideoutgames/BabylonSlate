import { sceneShadowController } from "./shadow-controller";
import { isForwardLightExcluded } from "./light-policy";
import { AUTHORED_LIGHT_PREFIX } from "./scene-illumination";
import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  type AbstractEngine,
  type Light,
} from "@babylonjs/core";
import type { SerializedActor } from "@haptic/core";
import { engineBillboardUrl } from "./default-billboard/urls";
import { shareHelperProgram } from "./helper-program";
import { createEngineTextureFromUrl } from "./resource-cache";
import { RENDERING_GROUP } from "./sorting";

export const EDITOR_BILLBOARD_ICONS = [
  "default",
  "point_light",
  "spot_light",
  "directional_light",
  "camera",
  "audio",
  "particle",
  "navmesh",
] as const;
export type EditorBillboardIcon = (typeof EDITOR_BILLBOARD_ICONS)[number];

const BILLBOARD_KIND_PREFIX = "billboard:";
const BILLBOARD_SIZE = 0.5;
/** Later than the editor grid so helper icons are not sorted behind the plane. */
export const EDITOR_BILLBOARD_ALPHA_INDEX = 1000;
const DEFAULT_FILL = new Color3(1, 1, 1);
const LIMITED_FILL = new Color3(1, 1, 0);
const DISABLED_FILL = new Color3(1, 0, 0);
const LIGHT_ICONS = new Set<EditorBillboardIcon>([
  "point_light",
  "spot_light",
  "directional_light",
]);

const texturesByEngine = new WeakMap<
  AbstractEngine,
  Map<EditorBillboardIcon, Texture>
>();

export function editorBillboardKind(icon: EditorBillboardIcon): string {
  return `${BILLBOARD_KIND_PREFIX}${icon}`;
}

function isEditorBillboardIcon(icon: string | null | undefined): icon is EditorBillboardIcon {
  return EDITOR_BILLBOARD_ICONS.includes(icon as EditorBillboardIcon);
}

export function resolveEditorBillboardIcon(
  icon: string | null | undefined,
): EditorBillboardIcon {
  return isEditorBillboardIcon(icon) ? icon : "default";
}

export function parseEditorBillboardIcon(
  kind: string | null | undefined,
): EditorBillboardIcon | null {
  if (!kind?.startsWith(BILLBOARD_KIND_PREFIX)) return null;
  const icon = kind.slice(BILLBOARD_KIND_PREFIX.length);
  return isEditorBillboardIcon(icon) ? icon : null;
}

export function lightBillboardIcon(
  lightKind: unknown,
): EditorBillboardIcon {
  if (lightKind === "spot") return "spot_light";
  if (lightKind === "directional") return "directional_light";
  return "point_light";
}

export function isEditorBillboardMesh(mesh: Mesh): boolean {
  return typeof (mesh.metadata as { editorBillboard?: unknown } | null)
    ?.editorBillboard === "string";
}

export function applyEditorBillboardPass(mesh: {
  renderingGroupId: number;
  alphaIndex: number;
}): void {
  mesh.renderingGroupId = RENDERING_GROUP.foreground;
  mesh.alphaIndex = EDITOR_BILLBOARD_ALPHA_INDEX;
}

/**
 * Invert the origin's local scale so a PNG child stays square. Babylon 9 has
 * no `ignoreParentScaling`; volume / actor scale still hits the sibling mesh.
 */
export function syncEditorBillboardParentScale(mesh: Mesh): void {
  const parent = mesh.parent;
  if (!(parent instanceof TransformNode)) {
    if (mesh.scaling.x !== 1 || mesh.scaling.y !== 1 || mesh.scaling.z !== 1) {
      mesh.scaling.set(1, 1, 1);
    }
    return;
  }
  const sx = parent.scaling.x === 0 ? 1 : 1 / parent.scaling.x;
  const sy = parent.scaling.y === 0 ? 1 : 1 / parent.scaling.y;
  const sz = parent.scaling.z === 0 ? 1 : 1 / parent.scaling.z;
  if (mesh.scaling.x === sx && mesh.scaling.y === sy && mesh.scaling.z === sz) {
    return;
  }
  mesh.scaling.set(sx, sy, sz);
}

/** Camera-facing unlit icon quad for location-only editor helpers. */
export function createEditorBillboard(
  scene: Scene,
  name: string,
  icon: EditorBillboardIcon,
): Mesh {
  const mesh = MeshBuilder.CreatePlane(
    name,
    { size: BILLBOARD_SIZE, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = true;
  mesh.metadata = { ...(mesh.metadata ?? {}), editorBillboard: icon };
  applyEditorBillboardPass(mesh);
  mesh.onBeforeRenderObservable.add(() => {
    syncEditorBillboardParentScale(mesh);
  });

  const material = shareHelperProgram(new StandardMaterial(`${name}-billboard`, scene));
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = DEFAULT_FILL.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  const texture = iconTexture(scene, icon);
  // The icon multiplies the unlit tint; emissiveTexture would add white to it.
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  mesh.material = material;
  return mesh;
}

const billboardUpdaters = new WeakMap<Mesh, () => void>();

export function applyEditorBillboardFromActor(
  mesh: Mesh,
  actor: SerializedActor,
): void {
  const icon = (mesh.metadata as { editorBillboard?: string } | null)
    ?.editorBillboard;
  if (!icon) return;
  const resolved = resolveEditorBillboardIcon(icon);
  const material = mesh.material;
  if (!(material instanceof StandardMaterial)) return;
  if (!LIGHT_ICONS.has(resolved)) {
    material.emissiveColor.copyFrom(DEFAULT_FILL);
    return;
  }
  // The actor snapshot is fixed per registration; only its properties are re-read.
  const component = actor.components.find((entry) =>
    entry.classId === "LightComponent" || entry.classId === "HemisphericFillLightComponent" || entry.classId === "AreaRectLightComponent");
  const lightName = component?.classId === "AreaRectLightComponent" ? `authoredAreaLight:${actor.id}:${component.id}` : `${AUTHORED_LIGHT_PREFIX}${actor.id}`;
  const scene = mesh.getScene();
  let light: Light | null = null;
  // scene.lights.length at the last failed lookup, or -1 to look up. A miss holds
  // until a light is added or removed; Babylon defers its add notification, so a
  // changed count is the synchronous backstop.
  let missedAt = -1;
  const update = () => {
    if (
      light
        ? light.isDisposed() || light.name !== lightName
        : missedAt !== scene.lights.length
    ) {
      light = scene.getLightByName(lightName);
      missedAt = light ? -1 : scene.lights.length;
    }
    const illuminationLimited = light && isForwardLightExcluded(light);
    const disabled = light ? (!light.isEnabled() && !illuminationLimited) || light.intensity <= 0
      : component?.properties.enabled === false ||
        (typeof component?.properties.intensity === "number" && component.properties.intensity <= 0);
    const shadowsMissing = light && component?.classId === "LightComponent" &&
      component.properties.castShadows === true &&
      !sceneShadowController(scene).generator(light);
    const fill = disabled ? DISABLED_FILL : illuminationLimited || shadowsMissing ? LIMITED_FILL : DEFAULT_FILL;
    if (!material.emissiveColor.equals(fill)) material.emissiveColor.copyFrom(fill);
    const status = disabled
      ? "Disabled: This Light Is Disabled Or Does Not Illuminate."
      : illuminationLimited
        ? "Limited: Requested Illumination Exceeds This Device's Forward Light Capacity."
      : shadowsMissing
        ? "Limited: Requested Shadows Are Unavailable."
        : "Active: This Light Is Operating As Configured.";
    if (mesh.metadata.editorBillboardStatus !== status) mesh.metadata.editorBillboardStatus = status;
  };
  const hasUpdater = billboardUpdaters.has(mesh);
  billboardUpdaters.get(mesh)?.();
  const observer = scene.onBeforeRenderObservable.add(update);
  const lightRemoved = scene.onLightRemovedObservable.add((removed) => {
    if (removed === light) light = null;
    missedAt = -1;
  });
  const lightAdded = scene.onNewLightAddedObservable.add(() => {
    missedAt = -1;
  });
  billboardUpdaters.set(mesh, () => {
    scene.onBeforeRenderObservable.remove(observer);
    scene.onLightRemovedObservable.remove(lightRemoved);
    scene.onNewLightAddedObservable.remove(lightAdded);
  });
  if (!hasUpdater) mesh.onDisposeObservable.addOnce(() => {
    billboardUpdaters.get(mesh)?.();
    billboardUpdaters.delete(mesh);
  });
  update();
}

function iconTexture(scene: Scene, icon: EditorBillboardIcon): Texture {
  const engine = scene.getEngine();
  let byIcon = texturesByEngine.get(engine);
  if (!byIcon) {
    byIcon = new Map();
    texturesByEngine.set(engine, byIcon);
  }
  const existing = byIcon.get(icon);
  if (existing) return existing;
  const file =
    icon === "particle" ? "particles" : icon;
  const texture = createEngineTextureFromUrl(
    engine,
    engineBillboardUrl(file),
  );
  byIcon.set(icon, texture);
  return texture;
}
