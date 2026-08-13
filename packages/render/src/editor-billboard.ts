import {
  Color3,
  Mesh,
  MeshBuilder,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { SerializedActor } from "@babylonslate/core";

export const EDITOR_BILLBOARD_ICONS = ["light", "camera", "audio"] as const;
export type EditorBillboardIcon = (typeof EDITOR_BILLBOARD_ICONS)[number];

const BILLBOARD_KIND_PREFIX = "billboard:";
const ICON_SIZE = 32;
const BILLBOARD_SIZE = 0.5;
const DEFAULT_FILL = new Color3(1, 1, 1);

const texturesByScene = new WeakMap<Scene, Map<EditorBillboardIcon, RawTexture>>();

export function editorBillboardKind(icon: EditorBillboardIcon): string {
  return `${BILLBOARD_KIND_PREFIX}${icon}`;
}

export function parseEditorBillboardIcon(
  kind: string | null | undefined,
): EditorBillboardIcon | null {
  if (!kind?.startsWith(BILLBOARD_KIND_PREFIX)) return null;
  const icon = kind.slice(BILLBOARD_KIND_PREFIX.length);
  if (icon === "light" || icon === "camera" || icon === "audio") return icon;
  return null;
}

/** Camera-facing unlit icon quad for location-only editor helpers. */
export function createEditorBillboard(
  scene: Scene,
  name: string,
  icon: EditorBillboardIcon,
): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { size: BILLBOARD_SIZE }, scene);
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = true;
  mesh.metadata = { ...(mesh.metadata ?? {}), editorBillboard: icon };

  const material = new StandardMaterial(`${name}-billboard`, scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = DEFAULT_FILL.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  const texture = iconTexture(scene, icon);
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
  if (icon !== "light" && icon !== "camera" && icon !== "audio") return;
  const material = mesh.material;
  if (!(material instanceof StandardMaterial)) return;
  if (icon !== "light") {
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

function iconTexture(scene: Scene, icon: EditorBillboardIcon): RawTexture {
  let byIcon = texturesByScene.get(scene);
  if (!byIcon) {
    byIcon = new Map();
    texturesByScene.set(scene, byIcon);
  }
  const existing = byIcon.get(icon);
  if (existing) return existing;
  const texture = RawTexture.CreateRGBATexture(
    rasterizeIcon(icon),
    ICON_SIZE,
    ICON_SIZE,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.hasAlpha = true;
  byIcon.set(icon, texture);
  return texture;
}

function rasterizeIcon(icon: EditorBillboardIcon): Uint8Array {
  const data = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  if (icon === "light") drawLight(data);
  else if (icon === "camera") drawCamera(data);
  else drawAudio(data);
  return data;
}

function setPixel(data: Uint8Array, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE) return;
  const i = (y * ICON_SIZE + x) * 4;
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  data[i + 3] = 255;
}

function fillCircle(
  data: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
): void {
  const r2 = radius * radius;
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(data, x, y);
    }
  }
}

function fillRect(
  data: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      setPixel(data, x, y);
    }
  }
}

function drawLight(data: Uint8Array): void {
  fillCircle(data, 16, 13, 8);
  fillRect(data, 14, 20, 18, 24);
  fillRect(data, 12, 24, 20, 26);
  fillRect(data, 13, 27, 19, 28);
  fillRect(data, 14, 29, 18, 30);
}

function drawCamera(data: Uint8Array): void {
  fillRect(data, 6, 12, 26, 24);
  fillRect(data, 18, 8, 24, 12);
  fillCircle(data, 16, 18, 5);
}

function drawAudio(data: Uint8Array): void {
  fillRect(data, 6, 12, 14, 20);
  for (let y = 8; y < 24; y++) {
    const t = Math.abs(y + 0.5 - 16) / 8;
    const width = Math.round(8 * (1 - t));
    for (let x = 14; x < 14 + width; x++) setPixel(data, x, y);
  }
  strokeArc(data, 16, 16, 10, 11);
  strokeArc(data, 16, 16, 13, 14);
}

function strokeArc(
  data: Uint8Array,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
): void {
  const inner2 = inner * inner;
  const outer2 = outer * outer;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = cx; x < ICON_SIZE; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= inner2 && d2 <= outer2) setPixel(data, x, y);
    }
  }
}
