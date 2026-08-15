import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import {
  ClassPicker,
  PanelFrame,
  PropertyGrid,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  normalizePluginSettings,
  type PluginSettingsPayload,
} from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Textarea } from "@babylonslate/ui/components/textarea";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { editorUtilityObjectClassEntries } from "../lib/editor-utility-classes";
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
        ? ((doc?.content as { pluginGuid: string }).pluginGuid)
        : ""),
    displayName: doc?.ref.label,
  });

  const commit = (patch: Partial<PluginSettingsPayload>) => {
    if (readOnly) return;
    void applyAssetDocumentChange(documentId, { ...settings, ...patch });
  };

  const identityRows: PropertyRow[] = pluginSettingsIdentityFields(settings).map(
    (field) => ({
      id: field.id,
      kind: "text",
      label: field.label,
      value: field.value,
      disabled: readOnly || field.readOnly,
      onChange: (value) => {
        if (field.id === "pluginGuid" || field.readOnly) return;
        if (field.id === "iconKey") {
          commit({ iconKey: value.trim() || null });
          return;
        }
        commit({ [field.id]: value } as Partial<PluginSettingsPayload>);
      },
    }),
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
        <Field>
          <FieldLabel htmlFor="plugin-settings-description">
            Description
          </FieldLabel>
          <Textarea
            id="plugin-settings-description"
            value={settings.description}
            disabled={readOnly}
            onChange={(event) =>
              commit({ description: event.target.value })
            }
            data-testid="plugin-settings-description"
          />
        </Field>
        <PropertyGrid rows={maturityRows} />
        <Field>
          <FieldLabel>Engine Version Range</FieldLabel>
          <Input
            value={settings.engineVersionRange}
            disabled={readOnly}
            onChange={(event) =>
              commit({ engineVersionRange: event.target.value })
            }
            data-testid="plugin-settings-engine-range"
          />
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
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Plugin Dependencies</div>
          {settings.pluginDependencies.map((dep, index) => (
            <FieldGroup
              key={`${dep.guid}-${index}`}
              className="rounded-md border border-border p-2"
            >
              <Field>
                <FieldLabel>GUID</FieldLabel>
                <Input
                  value={dep.guid}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = settings.pluginDependencies.map((entry, i) =>
                      i === index
                        ? { ...entry, guid: event.target.value }
                        : entry,
                    );
                    commit({ pluginDependencies: next });
                  }}
                />
              </Field>
              <Field>
                <FieldLabel>Version Range</FieldLabel>
                <Input
                  value={dep.versionRange}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = settings.pluginDependencies.map((entry, i) =>
                      i === index
                        ? { ...entry, versionRange: event.target.value }
                        : entry,
                    );
                    commit({ pluginDependencies: next });
                  }}
                />
              </Field>
            </FieldGroup>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            data-testid="plugin-settings-dep-add"
            onClick={() =>
              commit({
                pluginDependencies: [
                  ...settings.pluginDependencies,
                  { guid: "", versionRange: "^1.0.0" },
                ],
              })
            }
          >
            Add Dependency
          </Button>
        </div>
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
