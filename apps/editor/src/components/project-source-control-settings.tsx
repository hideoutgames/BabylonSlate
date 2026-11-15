import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { UploadIcon } from "lucide-react";
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
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Switch } from "@haptic/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { getHostPlatform, isTestModeEnabled } from "@haptic/vfs";
import {
  asksAdoption,
  canPublishProject,
  integratedBlockerLabel,
  offeredSourceControlModes,
  type SourceControlFolder,
} from "../lib/source-control-mode";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { AdoptGitFolderDialog } from "./source-control-adopt-dialog";
import { SettingsSection } from "./settings-section";
import type {
  DocumentActions,
  RegistryState,
} from "../context/document-context-types";

// The account-aware rows (repository and branch pickers, Sign In) load only
// while the mode is not Off, so an Off project never loads the credential store.
const ProjectSourceControlHostFields = lazy(() => import("./project-source-control-host-fields"));
// Publish (host API, Git client) loads when it is opened.
const PublishProjectDialog = lazy(() => import("./publish-project-dialog"));

const MODE_LABELS: Record<SourceControlMode, string> = { off: "Off", integrated: "Integrated", manual: "Manual" };

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
  readSourceControlFolder: DocumentActions["readSourceControlFolder"];
  setSourceControlAdoption: DocumentActions["setSourceControlAdoption"];
  /** Integrated mode's sync: whether it runs or why the folder blocks it (only those two are read). */
  sourceControlSync: SourceControlSyncService;
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
  readSourceControlFolder,
  setSourceControlAdoption,
  sourceControlSync,
  sourceControlUrlMissing,
  setSourceControlUrlMissing,
  setDisableSourceControlOpen,
}: ProjectSourceControlSettingsProps) {
  const settings = projectDocument.settings.sourceControl;
  const [folder, setFolder] = useState<SourceControlFolder>(() => ({
    platform: getHostPlatform(),
    testMode: isTestModeEnabled(),
    tier: null,
    hasGit: false,
  }));
  // The one-Git-app warning: before switching Mode to Integrated, or to run Git in a folder a stored Integrated mode reached.
  const [adoptFor, setAdoptFor] = useState<"mode" | "folder" | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // The sync decides whether Integrated mode runs in this folder (it reads the desktop answer); only these two re-render the page.
  const syncBlocked = useSyncExternalStore(sourceControlSync.subscribe, () => sourceControlSync.getSnapshot().blocked);
  const syncActive = useSyncExternalStore(sourceControlSync.subscribe, () => sourceControlSync.getSnapshot().active);
  // The folder's tier and `.git` decide which modes are offered; Publish creates `.git`, so it is read again.
  useEffect(() => {
    let alive = true;
    void readSourceControlFolder().then((read) => {
      if (alive) setFolder((current) => ({ ...current, ...read }));
    });
    return () => {
      alive = false;
    };
  }, [readSourceControlFolder, settings.mode]);
  const modes = offeredSourceControlModes(settings.mode, folder);
  // Integrated mode's repository and branch are the working copy's: they change only with it (Clone, Publish, branch switch).
  const fixed = settings.mode === "integrated";
  const blocker = settings.mode === "integrated" ? syncBlocked : null;
  // On desktop this device's answer can be taken back: Haptic stops running Git here, `project.json` stays Integrated.
  const stopOffered = settings.mode === "integrated" && asksAdoption(folder) && syncActive;
  const change = (patch: Partial<SourceControlProjectSettings>) =>
    updateProjectSettings({ sourceControl: { ...settings, ...patch } });
  const chooseMode = (mode: SourceControlMode) => {
    if (mode === settings.mode) return;
    if (mode === "off") {
      setDisableSourceControlOpen(true);
      return;
    }
    if (mode === "integrated") {
      // An existing working copy: no other Git app may use the folder while Haptic does.
      setAdoptFor("mode");
      return;
    }
    switchTo(mode);
  };
  /**
   * An existing working copy becomes Integrated with its own `origin` and
   * checked-out branch; on desktop the answer is recorded first, so the sync
   * that the new mode starts finds it.
   */
  const adoptIntegrated = async () => {
    const requestedProject = projectGuid;
    const prefill = await prefillSourceControlFromGit();
    const stillOpen = () => latest.current.project !== null && latest.current.projectGuid === requestedProject;
    if (!stillOpen()) return;
    const repositoryUrl = prefill.repositoryUrl || latest.current.project!.settings.sourceControl.repositoryUrl.trim();
    if (!repositoryUrl) {
      setSourceControlUrlMissing(true);
      return;
    }
    setSourceControlUrlMissing(false);
    if (asksAdoption(folder)) await setSourceControlAdoption(true);
    if (!stillOpen()) return;
    const live = latest.current;
    const now = live.project!.settings.sourceControl;
    live.applyProjectSettings({
      sourceControl: { ...now, mode: "integrated", repositoryUrl, branch: prefill.branch || now.branch },
    });
  };
  const stopUsing = () => {
    setStopError(null);
    void setSourceControlAdoption(false).catch((failure: unknown) => {
      setStopError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  const switchTo = (mode: SourceControlMode) => {
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
        readOnly={fixed}
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
        readOnly={fixed}
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
            {modes.map((mode) => (
              <ToggleGroupItem key={mode} value={mode} data-testid={`settings-source-control-mode-${mode}`}>
                {MODE_LABELS[mode]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {blocker ? (
            <FieldDescription className="col-span-full" data-testid="settings-source-control-blocked">
              {integratedBlockerLabel(blocker)}
            </FieldDescription>
          ) : null}
        </Field>
        {blocker === "not-adopted" || stopOffered ? (
          <Field orientation="horizontal" className="settings-field">
            <FieldLabel htmlFor="settings-source-control-git-app">Git App</FieldLabel>
            {stopOffered ? (
              <Button
                id="settings-source-control-git-app"
                variant="outline"
                size="sm"
                className="justify-self-end"
                aria-invalid={stopError ? true : undefined}
                aria-describedby={stopError ? "settings-source-control-git-app-error" : undefined}
                data-testid="settings-source-control-stop-using"
                onClick={stopUsing}
              >
                Stop Using Haptic&apos;s Git Here
              </Button>
            ) : (
              <Button
                id="settings-source-control-git-app"
                variant="outline"
                size="sm"
                className="justify-self-end"
                data-testid="settings-source-control-adopt"
                onClick={() => setAdoptFor("folder")}
              >
                Use Haptic&apos;s Git Here
              </Button>
            )}
            {stopError ? (
              <FieldError id="settings-source-control-git-app-error">{stopError}</FieldError>
            ) : null}
          </Field>
        ) : null}
        {canPublishProject(settings.mode, folder) ? (
          <Field orientation="horizontal" className="settings-field">
            <FieldLabel htmlFor="settings-source-control-publish">Publish</FieldLabel>
            <Button
              id="settings-source-control-publish"
              variant="outline"
              size="sm"
              className="justify-self-end"
              data-testid="settings-source-control-publish"
              onClick={() => setPublishOpen(true)}
            >
              <UploadIcon data-icon="inline-start" />
              Publish Project…
            </Button>
          </Field>
        ) : null}
        {settings.mode === "off" ? (
          <>
            {urlField()}
            {branchField()}
          </>
        ) : (
          <Suspense fallback={<>{urlField()}{branchField()}</>}>
            <ProjectSourceControlHostFields
              fixed={fixed}
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
      <AdoptGitFolderDialog
        open={adoptFor !== null}
        onOpenChange={(open) => {
          if (!open) setAdoptFor(null);
        }}
        onAccept={() => (adoptFor === "mode" ? adoptIntegrated() : setSourceControlAdoption(true))}
      />
      {publishOpen ? (
        <Suspense fallback={null}>
          <PublishProjectDialog open onOpenChange={setPublishOpen} />
        </Suspense>
      ) : null}
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
