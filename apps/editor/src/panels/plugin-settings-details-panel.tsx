import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { ChevronDownIcon, PuzzleIcon } from "lucide-react";
import {
  ClassPicker,
  MultilineTextField,
  PanelFrame,
  PropertyGrid,
  SearchDropdown,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  normalizePluginSettings,
  type PluginSettingsPayload,
} from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { editorUtilityObjectClassEntries } from "../lib/editor-utility-classes";
import { PLUGIN_ICON_OPTIONS, resolvePluginIcon } from "../lib/plugin-icons";
import {
  isPluginSettingsReadOnly,
  pluginSettingsIdentityFields,
} from "../lib/plugin-ui";

export function PluginSettingsDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const {
    openDocuments,
    applyAssetDocumentChange,
    assetRegistry,
    pluginDescriptors,
  } = useDocuments();
  const [utilityPick, setUtilityPick] = useState(false);
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const descriptor = pluginDescriptors.find(
    (plugin) => plugin.settingsPath === doc?.ref.path,
  );
  const readOnly = isPluginSettingsReadOnly(descriptor?.source ?? "project");
  const settings = normalizePluginSettings(doc?.content ?? {}, {
    pluginGuid:
      descriptor?.pluginGuid ??
      (typeof (doc?.content as { pluginGuid?: unknown } | null)?.pluginGuid ===
      "string"
        ? (doc?.content as { pluginGuid: string }).pluginGuid
        : ""),
    displayName: doc?.ref.label,
  });

  const commit = (patch: Partial<PluginSettingsPayload>) => {
    if (readOnly) return;
    void applyAssetDocumentChange(documentId, { ...settings, ...patch });
  };

  const identityRows: PropertyRow[] = pluginSettingsIdentityFields(settings)
    .filter((field) => field.id !== "iconKey")
    .map((field) => ({
      id: field.id,
      kind: "text",
      label: field.label,
      value: field.value,
      disabled: readOnly || field.readOnly,
      onChange: (value) => {
        if (field.id === "pluginGuid" || field.readOnly) return;
        commit({ [field.id]: value } as Partial<PluginSettingsPayload>);
      },
    }));
  const SelectedIcon = resolvePluginIcon(settings.iconKey) ?? PuzzleIcon;
  const iconLabel =
    PLUGIN_ICON_OPTIONS.find(
      (option) => option.icon === resolvePluginIcon(settings.iconKey),
    )?.label ??
    settings.iconKey ??
    "Default";
  const availableDependencies = pluginDescriptors.filter(
    (plugin) =>
      plugin.pluginGuid !== settings.pluginGuid &&
      !settings.pluginDependencies.some(
        (dep) => dep.guid === plugin.pluginGuid,
      ),
  );

  const maturityRows: PropertyRow[] = [
    {
      id: "experimental",
      kind: "boolean",
      label: "Experimental",
      value: settings.experimental,
      disabled: readOnly,
      onChange: (value) => commit({ experimental: value }),
    },
    {
      id: "beta",
      kind: "boolean",
      label: "Beta",
      value: settings.beta,
      disabled: readOnly,
      onChange: (value) => commit({ beta: value }),
    },
    {
      id: "enabledByDefault",
      kind: "boolean",
      label: "Enabled By Default",
      value: settings.enabledByDefault,
      disabled: readOnly,
      onChange: (value) => commit({ enabledByDefault: value }),
    },
  ];

  return (
    <PanelFrame data-testid="plugin-settings-details-panel">
      <div className="flex flex-col gap-4 p-2">
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            Engine plugins are read-only.
          </p>
        ) : null}
        <PropertyGrid rows={identityRows} />
        <Field data-disabled={readOnly || undefined}>
          <FieldLabel htmlFor="plugin-settings-icon">Icon Key</FieldLabel>
          <SearchDropdown
            title="Plugin Icon"
            placeholder="Search Icons"
            items={[
              { id: "default", label: "Default", leading: <PuzzleIcon /> },
              ...PLUGIN_ICON_OPTIONS.map(({ key, label, icon: Icon }) => ({
                id: key,
                label,
                leading: <Icon />,
              })),
            ]}
            onSelect={(key) =>
              commit({ iconKey: key === "default" ? null : key })
            }
            data-testid="plugin-settings-icon-menu"
          >
            <Button
              id="plugin-settings-icon"
              type="button"
              variant="outline"
              size="sm"
              disabled={readOnly}
              data-testid="plugin-settings-icon"
            >
              <SelectedIcon data-icon="inline-start" />
              {iconLabel}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </SearchDropdown>
        </Field>
        <Field>
          <FieldLabel htmlFor="plugin-settings-description">
            Description
          </FieldLabel>
          <MultilineTextField
            id="plugin-settings-description"
            title="Description"
            value={settings.description}
            disabled={readOnly}
            onChange={(description) => commit({ description })}
            data-testid="plugin-settings-description"
          />
        </Field>
        <PropertyGrid rows={maturityRows} />
        <Field>
          <FieldLabel htmlFor="plugin-settings-engine-range">
            Engine Version Range
          </FieldLabel>
          <Input
            id="plugin-settings-engine-range"
            value={settings.engineVersionRange}
            readOnly
            data-testid="plugin-settings-engine-range"
          />
          <FieldDescription>
            Set automatically when the plugin is created. Imported plugins keep
            their declared compatibility.
          </FieldDescription>
        </Field>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Editor Utility Objects</div>
          {settings.editorUtilityObjects.map((classId) => (
            <div key={classId} className="text-sm">
              {classId}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            data-testid="plugin-settings-euo-add"
            onClick={() => setUtilityPick(true)}
          >
            Add Class
          </Button>
        </div>
        <FieldSet className="gap-2">
          <FieldLegend variant="label">Plugin Dependencies</FieldLegend>
          {settings.pluginDependencies.map((dep, index) => {
            const dependency = pluginDescriptors.find(
              (plugin) => plugin.pluginGuid === dep.guid,
            );
            return (
              <FieldGroup
                key={dep.guid}
                className="rounded-md border border-border p-2"
              >
                <Field>
                  <FieldLabel htmlFor={`plugin-dependency-${index}`}>
                    Plugin
                  </FieldLabel>
                  <Input
                    id={`plugin-dependency-${index}`}
                    value={dependency?.settings.displayName ?? dep.guid}
                    readOnly
                  />
                  <FieldDescription>
                    {dependency ? dep.guid : "Missing Plugin"}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`plugin-dependency-version-${index}`}>
                    Version Range
                  </FieldLabel>
                  <Input
                    id={`plugin-dependency-version-${index}`}
                    value={dep.versionRange}
                    disabled={readOnly}
                    onChange={(event) => {
                      const next = settings.pluginDependencies.map(
                        (entry, i) =>
                          i === index
                            ? { ...entry, versionRange: event.target.value }
                            : entry,
                      );
                      commit({ pluginDependencies: next });
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  aria-label={`Remove ${dependency?.settings.displayName ?? dep.guid} Dependency`}
                  onClick={() =>
                    commit({
                      pluginDependencies: settings.pluginDependencies.filter(
                        (entry) => entry.guid !== dep.guid,
                      ),
                    })
                  }
                >
                  Remove Dependency
                </Button>
              </FieldGroup>
            );
          })}
          <SearchDropdown
            title="Add Plugin Dependency"
            placeholder="Search Plugins"
            emptyLabel="No Other Plugins Available"
            items={availableDependencies.map((plugin) => {
              const Icon =
                resolvePluginIcon(plugin.settings.iconKey) ?? PuzzleIcon;
              return {
                id: plugin.pluginGuid,
                label: plugin.settings.displayName,
                description: `${plugin.settings.version} · ${plugin.pluginGuid}`,
                leading: <Icon />,
              };
            })}
            onSelect={(guid) => {
              const plugin = availableDependencies.find(
                (entry) => entry.pluginGuid === guid,
              );
              if (!plugin) return;
              commit({
                pluginDependencies: [
                  ...settings.pluginDependencies,
                  { guid, versionRange: `^${plugin.settings.version}` },
                ],
              });
            }}
            data-testid="plugin-settings-dependency-menu"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={readOnly}
              data-testid="plugin-settings-dep-add"
            >
              Add Dependency
            </Button>
          </SearchDropdown>
        </FieldSet>
      </div>
      <ClassPicker
        open={utilityPick}
        onOpenChange={setUtilityPick}
        allowNone={false}
        classes={editorUtilityObjectClassEntries(assetRegistry?.list() ?? [])}
        onPick={(classId) => {
          if (!classId) return;
          commit({
            editorUtilityObjects: [
              ...new Set([...settings.editorUtilityObjects, classId]),
            ],
          });
        }}
        data-testid="plugin-settings-euo-picker"
      />
    </PanelFrame>
  );
}
