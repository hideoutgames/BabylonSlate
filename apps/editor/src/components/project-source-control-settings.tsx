import { lazy, Suspense } from "react";
import type { ProjectDocument, SourceControlMode, SourceControlProjectSettings } from "@haptic/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Switch } from "@haptic/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { SettingsSection } from "./settings-section";
import type {
  DocumentActions,
  RegistryState,
} from "../context/document-context-types";

// The account-aware rows (repository and branch pickers, Sign In) load only
// while the mode is not Off, so an Off project never loads the credential store.
const ProjectSourceControlHostFields = lazy(() => import("./project-source-control-host-fields"));

/** Integrated joins once Haptic syncs projects itself. */
const OFFERED_MODES: Array<{ value: SourceControlMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "manual", label: "Manual" },
];

interface ProjectSourceControlSettingsProps {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  projectGuid: RegistryState["projectGuid"];
  /** The host's live ref: turning Manual on reads it once the Git read settles. */
  latest: {
    readonly current: {
      project: ProjectDocument | null;
      projectGuid: RegistryState["projectGuid"];
      applyProjectSettings: DocumentActions["updateProjectSettings"];
    };
  };
  prefillSourceControlFromGit: DocumentActions["prefillSourceControlFromGit"];
  sourceControlUrlMissing: boolean;
  setSourceControlUrlMissing: (missing: boolean) => void;
  setDisableSourceControlOpen: (open: boolean) => void;
}

/**
 * Project Settings → Source Control. The URL check lives in the host so it
 * survives category switches.
 */
