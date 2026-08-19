import {
  SKYBOX_FACE_KEYS,
  emptySkyboxFaces,
  parseSkyboxFaces,
  type SkyboxFaceKey,
  type SkyboxFaces,
} from "@babylonslate/core";
import type { ImportResult } from "./importers/types";
import { nextCopyName, stripAssetFileSuffix } from "./unique-names";

export const SKYBOX_CREATOR_NET_COLS = 4;
export const SKYBOX_CREATOR_NET_ROWS = 3;
export const SKYBOX_CREATOR_NET_ASPECT =
  SKYBOX_CREATOR_NET_COLS / SKYBOX_CREATOR_NET_ROWS;

export const SKYBOX_CREATOR_COMPASS_FACES = [
  "up",
  "left",
  "front",
  "right",
  "back",
  "down",
] as const;

export type SkyboxCreatorCompassFace =
  (typeof SKYBOX_CREATOR_COMPASS_FACES)[number];

export const SKYBOX_CREATOR_NET_CELLS: Record<
  SkyboxCreatorCompassFace,
  { col: number; row: number }
> = {
  up: { col: 1, row: 0 },
  left: { col: 0, row: 1 },
  front: { col: 1, row: 1 },
  right: { col: 2, row: 1 },
  back: { col: 3, row: 1 },
  down: { col: 1, row: 2 },
};

export const SKYBOX_CREATOR_COMPASS_TO_BABYLON: Record<
  SkyboxCreatorCompassFace,
  SkyboxFaceKey
> = {
  front: "pz",
  back: "nz",
  right: "px",
  left: "nx",
  up: "py",
  down: "ny",
};

export type SkyboxCreatorSourcePlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SkyboxCreatorSourcePlacementHandle =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw"
  | "move";

export type SkyboxCreatorPayload = {
  sourceTextureGuid: string | null;
  sourcePlacement: SkyboxCreatorSourcePlacement | null;
  generatedFaces: SkyboxFaces;
};

export type SkyboxNetFaceRgba = {
  key: SkyboxFaceKey;
  compass: SkyboxCreatorCompassFace;
  size: number;
  rgba: Uint8Array;
};

export type FitSourceIntoSkyboxNetResult = {
  faceSize: number;
  netWidth: number;
  netHeight: number;
  dest: { x: number; y: number; width: number; height: number };
  faces: Record<SkyboxFaceKey, SkyboxNetFaceRgba>;
};

