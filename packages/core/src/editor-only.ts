/** Editor-only assets stripped from Play compile and game export (P12 / P14). */

export type EditorUtilityDockKind = "scene" | "class";

export function normalizeEditorUtilityDockKind(
  value: unknown,
): EditorUtilityDockKind {
  return value === "class" ? "class" : "scene";
}

export function isEditorOnlyAssetType(type: string): boolean {
  return type === "EditorUtilityInterface" || type === "PluginSettings";
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
  if (options.assetType === "EditorUtilityInterface") return true;
  const parentOf = options.parentOf ?? (() => null);
  return isEditorGraphClass(options.parentClass, parentOf);
}

export function isEditorOnlyAsset(
  header: { type: string; parentClass?: string | null },
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (isEditorOnlyAssetType(header.type)) return true;
  if (header.type !== "Class" && header.type !== "Graph") return false;
  return isEditorGraphClass(header.parentClass, parentOf);
}

export type FunctionLibraryHeaderFunction = {
  name: string;
  pins: Array<{
    name: string;
    typeId?: string;
    direction?: "in" | "out";
    typeClassId?: string;
  }>;
  overridable?: boolean;
};

export type ClassHeaderPin = {
  name: string;
  typeId?: string;
  direction?: "in" | "out";
  typeClassId?: string;
};

export type ClassHeaderFunction = {
  id: string;
  name: string;
  pins: ClassHeaderPin[];
  overridable?: boolean;
  implementsInterface?: { assetGuid: string; methodName: string };
  overrides?: { classId: string; name: string };
};

export type ClassHeaderVariable = {
  id: string;
  name: string;
  typeId?: string;
  typeClassId?: string;
};

export type ClassHeaderEvent = {
  id: string;
  name: string;
  pins: ClassHeaderPin[];
};

export type ClassHeaderComponent = {
  id: string;
  classId: string;
  parentId?: string | null;
  properties?: Record<string, unknown>;
  transform?: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
};

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
  pins: FunctionLibraryHeaderFunction["pins"] | undefined,
): ClassHeaderPin[] {
  return (pins ?? []).map((pin) => {
    const next: ClassHeaderPin = {
      name: pin.name,
      typeId: pin.typeId,
      direction: pin.direction,
    };
    if (pin.typeClassId) next.typeClassId = pin.typeClassId;
    return next;
  });
}

export function functionLibraryHeaderMeta(graph: {
  members?: Array<{
    kind: string;
    name: string;
    pins?: FunctionLibraryHeaderFunction["pins"];
    overridable?: boolean;
  }>;
}): { functions: FunctionLibraryHeaderFunction[] } {
  return {
    functions: (graph.members ?? [])
      .filter((member) => member.kind === "function")
      .map((member) => ({
        name: member.name,
        pins: headerPinsFromMember(member.pins),
        ...(member.overridable === true ? { overridable: true } : {}),
      })),
  };
}

export function classHeaderMeta(graph: {
  members?: Array<{
    id?: string;
    kind: string;
    name: string;
    typeId?: string;
    typeClassId?: string;
    functionId?: string;
    pins?: ClassHeaderPin[];
    assetGuid?: string;
    overridable?: boolean;
    implementsInterface?: { assetGuid: string; methodName: string };
    overrides?: { classId: string; name: string };
  }>;
  components?: Array<{
    id?: string;
    classId?: string;
    parentId?: string | null;
    properties?: Record<string, unknown>;
    transform?: ClassHeaderComponent["transform"];
  }>;
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
    const id = component.id?.trim();
    const classId = component.classId?.trim();
    if (!id || !classId) continue;
    const row: ClassHeaderComponent = { id, classId };
    if (component.parentId !== undefined) row.parentId = component.parentId;
    if (component.properties) row.properties = { ...component.properties };
    if (component.transform) row.transform = component.transform;
    components.push(row);
  }
  return { functions, variables, events, interfaces, components };
}