export function ProjectSourceControlSettings({
  projectDocument,
  updateProjectSettings,
  projectGuid,
  latest,
  prefillSourceControlFromGit,
  sourceControlUrlMissing,
  setSourceControlUrlMissing,
  setDisableSourceControlOpen,
}: ProjectSourceControlSettingsProps) {
  const settings = projectDocument.settings.sourceControl;
  const change = (patch: Partial<SourceControlProjectSettings>) =>
    updateProjectSettings({ sourceControl: { ...settings, ...patch } });
  const chooseMode = (mode: SourceControlMode) => {
    if (mode === settings.mode) return;
    if (mode === "off") {
      setDisableSourceControlOpen(true);
      return;
    }
    if (settings.repositoryUrl.trim()) {
      setSourceControlUrlMissing(false);
      change({ mode });
      return;
    }
    // No repository yet: read the folder's Git settings, and refuse to turn
    // source control on when they hold none either.
    const requestedProject = projectGuid;
    void prefillSourceControlFromGit().then((prefill) => {
      // Fill from the settings as they are now: a URL typed during the Git read wins.
      const live = latest.current;
      if (!live.project || live.projectGuid !== requestedProject) return;
      const now = live.project.settings.sourceControl;
      const repositoryUrl = now.repositoryUrl.trim() || prefill.repositoryUrl;
      if (!repositoryUrl) {
        setSourceControlUrlMissing(true);
        return;
      }
      setSourceControlUrlMissing(false);
      live.applyProjectSettings({
        sourceControl: {
          ...now,
          mode,
          repositoryUrl,
          branch: now.branch === settings.branch && prefill.branch ? prefill.branch : now.branch,
        },
      });
    });
  };

  const urlField = () => (
    <Field className="settings-field" data-invalid={sourceControlUrlMissing || undefined}>
      <FieldLabel htmlFor="settings-source-control-url">Repository</FieldLabel>
      <Input
        id="settings-source-control-url"
        value={settings.repositoryUrl}
        placeholder="https://"
        aria-invalid={sourceControlUrlMissing || undefined}
        aria-describedby={sourceControlUrlMissing ? "settings-source-control-url-error" : undefined}
        onChange={(event) => {
          setSourceControlUrlMissing(false);
          change({ repositoryUrl: event.target.value });
        }}
        data-testid="settings-source-control-url"
      />
      {sourceControlUrlMissing ? (
        <FieldError id="settings-source-control-url-error" data-testid="settings-source-control-url-error">
          Enter a repository URL before turning on Source Control.
        </FieldError>
      ) : null}
    </Field>
  );
  const branchField = () => (
    <Field className="settings-field">
      <FieldLabel htmlFor="settings-source-control-branch">Branch</FieldLabel>
      <Input
        id="settings-source-control-branch"
        value={settings.branch}
        onChange={(event) => change({ branch: event.target.value })}
        data-testid="settings-source-control-branch"
      />
    </Field>
  );

  return (
    <FieldGroup>
      <SettingsSection id="repository" title="Repository">
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel id="settings-source-control-mode-label">Mode</FieldLabel>
          <ToggleGroup
            id="settings-source-control-mode"
            aria-labelledby="settings-source-control-mode-label"
            variant="outline"
            size="sm"
            spacing={0}
            className="justify-self-end"
            value={[settings.mode]}
            onValueChange={(value) => {
              const next = value[0] as SourceControlMode | undefined;
              if (next) chooseMode(next);
            }}
            data-testid="settings-source-control-mode"
          >
            {OFFERED_MODES.map((mode) => (
              <ToggleGroupItem key={mode.value} value={mode.value} data-testid={`settings-source-control-mode-${mode.value}`}>
                {mode.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        {settings.mode === "off" ? (
          <>
            {urlField()}
            {branchField()}
          </>
        ) : (
          <Suspense fallback={<>{urlField()}{branchField()}</>}>
            <ProjectSourceControlHostFields
              settings={settings}
              onChange={change}
              urlMissing={sourceControlUrlMissing}
              onUrlTyped={() => setSourceControlUrlMissing(false)}
              renderUrlField={urlField}
              renderBranchField={branchField}
            />
          </Suspense>
        )}
      </SettingsSection>
      <SettingsSection id="locking" title="Locking">
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="settings-source-control-auto-lock">
            Auto-Lock On First Edit
          </FieldLabel>
          <Switch
            id="settings-source-control-auto-lock"
            checked={settings.autoLockOnEdit}
            onCheckedChange={(checked) => change({ autoLockOnEdit: checked === true })}
            data-testid="settings-source-control-auto-lock"
          />
        </Field>
        {settings.mode === "integrated" ? (
          <Field orientation="horizontal" className="settings-field">
            <FieldLabel htmlFor="settings-source-control-release-after-push">
              Release Locks After Push
            </FieldLabel>
            <Switch
              id="settings-source-control-release-after-push"
              checked={settings.releaseLocksAfterPush}
              onCheckedChange={(checked) => change({ releaseLocksAfterPush: checked === true })}
              data-testid="settings-source-control-release-after-push"
            />
          </Field>
        ) : null}
      </SettingsSection>
    </FieldGroup>
  );
}

interface DisableSourceControlDialogProps {
  disableSourceControlOpen: boolean;
  setDisableSourceControlOpen: (open: boolean) => void;
  projectDocument: ProjectDocument | null;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
}

/** Turn Off Source Control confirmation. The host renders it beside, not inside, the settings dialog. */
export function DisableSourceControlDialog({
  disableSourceControlOpen,
  setDisableSourceControlOpen,
  projectDocument,
  updateProjectSettings,
}: DisableSourceControlDialogProps) {
  return (
    <AlertDialog
      open={disableSourceControlOpen}
      onOpenChange={setDisableSourceControlOpen}
    >
      <AlertDialogContent data-testid="settings-source-control-disable-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Turn Off Source Control?</AlertDialogTitle>
          <AlertDialogDescription>
            Locks stay until you release them. Turning it back on keeps the
            lock list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="settings-source-control-disable-confirm-action"
            onClick={() => {
              if (!projectDocument) return;
              const current = projectDocument.settings.sourceControl;
              updateProjectSettings({
                sourceControl: { ...current, mode: "off" },
              });
              setDisableSourceControlOpen(false);
            }}
          >
            Turn Off
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
