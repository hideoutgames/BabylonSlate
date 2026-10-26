import type { ProjectDocument } from "@haptic/core";
import { NumberField } from "@haptic/editor-kit";
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
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Switch } from "@haptic/ui/components/switch";
import type {
  DocumentActions,
  RegistryState,
  SourceControlState,
} from "../context/document-context-types";

interface ProjectSourceControlSettingsProps {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  projectGuid: RegistryState["projectGuid"];
  /** The host's live ref: Enable reads it once the Git read settles. */
  latest: {
    readonly current: {
      project: ProjectDocument | null;
      projectGuid: RegistryState["projectGuid"];
      applyProjectSettings: DocumentActions["updateProjectSettings"];
    };
  };
  prefillSourceControlFromGit: DocumentActions["prefillSourceControlFromGit"];
  sourceControl: SourceControlState["sourceControl"];
  tokenDraft: string;
  setTokenDraft: (tokenDraft: string) => void;
  tokenError: string | null;
  setTokenError: (tokenError: string | null) => void;
  sourceControlUrlMissing: boolean;
  setSourceControlUrlMissing: (missing: boolean) => void;
  setDisableSourceControlOpen: (open: boolean) => void;
}

/**
 * Project Settings → Source Control. The token draft, its error and the URL
 * check live in the host so they survive category switches.
 */
