import { walkAncestry } from "@haptic/editor-kit";
import {
  TICKABLE_OBJECT_INTERFACE_GUID,
  TICKABLE_OBJECT_INTERFACE_NAME,
  isCreatableObjectChain,
} from "@haptic/object-model";

export type InterfacePickerAsset = { guid: string; name: string; type: string };

/**
 * Engine Script Interfaces a class may implement, listed before the project's
 * in the interface pickers: Tickable Object, only for plain Object classes.
 */
export function engineScriptInterfaceAssets(
  parentClass: string | null | undefined,
  parentOf: (classId: string) => string | null | undefined,
): InterfacePickerAsset[] {
  if (!parentClass || !isCreatableObjectChain(walkAncestry(parentClass, parentOf))) return [];
  return [{ guid: TICKABLE_OBJECT_INTERFACE_GUID, name: TICKABLE_OBJECT_INTERFACE_NAME, type: "ScriptInterface" }];
}
