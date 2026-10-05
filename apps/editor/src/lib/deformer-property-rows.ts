import { parseDeformerProperties, type SerializedComponent } from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";
import type { ComponentPropertyContext } from "./component-property-rows";

/** Bounded control cage editing through the shared Scene/Class PropertyGrid. */
export function deformerPropertyRows(actorId: string, component: SerializedComponent,
  update: (property: string, value: unknown) => void, context: ComponentPropertyContext): PropertyRow[] {
  const properties = parseDeformerProperties(component.properties);
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const meshes = (context.actorComponents?.(actorId) ?? []).filter((candidate) => candidate.classId === "MeshComponent");
  const target = meshes.find((mesh) => mesh.id === properties.targetMeshComponentId)
    ?? meshes.find((mesh) => mesh.sourceId === properties.targetMeshComponentId);
  const options = [{ value: "", label: "None" }, ...meshes.map((mesh) => ({ value: mesh.id, label: `Mesh (${mesh.id})` }))];
  if (properties.targetMeshComponentId && !target) options.push({ value: properties.targetMeshComponentId, label: "Missing Mesh" });
  return [
    { kind: "boolean", id: id("enabled"), label: "Enabled", value: properties.enabled, defaultValue: false,
      description: "Deform the target after animation and material World Position Offset. Visual only; collision and picking keep the original geometry.", onChange: (value) => update("enabled", value) },
    { kind: "enum", id: id("targetMeshComponentId"), label: "Target Mesh", value: target?.id ?? properties.targetMeshComponentId,
      defaultValue: "", options, description: "Choose a Mesh Component on this actor. Only the first enabled Deformer for each mesh is used.", onChange: (value) => update("targetMeshComponentId", value) },
    { kind: "slider", id: id("strength"), label: "Strength", value: properties.strength, defaultValue: 1, min: 0, max: 1, step: 0.01,
      onChange: (value) => update("strength", value) },
    { kind: "vector3", id: id("resolution"), label: "Resolution", value: properties.resolution, defaultValue: [2, 2, 2],
      sensitivity: 1,
      description: "2–4 control points per axis, up to 64 total. Changing resolution resets control offsets.", onChange: (value) => update("resolution", value.slice(0, 3)) },
    { kind: "boolean", id: id("fitToMesh"), label: "Fit To Mesh", value: properties.fitToMesh, defaultValue: true,
      description: "Fit the cage to the target's undeformed bounds. Disable to author a target-local cage.", onChange: (value) => update("fitToMesh", value) },
    ...(!properties.fitToMesh ? (["boundsMin", "boundsMax"] as const).map((key): PropertyRow => ({
      kind: "vector3", id: id(key), label: key === "boundsMin" ? "Bounds Min" : "Bounds Max", value: properties[key],
      defaultValue: key === "boundsMin" ? [-0.5, -0.5, -0.5] : [0.5, 0.5, 0.5],
      description: "Target-local cage bounds. Max must be greater than Min on every axis.", onChange: (value) => update(key, value.slice(0, 3)),
    })) : []),
    ...Array.from({ length: properties.offsets.length / 3 }, (_, index): PropertyRow => {
      const x = index % properties.resolution[0];
      const y = Math.floor(index / properties.resolution[0]) % properties.resolution[1];
      const z = Math.floor(index / (properties.resolution[0] * properties.resolution[1]));
      return { kind: "vector3", id: id(`offset-${index}`), label: `Control ${x}, ${y}, ${z}`, defaultValue: [0, 0, 0],
        value: properties.offsets.slice(index * 3, index * 3 + 3) as [number, number, number],
        description: `Control ${index} offset in target-local units.`, onChange: (value) => {
          const offsets = [...properties.offsets];
          offsets.splice(index * 3, 3, ...value.slice(0, 3));
          update("offsets", offsets);
        } };
    }),
  ];
}
