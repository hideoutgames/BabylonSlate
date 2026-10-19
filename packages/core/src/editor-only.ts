import { normalizeClassMemberCategory } from "./class-member-category";
import { normalizeMaterialInstanceOverrides, type MaterialInstanceOverrides } from "./material-parameter-value";
import type { SerializedComponent } from "./scene";
import { declaredValueUnit } from "./value-units";

/** Editor-only assets stripped from Play compile and game export (P12 / P14). */

export function isEditorOnlyAssetType(type: string): boolean {
  return (
    type === "EditorUtilityInterface" ||
    type === "PluginSettings" ||
    type === "SkyboxCreator"
  );
}

function ancestryIncludes(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
  ancestorId: string,
): boolean {
  let current = classId ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentOf(current) ?? null;
  }
  return false;
}

export function isEditorUtilityObjectClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "EditorUtilityObject");
}

export function isEditorFunctionLibraryClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "EditorFunctionLibrary");
}

export function isFunctionLibraryClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "FunctionLibrary");
}

export function isEditorGraphClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return (
    isEditorUtilityObjectClass(classId, parentOf) ||
    isEditorFunctionLibraryClass(classId, parentOf)
  );
}

export function isEditorGraphHost(options: {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  assetType?: string | null;
  editorGraph?: boolean;
}): boolean {
  if (options.editorGraph === true) return true;
  const parentOf = options.parentOf ?? (() => null);
  return isEditorGraphClass(options.parentClass, parentOf);
}

export function isEditorOnlyAsset(
  header: { type: string; parentClass?: string | null },
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (isEditorOnlyAssetType(header.type)) return true;
  if (header.type !== "Class") return false;
  return isEditorGraphClass(header.parentClass, parentOf);
}

export type ClassHeaderPin = {
  name: string;
  typeId?: string;
  direction?: "in" | "out";
  typeClassId?: string;
  unit?: string;
};

export type ClassHeaderFunction = {
  id: string;
  name: string;
  pins: ClassHeaderPin[];
  overridable?: boolean;
  implementsInterface?: { assetGuid: string; methodName: string };
  overrides?: { classId: string; name: string };
  category?: string;
};

export type ClassHeaderVariable = {
  id: string;
  name: string;
  typeId?: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  category?: string;
  loading?: "hard";
  unit?: string;
};

export type ClassHeaderEvent = {
  id: string;
  name: string;
  pins: ClassHeaderPin[];
};

/**
 * A Class component as its header keeps it. A closed Class syncs its placed
 * instances from these rows alone, so a row holds every component field sync
 * copies onto an instance.
 */
export type ClassHeaderComponent = {
  id: string;
  classId: string;
  name?: string;
  parentId?: string | null;
  properties?: Record<string, unknown>;
  transform?: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
  materialInstance?: MaterialInstanceOverrides;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The header row for one Class component, from a Class document's component or
 * a stored row alike, or null when it lacks an id or class. Every writer and
 * reader of header rows goes through here, so a field cannot reach one side
 * only. `category` stays out: it belongs to the Class tree, and sync never
 * copies it onto an instance.
 */
export function classHeaderComponentRow(value: unknown): ClassHeaderComponent | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const classId = typeof value.classId === "string" ? value.classId.trim() : "";
  if (!id || !classId) return null;
  const row: ClassHeaderComponent = { id, classId };
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (name) row.name = name;
  if (value.parentId === null || typeof value.parentId === "string") row.parentId = value.parentId;
  if (isPlainObject(value.properties)) row.properties = { ...value.properties };
  if (isPlainObject(value.transform)) row.transform = value.transform as ClassHeaderComponent["transform"];
  const materialInstance = normalizeMaterialInstanceOverrides(value.materialInstance);
  if (materialInstance) row.materialInstance = materialInstance;
  return row;
}

/** The Class graph component a header row stands for. */
export function classGraphComponentFromHeaderRow(row: ClassHeaderComponent): SerializedComponent {
  return {
    id: row.id,
    classId: row.classId,
    ...(row.name ? { name: row.name } : {}),
    properties: row.properties ? { ...row.properties } : {},
    parentId: row.parentId ?? null,
    ...(row.transform ? { transform: row.transform } : {}),
    ...(row.materialInstance ? { materialInstance: row.materialInstance } : {}),
  };
}

