import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

/**
 * Whether a Scene Layer 2D component (2D Material, 2D Panel, 2D Joystick, the 2D controls) may draw `material`: only
 * a User Interface Material, as a 2D Text draws only a Text Material. The compiler sets the domain at creation, so a
 * Material whose build is pending already answers. Any other Material leaves the component's fallback look.
 */
export function acceptsUserInterfaceMaterial(material: Material | null | undefined): material is Material {
  return (material?.metadata as { materialDomain?: unknown } | null | undefined)?.materialDomain === "ui";
}

/** The look a 2D component's surface draws with when it draws no User Interface Material (`applyOverlayUnlitMaterial`). */
const fallbacks = new WeakMap<AbstractMesh, () => void>();

export function setUserInterfaceFallback(mesh: AbstractMesh, restore: () => void): void {
  fallbacks.set(mesh, restore);
}

/** Draws `mesh` with its fallback look again; false for a mesh that has none. */
export function restoreUserInterfaceFallback(mesh: AbstractMesh): boolean {
  const restore = fallbacks.get(mesh);
  restore?.();
  return restore !== undefined;
}
