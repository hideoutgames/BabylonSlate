import { PuzzleIcon } from "lucide-react";
import { extensionAssetType, isExtensionAssetType } from "@haptic/core";
import {
  extensionSectionFields, resolveExtensionFieldValues,
  type ExtensionDescriptor, type ExtensionField, type ExtensionFieldValues, type ExtensionSettingsSection,
} from "@haptic/assets";
import { resolveTypeVisual, type TypeVisual } from "@haptic/editor-kit";
import { resolvePluginIcon } from "./plugin-icons";

/** An asset type an enabled extension declares, as New Asset, the Content Browser and its editor use it. */
export interface ExtensionAssetTypeDescriptor {
  /** Header type: `extension.<extensionGuid>.<id>`. */
  type: string;
  extensionGuid: string;
  extensionName: string;
  /** Manifest id, which game code filters assets by. */
  id: string;
  title: string;
  /** New Asset category: the declared one, else the extension's display name. */
  category: string;
  description?: string;
  /** The type's icon, else the extension's. */
  iconKey: string | null;
  editorOnly: boolean;
  sections: ExtensionSettingsSection[];
  fields: ExtensionField[];
}

/** Asset types of the enabled, valid packages of a resolved order, in that order. */
export function extensionAssetTypes(order: readonly ExtensionDescriptor[]): ExtensionAssetTypeDescriptor[] {
  return order.flatMap((entry) => entry.invalid ? [] : (entry.settings.contributes.assetTypes ?? []).map((declared) => ({
    type: extensionAssetType(entry.extensionGuid, declared.id),
    extensionGuid: entry.extensionGuid,
    extensionName: entry.settings.displayName,
    id: declared.id,
    title: declared.title,
    category: declared.category ?? entry.settings.displayName,
    ...(declared.description ? { description: declared.description } : {}),
    iconKey: declared.iconKey ?? entry.settings.iconKey,
    editorOnly: declared.editorOnly,
    sections: declared.sections,
    fields: extensionSectionFields(declared.sections),
  })));
}

/** Gameplay asset types reach games through the game library, which an Editor Only package does not have. */
export function extensionAssetTypeDiagnostics(order: readonly ExtensionDescriptor[]): string[] {
  return order.filter((entry) => !entry.invalid && entry.settings.editorOnly
    && entry.settings.contributes.assetTypes?.some((declared) => !declared.editorOnly))
    .map((entry) => `${entry.settings.displayName}: its gameplay asset types reach games only while Editor Only is off.`);
}

export function findExtensionAssetType(types: readonly ExtensionAssetTypeDescriptor[], type: string): ExtensionAssetTypeDescriptor | undefined {
  return isExtensionAssetType(type) ? types.find((entry) => entry.type === type) : undefined;
}

/** The payload a new asset of the type starts with: every field's default. */
export function newExtensionAssetPayload(type: ExtensionAssetTypeDescriptor): ExtensionFieldValues {
  return resolveExtensionFieldValues(type.fields);
}

/** The Content Browser and tab visual of an extension asset; without its type (extension off) a plain one. */
export function extensionAssetTypeVisual(type: ExtensionAssetTypeDescriptor | undefined): TypeVisual {
  const icon = resolvePluginIcon(type?.iconKey);
  return { ...resolveTypeVisual({ family: "struct" }), icon: icon ?? PuzzleIcon, iconKey: icon ? type!.iconKey! : "Puzzle" };
}