const LETTERBOX: readonly [number, number, number, number] = [0, 0, 0, 255];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseSkyboxCreatorSourcePlacement(
  value: unknown,
): SkyboxCreatorSourcePlacement | null {
  const source = asRecord(value);
  const x = finiteNumber(source.x);
  const y = finiteNumber(source.y);
  const width = finiteNumber(source.width);
  const height = finiteNumber(source.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return {
    x,
    y,
    width: Math.max(0.001, width),
    height: Math.max(0.001, height),
  };
}

export function defaultSkyboxCreatorSourcePlacement(
  sourceWidth: number,
  sourceHeight: number,
): SkyboxCreatorSourcePlacement {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const sourceAspect = width / height;
  if (sourceAspect > SKYBOX_CREATOR_NET_ASPECT) {
    const placedHeight = SKYBOX_CREATOR_NET_ASPECT / sourceAspect;
    return {
      x: 0,
      y: (1 - placedHeight) / 2,
      width: 1,
      height: placedHeight,
    };
  }
  const placedWidth = sourceAspect / SKYBOX_CREATOR_NET_ASPECT;
  return {
    x: (1 - placedWidth) / 2,
    y: 0,
    width: placedWidth,
    height: 1,
  };
}

export function letterboxSize(
  hostWidth: number,
  hostHeight: number,
  aspect = SKYBOX_CREATOR_NET_ASPECT,
): { width: number; height: number; x: number; y: number } {
  const width = Math.max(0, hostWidth);
  const height = Math.max(0, hostHeight);
  if (width === 0 || height === 0 || aspect <= 0) {
    return { width: 0, height: 0, x: 0, y: 0 };
  }
  if (width / height > aspect) {
    const fittedWidth = height * aspect;
    return {
      width: fittedWidth,
      height,
      x: (width - fittedWidth) / 2,
      y: 0,
    };
  }
  const fittedHeight = width / aspect;
  return {
    width,
    height: fittedHeight,
    x: 0,
    y: (height - fittedHeight) / 2,
  };
}

export function resizeSkyboxCreatorSourcePlacement(
  start: SkyboxCreatorSourcePlacement,
  handle: SkyboxCreatorSourcePlacementHandle,
  pointer: { x: number; y: number },
  origin: { x: number; y: number },
): SkyboxCreatorSourcePlacement {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (handle === "move") {
    return {
      x: start.x + (pointer.x - origin.x),
      y: start.y + (pointer.y - origin.y),
      width: Math.max(0.001, start.width),
      height: Math.max(0.001, start.height),
    };
  }
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;
  if (handle.includes("e")) {
    width = Math.max(0.001, pointer.x - start.x);
  }
  if (handle.includes("w")) {
    x = Math.min(pointer.x, right - 0.001);
    width = right - x;
  }
  if (handle.includes("s")) {
    height = Math.max(0.001, pointer.y - start.y);
  }
  if (handle.includes("n")) {
    y = Math.min(pointer.y, bottom - 0.001);
    height = bottom - y;
  }
  return parseSkyboxCreatorSourcePlacement({ x, y, width, height }) ?? start;
}

export function createDefaultSkyboxCreatorPayload(): SkyboxCreatorPayload {
  return {
    sourceTextureGuid: null,
    sourcePlacement: null,
    generatedFaces: emptySkyboxFaces(),
  };
}

export function normalizeSkyboxCreatorPayload(
  payload: unknown,
): SkyboxCreatorPayload {
  const source = asRecord(payload);
  return {
    sourceTextureGuid: nullableGuid(source.sourceTextureGuid),
    sourcePlacement: parseSkyboxCreatorSourcePlacement(source.sourcePlacement),
    generatedFaces: parseSkyboxFaces(source.generatedFaces),
  };
}

export function skyboxCreatorAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType !== "SkyboxCreator") return [];
  const helper = normalizeSkyboxCreatorPayload(payload);
  const unique = new Set<string>();
  if (helper.sourceTextureGuid) unique.add(helper.sourceTextureGuid);
  for (const key of SKYBOX_FACE_KEYS) {
    const guid = helper.generatedFaces[key];
    if (guid) unique.add(guid);
  }
  return [...unique].sort();
}

export function skyboxCreatorFaceRelativePath(
  helperPath: string,
  face: SkyboxFaceKey,
): string {
  const slash = helperPath.lastIndexOf("/");
  const dir = slash >= 0 ? helperPath.slice(0, slash + 1) : "";
  const file = slash >= 0 ? helperPath.slice(slash + 1) : helperPath;
  const stem = file
    .replace(/\.skyboxcreator\.babasset$/i, "")
    .replace(/\.babasset$/i, "");
  return `${dir}${stem}_${face}.babasset`;
}

export type SkyboxCreatorFaceWrite = {
  key: SkyboxFaceKey;
  path: string;
  guid: string;
  replace: boolean;
};

function pathStem(path: string): string {
  const file = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return stripAssetFileSuffix(file);
}

function joinFolder(dir: string, fileName: string): string {
  return dir ? `${dir}/${fileName}` : fileName;
}

export function planSkyboxCreatorFaceWrites(options: {
  helperPath: string;
  generatedFaces: SkyboxFaces;
  existingByGuid: ReadonlyMap<string, { path: string }>;
  occupiedPaths: ReadonlySet<string>;
  newGuid: () => string;
}): SkyboxCreatorFaceWrite[] {
  const occupied = new Set(options.occupiedPaths);
  const stems = [...occupied].map(pathStem);
  const writes: SkyboxCreatorFaceWrite[] = [];
  for (const key of SKYBOX_FACE_KEYS) {
    const previous = options.generatedFaces[key];
    const existing = previous ? options.existingByGuid.get(previous) : undefined;
    if (previous && existing) {
      writes.push({
        key,
        path: existing.path,
        guid: previous,
        replace: true,
      });
      continue;
    }
    const preferred = skyboxCreatorFaceRelativePath(options.helperPath, key);
    const slash = preferred.lastIndexOf("/");
    const dir = slash >= 0 ? preferred.slice(0, slash) : "";
    const preferredStem = pathStem(preferred);
    const stem = occupied.has(preferred)
      ? nextCopyName(preferredStem, stems)
      : preferredStem;
    const path = joinFolder(dir, `${stem}.babasset`);
    occupied.add(path);
    stems.push(stem);
    writes.push({
      key,
      path,
      guid: options.newGuid(),
      replace: false,
    });
  }
  return writes;
}

