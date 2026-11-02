import { defaultExportPreset, type ExportPreset, type ProjectDocument } from "@haptic/core";
import { NumberField } from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
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
          <FieldLabel htmlFor="setting-export-debugger">
            Bundle Debugger
          </FieldLabel>
          <Switch
            id="setting-export-debugger"
            checked={exportPreset.bundleDebugger}
            onCheckedChange={(checked) =>
              updateExportPreset({ bundleDebugger: checked === true })
            }
            data-testid="setting-export-debugger"
          />
          <FieldDescription>
            Includes debugging tools and Development Only nodes in the
            export.
          </FieldDescription>
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
      <SettingsSection id="alwaysPackageFolders" title="Always Package Folders">
        <Field className="settings-row">
          <FieldLabel className="sr-only">Always Package Folders</FieldLabel>
          <AlwaysPackageFoldersField
            folders={projectDocument.settings.alwaysPackageFolders}
            onChange={(alwaysPackageFolders) =>
              updateProjectSettings({ alwaysPackageFolders })
            }
          />
          <FieldDescription>
            Assets in these folders and their subfolders ship in every
            export and Preview Build, even when nothing references them.
            Editor-only assets and disabled plugin content stay out.
          </FieldDescription>
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
          <FieldDescription>Editable project backup.</FieldDescription>
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
