import {
  isFunctionLibraryClass,
  type GraphClassMember,
  type GraphClassMemberKind,
} from "@haptic/core";
import { engineParentOf } from "@haptic/editor-kit";
import { defaultValueForMember } from "@haptic/scripting";
import { nextCopyName } from "@haptic/assets";
import type { ClassEventOptions } from "./class-event-catalog";

export type ClassBlueprintMemberKind = GraphClassMemberKind;

export type BlueprintSection = {
  id: string;
  label: string;
  kind: ClassBlueprintMemberKind;
  local?: boolean;
};

const CLASS_BLUEPRINT_SECTIONS: BlueprintSection[] = [
  { id: "functions", label: "Functions", kind: "function" },
  { id: "variables", label: "Variables", kind: "variable" },
  { id: "events", label: "Events", kind: "event" },
  { id: "dispatchers", label: "Event Dispatchers", kind: "dispatcher" },
  { id: "interfaces", label: "Interfaces", kind: "interface" },
];

const FUNCTION_LIBRARY_SECTIONS: BlueprintSection[] = [
  { id: "functions", label: "Functions", kind: "function" },
];

const LOCAL_VARIABLES_SECTION: BlueprintSection = {
  id: "local-variables",
  label: "Local Variables",
  kind: "variable",
  local: true,
};

function parentLookup(
  options?: ClassEventOptions,
): (id: string) => string | null | undefined {
  return options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
}

function isFunctionLibraryHost(options?: ClassEventOptions): boolean {
  return isFunctionLibraryClass(options?.parentClass, parentLookup(options));
}

/** Function libraries have no Event Graph; show Empty until a function is selected. */
export function functionLibraryShowsEventGraphEmpty(
  options?: ClassEventOptions & { activeFunctionId?: string | null },
): boolean {
  if (options?.activeFunctionId) return false;
  return isFunctionLibraryHost(options);
}

/**
 * Scene and Scene Layer scripts bind to other objects' Event Dispatchers but
 * declare none: nothing can hold a reference to them to bind to theirs.
 */
function isEmbeddedSceneScriptHost(options?: ClassEventOptions): boolean {
  const parent = options?.parentClass;
  return parent === "Scene" || parent === "SceneLayer";
}

export function blueprintSectionsForClass(
  options?: ClassEventOptions & { activeFunctionId?: string | null },
): BlueprintSection[] {
  const sections = isFunctionLibraryHost(options)
    ? [...FUNCTION_LIBRARY_SECTIONS]
    : CLASS_BLUEPRINT_SECTIONS.filter(
        (section) => section.kind !== "dispatcher" || !isEmbeddedSceneScriptHost(options),
      );
  if (options?.activeFunctionId) {
    if (isFunctionLibraryHost(options)) {
      sections.push(LOCAL_VARIABLES_SECTION);
    } else {
      const variableIndex = sections.findIndex(
        (section) => section.id === "variables",
      );
      sections.splice(variableIndex + 1, 0, LOCAL_VARIABLES_SECTION);
    }
  }
  return sections;
}

export function classAllowsMemberKind(
  kind: ClassBlueprintMemberKind,
  options?: ClassEventOptions & { local?: boolean },
): boolean {
  if (kind === "dispatcher" && isEmbeddedSceneScriptHost(options)) return false;
  if (!isFunctionLibraryHost(options)) return true;
  if (kind === "function") return true;
  if (kind === "variable" && options?.local) return true;
  return false;
}

/** Starting names for members created before the user renames them inline. */
export const NEW_MEMBER_NAMES = {
  variable: "NewVariable",
  function: "NewFunction",
  event: "NewEvent",
  dispatcher: "NewEventDispatcher",
} as const;

/** `NewVariable`, then `NewVariable_1`, … skipping names already used by the same kind. */
export function nextNewMemberName(
  kind: keyof typeof NEW_MEMBER_NAMES,
  existingNames: readonly string[],
): string {
  return nextCopyName(NEW_MEMBER_NAMES[kind], [...existingNames]);
}

/** Variable type fields for an Add Variable type-menu pick (`tagContainer` is a struct alias). */
export function variableFieldsForPickerType(
  pickerType: string,
): Pick<GraphClassMember, "typeId" | "typeClassId" | "defaultValue" | "signature"> {
  // A Delegate starts with No Inputs and, like an Object, has no default.
  if (pickerType === "delegate") return { typeId: "delegate", signature: [] };
  if (pickerType === "tagContainer") {
    return {
      typeId: "struct",
      typeClassId: "engine:TagContainer",
      defaultValue: defaultValueForMember("struct", "engine:TagContainer"),
    };
  }
  const typeClassId =
    pickerType === "object" || pickerType === "class" ? "Object" : undefined;
  const defaultValue =
    pickerType === "object" || pickerType === "wildcard" ||
    pickerType === "struct" || pickerType === "enum"
      ? undefined
      : pickerType === "class"
        ? "Object"
        : defaultValueForMember(pickerType, typeClassId);
  return {
    typeId: pickerType,
    ...(typeClassId ? { typeClassId } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}