export type ClassHeaderInterface = {
  id: string;
  name: string;
  assetGuid?: string;
};

export type ClassHeaderMeta = {
  functions: ClassHeaderFunction[];
  variables: ClassHeaderVariable[];
  events: ClassHeaderEvent[];
  interfaces: ClassHeaderInterface[];
  components: ClassHeaderComponent[];
};

function headerPinsFromMember(
  pins: ClassHeaderPin[] | undefined,
): ClassHeaderPin[] {
  return (pins ?? []).map((pin) => {
    const next: ClassHeaderPin = {
      name: pin.name,
      typeId: pin.typeId,
      direction: pin.direction,
    };
    if (pin.typeClassId) next.typeClassId = pin.typeClassId;
    const unit = declaredValueUnit(pin.typeId, pin.unit);
    if (unit) next.unit = unit;
    return next;
  });
}

export function classHeaderMeta(graph: {
  members?: Array<{
    id?: string;
    kind: string;
    name: string;
    typeId?: string;
    typeClassId?: string;
    container?: "single" | "array" | "map";
    keyTypeId?: string;
    keyTypeClassId?: string;
    functionId?: string;
    pins?: ClassHeaderPin[];
    assetGuid?: string;
    overridable?: boolean;
    implementsInterface?: { assetGuid: string; methodName: string };
    overrides?: { classId: string; name: string };
    category?: string;
    loading?: "hard";
    unit?: string;
  }>;
  components?: Array<Partial<ClassHeaderComponent>>;
}): ClassHeaderMeta {
  const functions: ClassHeaderFunction[] = [];
  const variables: ClassHeaderVariable[] = [];
  const events: ClassHeaderEvent[] = [];
  const interfaces: ClassHeaderInterface[] = [];
  for (const member of graph.members ?? []) {
    if (!member.id || !member.name) continue;
    if (member.kind === "function") {
      const fn: ClassHeaderFunction = {
        id: member.id,
        name: member.name,
        pins: headerPinsFromMember(member.pins),
      };
      if (member.overridable === true) fn.overridable = true;
      if (member.implementsInterface?.assetGuid && member.implementsInterface.methodName) {
        fn.implementsInterface = {
          assetGuid: member.implementsInterface.assetGuid,
          methodName: member.implementsInterface.methodName,
        };
      }
      if (member.overrides?.classId && member.overrides.name) {
        fn.overrides = {
          classId: member.overrides.classId,
          name: member.overrides.name,
        };
      }
      const fnCategory = normalizeClassMemberCategory(member.category);
      if (fnCategory) fn.category = fnCategory;
      functions.push(fn);
      continue;
    }
    if (member.kind === "variable") {
      if (member.functionId) continue;
      const variable: ClassHeaderVariable = {
        id: member.id,
        name: member.name,
        typeId: member.typeId,
      };
      if (member.typeClassId) variable.typeClassId = member.typeClassId;
      if (member.container && member.container !== "single") {
        variable.container = member.container;
      }
      if (member.keyTypeId) variable.keyTypeId = member.keyTypeId;
      if (member.keyTypeClassId) variable.keyTypeClassId = member.keyTypeClassId;
      const variableCategory = normalizeClassMemberCategory(member.category);
      if (variableCategory) variable.category = variableCategory;
      if (member.loading === "hard") variable.loading = "hard";
      const unit = declaredValueUnit(member.typeId, member.unit);
      if (unit) variable.unit = unit;
      variables.push(variable);
      continue;
    }
    if (member.kind === "event") {
      events.push({
        id: member.id,
        name: member.name,
        pins: headerPinsFromMember(member.pins),
      });
      continue;
    }
    if (member.kind === "interface") {
      const iface: ClassHeaderInterface = {
        id: member.id,
        name: member.name,
      };
      if (member.assetGuid) iface.assetGuid = member.assetGuid;
      interfaces.push(iface);
    }
  }
  const components: ClassHeaderComponent[] = [];
  for (const component of graph.components ?? []) {
    const row = classHeaderComponentRow(component);
    if (row) components.push(row);
  }
  return { functions, variables, events, interfaces, components };
}
