import type { ExtensionDescriptor } from "@haptic/assets";
import type { ProjectSettings } from "@haptic/core";
import { FieldGroup } from "@haptic/ui/components/field";
import { extensionSettingsRowPrefix, resolvedExtensionSettings } from "../lib/extension-settings-ui";
import { ExtensionFieldList } from "./extension-fields";
import { SettingsSection } from "./settings-section";

/** The Project Settings category an enabled extension declares: its sections and fields, saved per project. */
export function ExtensionSettingsPage({ entry, stored, onChange }: {
  entry: ExtensionDescriptor;
  stored: ProjectSettings["extensionSettings"];
  onChange(extensionSettings: ProjectSettings["extensionSettings"]): void;
}) {
  const settings = entry.settings.contributes.settings;
  if (!settings) return null;
  const values = resolvedExtensionSettings(entry, stored);
  return <FieldGroup data-testid={`settings-extension-category-${entry.extensionGuid}`}>
    {settings.sections.map((section) => <SettingsSection key={section.id} id={section.id} title={section.title}>
      <ExtensionFieldList
        fields={section.fields}
        values={values}
        idPrefix={extensionSettingsRowPrefix(entry.extensionGuid)}
        gridClassName="settings-row"
        onChange={(fieldId, value) => onChange({ ...stored, [entry.extensionGuid]: { ...stored[entry.extensionGuid], [fieldId]: value } })}
      />
    </SettingsSection>)}
  </FieldGroup>;
}