export function ProjectSourceControlSettings({
  projectDocument,
  updateProjectSettings,
  projectGuid,
  latest,
  prefillSourceControlFromGit,
  sourceControl,
  tokenDraft,
  setTokenDraft,
  tokenError,
  setTokenError,
  sourceControlUrlMissing,
  setSourceControlUrlMissing,
  setDisableSourceControlOpen,
}: ProjectSourceControlSettingsProps) {
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Source Control</FieldLegend>
          <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="settings-source-control-enabled">
            Enable
          </FieldLabel>
          <Switch
            id="settings-source-control-enabled"
            checked={projectDocument.settings.sourceControl.enabled}
            onCheckedChange={(checked) => {
              const enabled = checked === true;
              const current = projectDocument.settings.sourceControl;
              if (!enabled) {
                setDisableSourceControlOpen(true);
                return;
              }
              if (current.repositoryUrl.trim()) {
                setSourceControlUrlMissing(false);
                updateProjectSettings({
                  sourceControl: { ...current, enabled },
                });
                return;
              }
              // No URL typed: read the folder's Git settings, and refuse
              // to enable when they hold none either.
              const requestedProject = projectGuid;
              void prefillSourceControlFromGit().then((prefill) => {
                // Fill from the settings as they are now: a URL typed
                // during the Git read wins.
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
                    enabled: true,
                    repositoryUrl,
                    branch:
                      now.branch === current.branch && prefill.branch
                        ? prefill.branch
                        : now.branch,
                  },
                });
              });
            }}
            data-testid="settings-source-control-enabled"
          />
        </Field>
          <Field className="settings-field" data-invalid={sourceControlUrlMissing || undefined}>
          <FieldLabel htmlFor="settings-source-control-url">
            Repository URL
          </FieldLabel>
          <Input
            id="settings-source-control-url"
            value={projectDocument.settings.sourceControl.repositoryUrl}
            aria-invalid={sourceControlUrlMissing || undefined}
            aria-describedby={sourceControlUrlMissing ? "settings-source-control-url-error" : undefined}
            onChange={(event) => {
              setSourceControlUrlMissing(false);
              updateProjectSettings({
                sourceControl: {
                  ...projectDocument.settings.sourceControl,
                  repositoryUrl: event.target.value,
                },
              });
            }}
            data-testid="settings-source-control-url"
          />
          {sourceControlUrlMissing ? (
            <FieldError id="settings-source-control-url-error" data-testid="settings-source-control-url-error">
              Enter a Repository URL before turning on Source Control.
            </FieldError>
          ) : null}
        </Field>
          <Field className="settings-field">
          <FieldLabel htmlFor="settings-source-control-branch">
            Branch
          </FieldLabel>
          <Input
            id="settings-source-control-branch"
            value={projectDocument.settings.sourceControl.branch}
            onChange={(event) =>
              updateProjectSettings({
                sourceControl: {
                  ...projectDocument.settings.sourceControl,
                  branch: event.target.value,
                },
              })
            }
            data-testid="settings-source-control-branch"
          />
        </Field>
          <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="settings-source-control-auto-lock">
            Auto-Lock On First Edit
          </FieldLabel>
          <Switch
            id="settings-source-control-auto-lock"
              checked={
                projectDocument.settings.sourceControl.autoLockOnEdit
              }
            onCheckedChange={(checked) =>
              updateProjectSettings({
                sourceControl: {
                  ...projectDocument.settings.sourceControl,
                  autoLockOnEdit: checked === true,
                },
              })
            }
            data-testid="settings-source-control-auto-lock"
          />
        </Field>
          <Field className="settings-field">
          <FieldLabel htmlFor="settings-source-control-poll">
              Poll Interval (Seconds)
          </FieldLabel>
          <NumberField
            id="settings-source-control-poll"
            min={1}
            className="min-h-[var(--chrome-row,28px)]"
            value={Math.round(
                projectDocument.settings.sourceControl.pollIntervalMs /
                  1000,
            )}
            onChange={(seconds) =>
              updateProjectSettings({
                sourceControl: {
                  ...projectDocument.settings.sourceControl,
                  pollIntervalMs: Math.round(seconds * 1000),
                },
              })
            }
            data-testid="settings-source-control-poll"
          />
        </Field>
          <Field className="settings-field">
          <FieldLabel htmlFor="settings-source-control-token">
            Token
          </FieldLabel>
          <Input
            id="settings-source-control-token"
            type="password"
            autoComplete="off"
            value={tokenDraft}
            aria-invalid={tokenError ? true : undefined}
            aria-describedby={tokenError ? "settings-source-control-token-error" : undefined}
            onChange={(event) => {
              setTokenError(null);
              setTokenDraft(event.target.value);
            }}
            data-testid="settings-source-control-token"
          />
          {tokenError ? (
            <FieldError id="settings-source-control-token-error" data-testid="settings-source-control-token-error">
              {tokenError}
            </FieldError>
          ) : null}
          <FieldDescription data-testid="settings-source-control-token-help">
            Create one in{" "}
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer"
            >
              GitHub Token Settings
            </a>{" "}
            with repo scope, or Contents: Read and Write for a fine-grained
            token. GitLab and Gitea tokens with push access also work.
          </FieldDescription>
          <FieldDescription data-testid="settings-source-control-token-copy">
            {sourceControl.hasToken ? "Token Saved. " : ""}
              Stored on this device for this project. Never included in project files or Git.
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
              className="min-h-[var(--chrome-row,28px)]"
            data-testid="settings-source-control-save-token"
            disabled={!tokenDraft}
            onClick={() => {
              setTokenError(null);
              void sourceControl.saveToken(tokenDraft).then(() => {
                setTokenDraft("");
              }, (error: unknown) => setTokenError(error instanceof Error ? error.message : String(error)));
            }}
          >
            Save Token
          </Button>
          <Button
            type="button"
            variant="outline"
              className="min-h-[var(--chrome-row,28px)]"
            data-testid="settings-source-control-clear-token"
            onClick={() => {
              setTokenError(null);
              void sourceControl.clearToken().then(() => {
                setTokenDraft("");
              }, (error: unknown) => setTokenError(error instanceof Error ? error.message : String(error)));
            }}
          >
            Clear Token
          </Button>
        </div>
      </FieldSet>
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
            Locks stay until you release them. Turning Enable back on keeps
            the lock list.
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
                sourceControl: { ...current, enabled: false },
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
