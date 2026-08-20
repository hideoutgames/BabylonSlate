import { Mesh, type Scene } from "@babylonjs/core";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";
import { DEFAULT_DESIRED_SIZE } from "@babylonslate/ui-runtime";
import {
  applyAdtIdeal,
  BabylonUiApplyHost,
  createAdtControlFactory,
  type BabylonUiHostOptions,
} from "./babylon-ui-host";

export type WidgetPlaneOptions = {
  width?: number;
  height?: number;
  twoSided?: boolean;
};

export type WidgetBitmapSize = { width: number; height: number };

export function widgetPlaneWorldSize(
  size: { width?: number; height?: number },
  bitmap: WidgetBitmapSize,
): { width: number; height: number } {
  const aspect =
    bitmap.width > 0 && bitmap.height > 0 ? bitmap.width / bitmap.height : 1;
  const hasWidth =
    typeof size.width === "number" && Number.isFinite(size.width) && size.width > 0;
  const hasHeight =
    typeof size.height === "number" &&
    Number.isFinite(size.height) &&
    size.height > 0;
  if (hasWidth && hasHeight) {
    return { width: size.width!, height: size.height! };
  }
  if (hasWidth) {
    return { width: size.width!, height: size.width! / aspect };
  }
  if (hasHeight) {
    return { width: size.height! * aspect, height: size.height! };
  }
  return { width: 1, height: 1 / aspect };
}

export function resolveWidgetBitmapSize(
  document: Pick<UserInterfaceDocument, "desiredSize" | "designResolution">,
): WidgetBitmapSize {
  const desired = document.desiredSize;
  if (
    desired &&
    desired.width > 0 &&
    desired.height > 0
  ) {
    return {
      width: Math.max(1, desired.width),
      height: Math.max(1, desired.height),
    };
  }
  const design = document.designResolution;
  if (design && design.width > 0 && design.height > 0) {
    return {
      width: Math.max(1, design.width),
      height: Math.max(1, design.height),
    };
  }
  return { ...DEFAULT_DESIRED_SIZE };
}

export function createWidgetPlane(
  scene: Scene,
  name: string,
  options: WidgetPlaneOptions = {},
): Mesh {
  const width =
    typeof options.width === "number" && options.width > 0 ? options.width : 1;
  const height =
    typeof options.height === "number" && options.height > 0 ? options.height : 1;
  const sideOrientation = options.twoSided ? Mesh.DOUBLESIDE : Mesh.FRONTSIDE;
  const mesh = CreatePlane(
    name,
    {
      width,
      height,
      sideOrientation,
    },
    scene,
  );
  mesh.sideOrientation = sideOrientation;
  return mesh;
}

export type MeshGuiOptions = BabylonUiHostOptions & {
  name: string;
  twoSided?: boolean;
  bitmap: WidgetBitmapSize;
};

export function attachMeshGui(
  mesh: Mesh,
  options: MeshGuiOptions,
): {
  adt: AdvancedDynamicTexture;
  host: BabylonUiApplyHost;
  setAllowGuiHits: (allow: boolean) => void;
  dispose: () => void;
} {
  const bitmapWidth = Math.max(1, Math.round(options.bitmap.width));
  const bitmapHeight = Math.max(1, Math.round(options.bitmap.height));
  const supportPointerMove = options.interactive !== false;
  const adt = AdvancedDynamicTexture.CreateForMesh(
    mesh,
    bitmapWidth,
    bitmapHeight,
    supportPointerMove,
  );
  applyAdtIdeal(adt, { width: bitmapWidth, height: bitmapHeight }, "shortestSide");
  if (mesh.material) {
    mesh.material.backFaceCulling = options.twoSided !== true;
  }
  const scene = mesh.getScene();
  const factory = createAdtControlFactory(adt, {
    resolveImageUrl: options.resolveImageUrl,
    resolveInterfaceMaterial: options.resolveInterfaceMaterial,
    materialFunctions: options.materialFunctions,
    resolveTexture: options.resolveTexture,
    materialLibrary: options.materialLibrary,
    scene,
    onTouchAxis: options.onTouchAxis,
    onImageReady: () => adt.markAsDirty(),
  });
  const host = new BabylonUiApplyHost(factory, {
    interactive: options.interactive,
    allowGuiHits: options.allowGuiHits,
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    onWidgetEvent: options.onWidgetEvent,
    markDirty: () => adt.markAsDirty(),
  });
  const setAllowGuiHits = (allow: boolean) => {
    host.setAllowGuiHits(allow);
    adt.disablePicking = !allow;
  };
  if (options.allowGuiHits === false) adt.disablePicking = true;
  return {
    adt,
    host,
    setAllowGuiHits,
    dispose: () => {
      host.clear();
      adt.dispose();
    },
  };
}

export function createWidgetVisualMesh(
  scene: Scene,
  name: string,
  properties: {
    uiAssetGuid: string | null;
    twoSided: boolean;
    width: number;
    height: number;
  },
  bitmap: WidgetBitmapSize = { width: 400, height: 300 },
): Mesh {
  const world = widgetPlaneWorldSize(properties, bitmap);
  const mesh = createWidgetPlane(scene, name, {
    width: world.width,
    height: world.height,
    twoSided: properties.twoSided,
  });
  mesh.metadata = {
    ...(mesh.metadata ?? {}),
    widget: true,
    widgetTwoSided: properties.twoSided,
  };
  return mesh;
}
