import { Color4, InputBlock, NodeMaterialBlockConnectionPointTypes, type AbstractMesh, type Material, type Mesh, type SubMesh } from "@babylonjs/core";
import type { MaterialParameterValue } from "@haptic/core";
import { drawingMesh } from "./instance-source";

/**
 * Material parameters marked Per Instance: the compiler reads each from an instanced attribute instead of a uniform
 * (`createInstanceParameterBlock`), so every mesh, and every instance of a group's source, draws its own value and
 * meshes that differ only in it still draw in one batch. A Material registers the attribute on each mesh it draws,
 * holding the Material's value (`prepareInstanceParameters`), so a mesh with no value of its own draws that one.
 */

export interface InstanceParameter {
  readonly name: string;
  /** The instanced buffer kind, also the shader attribute's name. */
  readonly attribute: string;
  readonly kind: "float" | "color";
}

interface MaterialInstanceParameters {
  readonly parameters: ReadonlyMap<string, InstanceParameter>;
  /** Each parameter's Material value, as the buffer holds it (a color in linear space). */
  readonly values: Map<string, number | Color4>;
  /** The meshes holding the Material's value because they have none of their own. */
  readonly meshes: Set<AbstractMesh>;
}

const materials = new WeakMap<Material, MaterialInstanceParameters>();

/** The attribute of a Material's `index`th per-instance parameter: letters only, as Babylon strips digits from names. */
export function instanceParameterAttribute(index: number): string {
  let letters = "";
  for (let rest = index; ; rest = Math.floor(rest / 26) - 1) {
    letters = String.fromCharCode(97 + (rest % 26)) + letters;
    if (rest < 26) break;
  }
  return `instanceParameter_${letters}`;
}

/** The block a per-instance Float or Color parameter compiles to: an instanced attribute, never a uniform. */
export function createInstanceParameterBlock(attribute: string, kind: "float" | "color"): InputBlock {
  const block = new InputBlock(attribute, undefined, kind === "float"
    ? NodeMaterialBlockConnectionPointTypes.Float : NodeMaterialBlockConnectionPointTypes.Color4);
  block.setAsAttribute(attribute);
  return block;
}

/** The buffer form of an authored value: a Color in linear space, as a Color uniform converts it. */
function bufferValue(value: MaterialParameterValue): number | Color4 | null {
  if (value.kind === "float") return value.value;
  if (value.kind === "color") return new Color4(...value.value).toLinearSpace();
  return null;
}

/** The authored form of a buffer value. */
function authoredValue(value: number | Color4): MaterialParameterValue {
  if (typeof value === "number") return { kind: "float", value };
  const gamma = value.toGammaSpace();
  return { kind: "color", value: [gamma.r, gamma.g, gamma.b, value.a] };
}

/**
 * Records `material`'s per-instance parameters with their authored values, and has the Material prepare each mesh it
 * is asked about (`isReadyForSubMesh`) before its first draw, when the attribute's presence can still change its Effect.
 */
export function attachInstanceParameters(material: Material, parameters: ReadonlyArray<InstanceParameter & { value: MaterialParameterValue }>): void {
  if (!parameters.length) return;
  const values = new Map<string, number | Color4>();
  for (const parameter of parameters) values.set(parameter.name, bufferValue(parameter.value) ?? 0);
  materials.set(material, { parameters: new Map(parameters.map(({ name, attribute, kind }) => [name, { name, attribute, kind }])), values, meshes: new Set() });
  const isReadyForSubMesh = material.isReadyForSubMesh.bind(material);
  material.isReadyForSubMesh = (mesh: AbstractMesh, subMesh: SubMesh, useInstances?: boolean) => {
    prepareInstanceParameters(mesh, material);
    return isReadyForSubMesh(mesh, subMesh, useInstances);
  };
}

/** `material`'s per-instance parameter `name`, if it has one. */
export function instanceParameterOf(material: Material, name: string): InstanceParameter | undefined {
  return materials.get(material)?.parameters.get(name);
}

/** Whether `material` has per-instance parameters. */
export function hasInstanceParameters(material: Material): boolean {
  return materials.has(material);
}

/** `material`'s value of its per-instance parameter `name`, in authored form. */
export function instanceParameterValue(material: Material, name: string): MaterialParameterValue | null {
  const value = materials.get(material)?.values.get(name);
  return value === undefined ? null : authoredValue(value);
}

/**
 * Registers `material`'s per-instance attributes on the mesh that draws `mesh` (an instance's source), holding the
 * Material's values; an instance with no value yet takes the same. Unchanged registrations are left alone.
 */
export function prepareInstanceParameters(mesh: AbstractMesh, material: Material): void {
  const record = materials.get(material);
  if (!record) return;
  const drawing = drawingMesh(mesh) as Mesh;
  if (typeof drawing.registerInstancedBuffer !== "function") return;
  for (const parameter of record.parameters.values()) {
    if (drawing.instancedBuffers?.[parameter.attribute] !== undefined && drawing.instancedBuffers[parameter.attribute] !== null) continue;
    const value = record.values.get(parameter.name)!;
    drawing.registerInstancedBuffer(parameter.attribute, parameter.kind === "float" ? 1 : 4);
    drawing.instancedBuffers[parameter.attribute] = typeof value === "number" ? value : value.clone();
    for (const instance of drawing.instances)
      instance.instancedBuffers[parameter.attribute] ??= typeof value === "number" ? value : value.clone();
    record.meshes.add(drawing);
    drawing.onDisposeObservable.addOnce(() => record.meshes.delete(drawing));
  }
}

/**
 * Sets `material`'s value of its per-instance parameter `name` (a Material Instance asset, a script's or the
 * editor's write to the Material): each mesh the Material prepared, and its instances, draw it. Returns false for a
 * parameter that is not per-instance.
 */
export function setInstanceParameterValue(material: Material, name: string, value: MaterialParameterValue): boolean {
  const record = materials.get(material);
  const parameter = record?.parameters.get(name);
  const next = parameter && parameter.kind === value.kind ? bufferValue(value) : null;
  if (!record || !parameter || next === null) return false;
  const previous = record.values.get(name);
  record.values.set(name, next);
  const same = (a: unknown, b: unknown) => a === b || (a instanceof Color4 && b instanceof Color4 && a.equals(b));
  for (const mesh of record.meshes) {
    if (mesh.isDisposed() || mesh.material !== material) continue;
    for (const holder of [mesh, ...(mesh as Mesh).instances ?? []]) {
      const current = holder.instancedBuffers?.[parameter.attribute];
      if (current === undefined || same(current, previous))
        holder.instancedBuffers[parameter.attribute] = typeof next === "number" ? next : next.clone();
    }
  }
  return true;
}
