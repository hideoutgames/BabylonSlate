import {
  extensionSettingsFields, resolveExtensionEnabled, resolveExtensionFieldValues,
  type ExtensionDescriptor, type ExtensionFieldValues, type ExtensionSettingsContribution,
} from "@haptic/assets";
import type { SettingSearchField } from "./settings-search";

const CATEGORY_PREFIX = "extension:";

/** Stored Project Settings values of every extension, keyed by extension guid (`project.json` `extensionSettings`). */
export type ExtensionSettingValues = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** An extension's settings values with its field types and defaults applied. */
export function resolvedExtensionSettings(entry: ExtensionDescriptor, values: ExtensionSettingValues): ExtensionFieldValues {
  return resolveExtensionFieldValues(extensionSettingsFields(entry.settings.contributes), values[entry.extensionGuid]);
}

/** Project Settings category id of an extension's settings. */
export function extensionSettingsCategoryId(extensionGuid: string): string {
  return `${CATEGORY_PREFIX}${extensionGuid}`;
}

export function isExtensionSettingsCategoryId(categoryId: string): boolean {
  return categoryId.startsWith(CATEGORY_PREFIX);
}

/** The PropertyGrid row id of an extension field; its control's HTML id is `property-<row id>`. */
export function extensionFieldRowId(idPrefix: string, fieldId: string): string {
  return `${idPrefix}-${fieldId}`;
}

/** The id prefix of an extension's settings rows, so search can focus a field. */
export function extensionSettingsRowPrefix(extensionGuid: string): string {
  return `ext-${extensionGuid}`;
}

export interface ExtensionSettingsCategory {
  id: string;
  /** The category name the extension writes. */
  label: string;
  keywords: string;
  entry: ExtensionDescriptor;
  settings: ExtensionSettingsContribution;
}

/** One category per enabled, valid extension that declares settings, in the order extensions are listed. */
export function extensionSettingsCategories(
  entries: readonly ExtensionDescriptor[],
  overrides: Readonly<Record<string, { enabled: boolean }>>,
): ExtensionSettingsCategory[] {
  return entries.flatMap((entry) => {
    const settings = entry.settings.contributes.settings;
    if (entry.invalid || !settings || !resolveExtensionEnabled(entry.settings.enabledByDefault, overrides[entry.extensionGuid]?.enabled)) return [];
    return [{
      id: extensionSettingsCategoryId(entry.extensionGuid),
      label: settings.title,
      keywords: [entry.settings.displayName, ...settings.sections.map((section) => section.title),
        ...extensionSettingsFields(entry.settings.contributes).map((field) => field.label)].join(" "),
      entry,
      settings,
    }];
  });
}

/** Settings search rows for the categories' fields; code fields focus their category. */
export function extensionSettingsSearchFields(categories: readonly ExtensionSettingsCategory[]): SettingSearchField[] {
  return categories.flatMap((category) => category.settings.sections.flatMap((section) => section.fields.map((field) => ({
    categoryId: category.id,
    sectionId: section.id,
    sectionTitle: section.title,
    label: field.label,
    ...(field.type === "code" ? {} : { targetId: `property-${extensionFieldRowId(extensionSettingsRowPrefix(category.entry.extensionGuid), field.id)}` }),
  }))));
}
