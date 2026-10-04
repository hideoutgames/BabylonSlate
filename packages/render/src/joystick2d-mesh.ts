import { Color3, MeshBuilder, type AbstractMesh, type Mesh, type Scene, type StandardMaterial } from "@babylonjs/core";
import { parseJoystick2DProperties, type Joystick2DProperties } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";
import { createOverlayUnlitMaterial } from "./overlay-texture-quad";
import { VisualBundle } from "./visual-bundle";

export interface Joystick2DMesh {
  mesh: Mesh;
  thumb: Mesh;
  properties: Joystick2DProperties;
  fallbacks: { background: StandardMaterial; joystick: StandardMaterial };
}

const joysticks = new WeakMap<AbstractMesh, Joystick2DMesh>();
export function joystick2DMesh(mesh: AbstractMesh): Joystick2DMesh | undefined {
  return joysticks.get(mesh);
}

export function refreshJoystick2DMaterials(root: Mesh, assets?: MeshAssetContext): void {
  for (const mesh of [root, ...root.getChildMeshes()]) {
    const visual = joystick2DMesh(mesh);
    if (!visual) continue;
    const resolve = (guid: string | null, fallback: StandardMaterial) =>
      guid ? assets?.resolveMaterial?.(guid, { scene: mesh.getScene(), unlit: true }) ?? fallback : fallback;
    mesh.material = resolve(visual.properties.backgroundMaterialGuid, visual.fallbacks.background);
    visual.thumb.material = resolve(visual.properties.joystickMaterialGuid, visual.fallbacks.joystick);
  }
}

/** Native overlay geometry; authored materials are borrowed from the scene library. */
export function createJoystick2DMesh(
  scene: Scene, name: string, source: Partial<Joystick2DProperties> | Record<string, unknown> = {}, assets?: MeshAssetContext,
): Mesh {
  const properties = parseJoystick2DProperties(source);
  const bundle = new VisualBundle();
  const surface = (suffix: string, radius: number, guid: string | null, alpha: number) => {
    const mesh = guid
      ? MeshBuilder.CreatePlane(suffix, { size: radius * 2 }, scene)
      : MeshBuilder.CreateDisc(suffix, { radius, tessellation: 48 }, scene);
    bundle.ownRenderUser(mesh);
    const fallback = createOverlayUnlitMaterial(scene, suffix, bundle);
    fallback.emissiveColor = new Color3(0.75, 0.75, 0.75);
    fallback.alpha = alpha;
    mesh.material = fallback;
    return { mesh, fallback };
  };
  try {
    const background = surface(name, properties.radius, properties.backgroundMaterialGuid, 0.35);
    const joystick = surface(`${name}-joystick`, properties.joystickRadius, properties.joystickMaterialGuid, 0.85);
    const mesh = background.mesh;
    const thumb = joystick.mesh;
    thumb.parent = mesh;
    thumb.position.z = -0.01;
    thumb.alphaIndex = 1;
    thumb.isPickable = false;
    thumb.metadata = { joystick2DThumb: true };
    mesh.metadata = { overlayJoystickMeshName: name, overlayHitTest: properties.enabled ? "block" : "ignore" };
    mesh.isPickable = true;
    joysticks.set(mesh, { mesh, thumb, properties, fallbacks: { background: background.fallback, joystick: joystick.fallback } });
    refreshJoystick2DMaterials(mesh, assets);
    mesh.onDisposeObservable.addOnce(() => { joysticks.delete(mesh); bundle.dispose(); });
    return mesh;
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}
