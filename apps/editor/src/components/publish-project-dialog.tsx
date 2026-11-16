import { useEffect, useState } from "react";
import { CircleAlertIcon, FileArchiveIcon, FolderGit2Icon, UploadIcon, SettingsIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useDocumentActions, useProjectState, useSaveState } from "../context/document-context";
import type { PublishSummary } from "../context/document-context-types";
import { bytesLabel } from "../lib/source-control-labels";
import { API_HOSTS, repositoryNameFor, useHostAccount, useHostOwners, type ApiHost } from "../lib/source-control-host-accounts";
import { HostAccountState } from "./source-control-host-account";

function summaryLine(summary: PublishSummary): string {
  const assets = `${summary.assets} ${summary.assets === 1 ? "asset" : "assets"}`;
  const lfs = summary.lfsBytes > 0 ? ` (${bytesLabel(summary.lfsBytes)} through Git LFS)` : "";
  return `Pushes ${assets}, ${bytesLabel(summary.bytes)}${lfs}`;
}

/**
 * Publish Project (Project Settings → Source Control while Mode is Off):
 * creates an empty repository on GitHub or GitLab, writes `.gitattributes`
 * and `.gitignore`, commits the project and pushes it, and switches the
 * project to Integrated.
 */
export default function PublishProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { publishToNewRepository, summarizeProjectForPublish } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { dirtyDocuments, projectDirty } = useSaveState();
  const [host, setHost] = useState<ApiHost>("github");
  const origin = API_HOSTS[host].origin;
  const { credential, api } = useHostAccount(origin);
  const { owners, error: ownersError } = useHostOwners(api);
  /** The owner chosen by name; until then, the first (the signed-in user). */
  const [owner, setOwner] = useState<string | null>(null);
  const [name, setName] = useState(() => repositoryNameFor(projectDocument?.metadata.name ?? ""));
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [summary, setSummary] = useState<PublishSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void summarizeProjectForPublish().then((result) => {
      if (alive) setSummary(result);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [open, summarizeProjectForPublish]);

  const chosen = owners?.find((entry) => entry.name === owner) ?? owners?.[0] ?? null;
  const shownError = error ?? ownersError;
  const trimmed = name.trim();
  const unsaved = dirtyDocuments.length > 0 || projectDirty;
  const reason = !credential
    ? `Sign in to ${API_HOSTS[host].label} to publish.`
    : !chosen
      ? "Choose an owner."
      : !trimmed
        ? "Enter a repository name."
        : unsaved
          ? "Save All before publishing."
          : null;
  const hostName = new URL(origin).host;

  const publish = async () => {
    if (!api || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await publishToNewRepository({ origin, owner: chosen, name: trimmed, private: visibility === "private" });
      if (outcome.status === "published") onOpenChange(false);
      else setError(outcome.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" data-testid="publish-project-dialog">
        <DialogHeader>
          <DialogTitle>Publish Project</DialogTitle>
        </DialogHeader>
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <FieldLabel id="publish-host-label">Host</FieldLabel>
            <ToggleGroup
              aria-labelledby="publish-host-label"
              variant="outline"
              size="sm"
              spacing={0}
              value={[host]}
              disabled={busy}
              onValueChange={(value) => {
                const next = value[0] as ApiHost | undefined;
                if (next) setHost(next);
              }}
            >
              {(Object.keys(API_HOSTS) as ApiHost[]).map((key) => {
                const Icon = API_HOSTS[key].icon;
                return (
                  <ToggleGroupItem key={key} value={key} data-testid={`publish-host-${key}`}>
                    <Icon data-icon="inline-start" />
                    {API_HOSTS[key].label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </Field>
          <HostAccountState origin={origin} credential={credential} data-testid="publish-account" />
          <Field orientation="horizontal">
            <FieldLabel htmlFor="publish-owner">Owner</FieldLabel>
            <Select value={chosen?.name ?? null} onValueChange={(value) => setOwner(value ? String(value) : null)} disabled={busy || !owners}>
              <SelectTrigger id="publish-owner" className="w-full" data-testid="publish-owner">
                <SelectValue placeholder={credential ? "Loading…" : "Sign In First"} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(owners ?? []).map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="publish-name">Repository Name</FieldLabel>
            <Input id="publish-name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} data-testid="publish-name" />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel id="publish-visibility-label">Visibility</FieldLabel>
            <ToggleGroup
              aria-labelledby="publish-visibility-label"
              variant="outline"
              size="sm"
              spacing={0}
              value={[visibility]}
              disabled={busy}
              onValueChange={(value) => {
                const next = value[0] as "private" | "public" | undefined;
                if (next) setVisibility(next);
              }}
            >
              <ToggleGroupItem value="private" data-testid="publish-private">Private</ToggleGroupItem>
              <ToggleGroupItem value="public" data-testid="publish-public">Public</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <ul role="status" className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground" data-testid="publish-summary">
            <li className="flex items-center gap-2">
              <FolderGit2Icon className="size-3.5 shrink-0" aria-hidden="true" />
              Creates {hostName}/{chosen?.name ?? "…"}/{trimmed || "…"}
            </li>
            <li className="flex items-center gap-2">
              <SettingsIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Adds Git LFS settings and an ignore list
            </li>
            <li className="flex items-center gap-2" data-testid="publish-summary-push">
              <FileArchiveIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {summary ? summaryLine(summary) : "Counting assets…"}
            </li>
          </ul>
          {shownError ? (
            <Alert variant="destructive" data-testid="publish-error">
              <AlertTitle>Could Not Publish</AlertTitle>
              <AlertDescription>{shownError}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter className="items-center">
          {reason ? (
            <span role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="publish-reason">
              <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{reason}</span>
            </span>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="publish-submit" disabled={busy || reason !== null} onClick={() => void publish()}>
            <UploadIcon data-icon="inline-start" />
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
