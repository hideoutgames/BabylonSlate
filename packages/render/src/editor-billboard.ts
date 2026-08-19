import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  type AbstractEngine,
} from "@babylonjs/core";
import type { SerializedActor } from "@babylonslate/core";
import { engineBillboardUrl } from "./default-billboard/urls";
import { createEngineTextureFromUrl } from "./resource-cache";

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
const DEFAULT_FILL = new Color3(1, 1, 1);
const LIGHT_ICONS = new Set<EditorBillboardIcon>([
  "point_light",
  "spot_light",
  "directional_light",
]);

const texturesByEngine = new WeakMap<
  AbstractEngine,
  Map<EditorBillboardIcon, Texture>
>();

const ICON_ALIASES: Record<string, EditorBillboardIcon> = {
  light: "point_light",
  rigidbody: "default",
  particles: "particle",
};

export function editorBillboardKind(icon: EditorBillboardIcon): string {
  return `${BILLBOARD_KIND_PREFIX}${icon}`;
}

export function resolveEditorBillboardIcon(
  icon: string | null | undefined,
): EditorBillboardIcon {
  if (!icon) return "default";
  if (EDITOR_BILLBOARD_ICONS.includes(icon as EditorBillboardIcon)) {
    return icon as EditorBillboardIcon;
  }
  return ICON_ALIASES[icon] ?? "default";
}

export function parseEditorBillboardIcon(
  kind: string | null | undefined,
): EditorBillboardIcon | null {
  if (!kind?.startsWith(BILLBOARD_KIND_PREFIX)) return null;
  const icon = kind.slice(BILLBOARD_KIND_PREFIX.length);
  if (EDITOR_BILLBOARD_ICONS.includes(icon as EditorBillboardIcon)) {
    return icon as EditorBillboardIcon;
  }
  if (icon in ICON_ALIASES) return ICON_ALIASES[icon]!;
  return null;
}

export function lightBillboardIcon(
  lightKind: unknown,
): EditorBillboardIcon {
  if (lightKind === "spot") return "spot_light";
  if (lightKind === "directional") return "directional_light";
  return "point_light";
}

/** Camera-facing unlit icon quad for location-only editor helpers. */
export function createEditorBillboard(
  scene: Scene,
  name: string,
  icon: EditorBillboardIcon | string,
): Mesh {
  const resolved = resolveEditorBillboardIcon(icon);
  const mesh = MeshBuilder.CreatePlane(
    name,
    { size: BILLBOARD_SIZE, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.ignoreParentScaling = true;
  mesh.isPickable = true;
  mesh.metadata = { ...(mesh.metadata ?? {}), editorBillboard: resolved };

  const material = new StandardMaterial(`${name}-billboard`, scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = DEFAULT_FILL.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  const texture = iconTexture(scene, resolved);
  material.emissiveTexture = texture;
  material.opacityTexture = texture;
  mesh.material = material;
  return mesh;
}

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
  const color = lightColorOf(actor) ?? [1, 1, 1];
  material.emissiveColor.set(color[0], color[1], color[2]);
}

function lightColorOf(
  actor: SerializedActor,
): [number, number, number] | null {
  const component = actor.components.find(
    (entry) => entry.classId === "LightComponent",
  );
  const value = component?.properties.color;
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b] = value;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") {
    return null;
  }
  return [r, g, b];
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