export function createSkyboxFaceTextureResult(options: {
  name: string;
  guid: string;
  pngBytes: Uint8Array;
}): ImportResult {
  return {
    type: "Texture",
    name: options.name,
    guid: options.guid,
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: { usage: "skybox" },
    chunks: [
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        data: options.pngBytes,
      },
    ],
  };
}

function copyPixel(
  dest: Uint8Array,
  destIndex: number,
  source: Uint8Array,
  sourceIndex: number,
): void {
  dest[destIndex] = source[sourceIndex]!;
  dest[destIndex + 1] = source[sourceIndex + 1]!;
  dest[destIndex + 2] = source[sourceIndex + 2]!;
  dest[destIndex + 3] = source[sourceIndex + 3]!;
}

function fillPixel(
  dest: Uint8Array,
  destIndex: number,
  color: readonly [number, number, number, number],
): void {
  dest[destIndex] = color[0];
  dest[destIndex + 1] = color[1];
  dest[destIndex + 2] = color[2];
  dest[destIndex + 3] = color[3];
}

export function skyboxCreatorFaceSize(
  sourceWidth: number,
  sourceHeight: number,
): number {
  const width = Math.max(1, Math.floor(sourceWidth));
  const height = Math.max(1, Math.floor(sourceHeight));
  return Math.max(
    1,
    Math.floor(
      Math.min(width / SKYBOX_CREATOR_NET_COLS, height / SKYBOX_CREATOR_NET_ROWS),
    ),
  );
}

export function fitSourceIntoSkyboxNet(
  rgba: Uint8Array,
  width: number,
  height: number,
  placement?: SkyboxCreatorSourcePlacement | null,
): FitSourceIntoSkyboxNetResult {
  const sourceWidth = Math.max(1, Math.floor(width));
  const sourceHeight = Math.max(1, Math.floor(height));
  const faceSize = skyboxCreatorFaceSize(sourceWidth, sourceHeight);
  const netWidth = SKYBOX_CREATOR_NET_COLS * faceSize;
  const netHeight = SKYBOX_CREATOR_NET_ROWS * faceSize;
  const destPlacement =
    parseSkyboxCreatorSourcePlacement(placement) ??
    defaultSkyboxCreatorSourcePlacement(sourceWidth, sourceHeight);
  const destWidth = destPlacement.width * netWidth;
  const destHeight = destPlacement.height * netHeight;
  const destX = destPlacement.x * netWidth;
  const destY = destPlacement.y * netHeight;
  const scaleX = destWidth / sourceWidth;
  const scaleY = destHeight / sourceHeight;
  const net = new Uint8Array(netWidth * netHeight * 4);

  for (let ny = 0; ny < netHeight; ny++) {
    for (let nx = 0; nx < netWidth; nx++) {
      const destIndex = (ny * netWidth + nx) * 4;
      const inside =
        nx >= destX &&
        nx < destX + destWidth &&
        ny >= destY &&
        ny < destY + destHeight;
      if (!inside || scaleX <= 0 || scaleY <= 0) {
        fillPixel(net, destIndex, LETTERBOX);
        continue;
      }
      const sx = Math.floor((nx - destX) / scaleX);
      const sy = Math.floor((ny - destY) / scaleY);
      if (sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight) {
        fillPixel(net, destIndex, LETTERBOX);
        continue;
      }
      copyPixel(net, destIndex, rgba, (sy * sourceWidth + sx) * 4);
    }
  }

  const faces = emptySkyboxFaces() as unknown as Record<
    SkyboxFaceKey,
    SkyboxNetFaceRgba
  >;
  for (const compass of SKYBOX_CREATOR_COMPASS_FACES) {
    const cell = SKYBOX_CREATOR_NET_CELLS[compass];
    const key = SKYBOX_CREATOR_COMPASS_TO_BABYLON[compass];
    const face = new Uint8Array(faceSize * faceSize * 4);
    const originX = cell.col * faceSize;
    const originY = cell.row * faceSize;
    for (let y = 0; y < faceSize; y++) {
      for (let x = 0; x < faceSize; x++) {
        copyPixel(
          face,
          (y * faceSize + x) * 4,
          net,
          ((originY + y) * netWidth + (originX + x)) * 4,
        );
      }
    }
    faces[key] = { key, compass, size: faceSize, rgba: face };
  }

  return {
    faceSize,
    netWidth,
    netHeight,
    dest: { x: destX, y: destY, width: destWidth, height: destHeight },
    faces,
  };
}
