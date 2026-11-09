import { useState } from "react";
import { defaultAppId, defaultExportPreset, isValidAppId, type AppIdentity, type ExportPreset, type ProjectDocument } from "@haptic/core";
import { LabelHint, NumberField } from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions } from "../context/document-context-types";
import { AlwaysPackageFoldersField } from "./always-package-folders-field";
import { SettingsSection } from "./settings-section";
import type { ProjectExport } from "./use-project-export";

type ProjectExportSettingsProps = ProjectExport & {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
};

/**
 * App Identity: what native app packages (macOS now, Android and iOS later)
 * are called and identified by. A typed App ID is kept as a draft until it is
 * valid, so an unfinished one never replaces the saved one.
 */
function AppIdentitySection({ projectDocument, updateProjectSettings }: Pick<ProjectExportSettingsProps, "projectDocument" | "updateProjectSettings">) {
  const identity = projectDocument.settings.appIdentity;
  const [appIdDraft, setAppIdDraft] = useState<string | null>(null);
  const appIdText = appIdDraft ?? identity.appId;
  const appIdError = appIdText.trim() && !isValidAppId(appIdText.trim())
    ? "Use two or more parts of letters and digits, each starting with a letter, such as com.studio.game."
    : null;
  const update = (patch: Partial<AppIdentity>) => updateProjectSettings({ appIdentity: { ...identity, ...patch } });
  return (
    <SettingsSection id="appIdentity" title="App Identity">
      <Field className="settings-field" data-invalid={appIdError ? true : undefined}>
        <LabelHint hint="Identifies the app to the operating system and app stores. Keep it once you publish.">
          <FieldLabel htmlFor="setting-app-id">App ID</FieldLabel>
        </LabelHint>
        <div className="flex min-w-0 flex-col gap-1">
          <Input
            id="setting-app-id"
            data-testid="setting-app-id"
            value={appIdText}
            placeholder={defaultAppId(projectDocument.metadata.name)}
            aria-invalid={appIdError ? true : undefined}
            aria-describedby={appIdError ? "setting-app-id-error" : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setAppIdDraft(next);
              if (!next.trim() || isValidAppId(next.trim())) update({ appId: next.trim() });
            }}
            onBlur={() => setAppIdDraft(null)}
          />
          {appIdError ? <FieldError id="setting-app-id-error">{appIdError}</FieldError> : null}
        </div>
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="setting-app-display-name">Display Name</FieldLabel>
        <Input
          id="setting-app-display-name"
          data-testid="setting-app-display-name"
          value={identity.displayName}
          placeholder={projectDocument.metadata.name}
          maxLength={100}
          onChange={(event) => update({ displayName: event.target.value })}
        />
      </Field>
      <Field className="settings-field">
        <LabelHint hint="Raise it for every upload to an app store. The version is the project's, in General.">
          <FieldLabel htmlFor="setting-app-build-number">Build Number</FieldLabel>
        </LabelHint>
        <NumberField
          id="setting-app-build-number"
          data-testid="setting-app-build-number"
          min={1}
          integer
          value={identity.buildNumber}
          onChange={(value) => update({ buildNumber: Math.max(1, Math.round(value)) })}
        />
      </Field>
    </SettingsSection>
  );
}

/**
 * Project Settings → Export: what packaging includes, and Export Project.
 * Packaging itself runs from Settings → Packaging. The run state comes from
 * the host's `useProjectExport`.
 */
export function ProjectExportSettings({
  projectDocument,
  updateProjectSettings,
  exportProjectBusy,
  exportProjectError,
  exportNotice,
  handleExport,
}: ProjectExportSettingsProps) {
  const exportPreset =
    projectDocument?.settings.exportPresets[0] ?? defaultExportPreset();
  /** The Export fields edit the first preset; later presets stay as stored. */
  const updateExportPreset = (patch: Partial<ExportPreset>) => {
    if (!projectDocument) return;
    const [current = defaultExportPreset(), ...rest] =
      projectDocument.settings.exportPresets;
    updateProjectSettings({ exportPresets: [{ ...current, ...patch }, ...rest] });
  };

  return (
    <FieldGroup>
      <SettingsSection id="gamePackaging" title="Game Packaging">
        <Field orientation="horizontal" className="settings-field">
          <LabelHint hint="Includes debugging tools and Development Only nodes in the export.">
            <FieldLabel htmlFor="setting-export-debugger">
              Bundle Debugger
            </FieldLabel>
          </LabelHint>
          <Switch
            id="setting-export-debugger"
            checked={exportPreset.bundleDebugger}
            onCheckedChange={(checked) =>
              updateExportPreset({ bundleDebugger: checked === true })
            }
            data-testid="setting-export-debugger"
          />
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="setting-export-file-warn">
            File Count Warn
          </FieldLabel>
          <NumberField
            id="setting-export-file-warn"
            min={1}
            value={exportPreset.fileCountWarn}
            onChange={(value) => updateExportPreset({ fileCountWarn: value })}
            data-testid="setting-export-file-warn"
          />
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="setting-export-file-fail">
            File Count Fail
          </FieldLabel>
          <NumberField
            id="setting-export-file-fail"
            min={1}
            value={exportPreset.fileCountFail}
            onChange={(value) => updateExportPreset({ fileCountFail: value })}
            data-testid="setting-export-file-fail"
          />
        </Field>
      </SettingsSection>
      <AppIdentitySection projectDocument={projectDocument} updateProjectSettings={updateProjectSettings} />
      <SettingsSection id="alwaysPackageFolders" title="Always Package Folders">
        <Field className="settings-row">
          <FieldLabel className="sr-only">Always Package Folders</FieldLabel>
          <AlwaysPackageFoldersField
            folders={projectDocument.settings.alwaysPackageFolders}
            onChange={(alwaysPackageFolders) =>
              updateProjectSettings({ alwaysPackageFolders })
            }
          />
        </Field>
      </SettingsSection>
      <SettingsSection id="projectBackup" title="Project Backup">
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="export-project">Export Project</FieldLabel>
          <Button
            variant="outline"
            size="sm"
            className="w-fit justify-self-end"
            data-testid="export-project"
            id="export-project"
            disabled={exportProjectBusy}
            onClick={() => void handleExport()}
          >
            {exportProjectBusy ? "Exporting Project…" : "Export Project"}
          </Button>
        </Field>
        {exportProjectError || exportNotice ? (
          <div className="settings-row">
            {exportProjectError ? (
              <Alert variant="destructive">
                <AlertTitle>Project Export Failed</AlertTitle>
                <AlertDescription>{exportProjectError}</AlertDescription>
              </Alert>
            ) : null}
            {exportNotice ? <p role="status" className="text-sm text-muted-foreground">{exportNotice}</p> : null}
          </div>
        ) : null}
      </SettingsSection>
    </FieldGroup>
  );
}
