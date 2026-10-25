import { Mesh } from "@babylonjs/core";
import type { EngineHandle } from "./create-engine-types";
import type { SnapshotSceneBinding } from "./snapshot-apply";

export type PlayHandleInspection = Pick<
  EngineHandle,
  "playVisualStates" | "playMeshMaterialNames" | "playText2DLayouts" | "playMeshMaterialDefines"
>;

/** Read-only e2e readouts of the meshes `binding` holds for Play slots. */
export function createPlayHandleInspection(binding: SnapshotSceneBinding): PlayHandleInspection {
  return {
  playVisualStates: () => {
    const states: Array<{
      slotId: number;
      name: string;
      visible: boolean;
      position: [number, number, number];
      worldMatrixPosition: [number, number, number];
      materialName: string | null;
    }> = [];
    for (const [slotId, root] of binding.meshes) {
      const componentVisuals = root
        .getChildMeshes()
        .filter(
          (mesh): mesh is Mesh =>
            mesh instanceof Mesh &&
            mesh.name.startsWith(`actor-${slotId}|`) &&
            !mesh.name.slice(mesh.name.indexOf("|") + 1).includes(":"),
        );
      const visuals = componentVisuals.length > 0 ? componentVisuals : [root];
      for (const visual of visuals) {
        visual.computeWorldMatrix(true);
        const position = visual.getAbsolutePosition();
        const worldMatrixPosition = visual.getWorldMatrix().getTranslation();
        states.push({
          slotId,
          name: visual.name,
          visible: visual.isVisible && visual.isEnabled(),
          position: [position.x, position.y, position.z],
          worldMatrixPosition: [
            worldMatrixPosition.x,
            worldMatrixPosition.y,
            worldMatrixPosition.z,
          ],
          materialName: visual.material?.name ?? null,
        });
      }
    }
    return states.sort(
      (a, b) => a.slotId - b.slotId || a.name.localeCompare(b.name),
    );
  },
  playMeshMaterialNames: () => {
    const names = new Set<string>();
    for (const root of binding.meshes.values()) {
      const meshes = [root, ...root.getChildMeshes()];
      for (const mesh of meshes) {
        const name = mesh.material?.name;
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  },
  playText2DLayouts: () => {
    const rows: Array<{ slotId: number; name: string; fontStack: string; width: number }> = [];
    for (const [slotId, root] of binding.meshes) {
      for (const mesh of [root, ...root.getChildMeshes()]) {
        const metadata = mesh.metadata as { text2d?: boolean; text2dFontStack?: string; text2dLayoutWidth?: number } | null;
        if (metadata?.text2d !== true) continue;
        rows.push({ slotId, name: mesh.name, fontStack: metadata.text2dFontStack ?? "", width: metadata.text2dLayoutWidth ?? 0 });
      }
    }
    return rows.sort((a, b) => a.slotId - b.slotId || a.name.localeCompare(b.name));
  },
  playMeshMaterialDefines: () => {
    const rows: Array<{
      mesh: string;
      material: string | null;
      defines: string;
    }> = [];
    for (const root of binding.meshes.values()) {
      for (const mesh of [root, ...root.getChildMeshes()]) {
        const defines =
          mesh.subMeshes
            ?.map((sub) => String(sub.effect?.defines ?? ""))
            .filter((entry) => entry.length)
            .join("\n") ?? "";
        if (mesh.material || defines)
          rows.push({
            mesh: mesh.name,
            material: mesh.material?.name ?? null,
            defines,
          });
      }
    }
    return rows;
  },
  };
}
