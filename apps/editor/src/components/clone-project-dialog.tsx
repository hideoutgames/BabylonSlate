import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlertIcon, DownloadIcon, FolderGit2Icon } from "lucide-react";
import { isOk } from "@haptic/core";
import { parseRepositoryUrl } from "@haptic/source-control";
import type { HostRepository } from "@haptic/source-control/host-api";
import { SearchInput } from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Badge } from "@haptic/ui/components/badge";
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
import { Progress } from "@haptic/ui/components/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import type { CloneProjectRequest } from "../context/document-context-types";
import { agoLabel, bytesLabel } from "../lib/source-control-labels";
import type { TransferMonitor } from "../services/source-control-sync";
import { signInPromptFor } from "../services/source-control-service";
import { useNativeHomepageAccount } from "./homepage-account-context";
import {
  API_HOSTS,
  projectNameFor,
  URL_HOST_ICON,
  useHostAccount,
  type ApiHost,
} from "../lib/source-control-host-accounts";
import { HostAccountState } from "./source-control-host-account";

type CloneHost = ApiHost | "url";

/**
 * Clone Project (project browser): a repository from GitHub or GitLab (the
 * signed-in account's list, searchable) or by URL, its branch and a project
 * name, cloned into app storage and opened in Integrated mode.
 */
export default function CloneProjectDialog({
  open,
  onOpenChange,
  existingNames,
  onClone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project names already listed: a clone needs a folder of its own. */
  existingNames: readonly string[];
  onClone: (request: CloneProjectRequest, transfer: TransferMonitor) => Promise<void>;
}) {
  const [host, setHost] = useState<CloneHost>("github");
  const [typedUrl, setTypedUrl] = useState("");
  const typedLocation = host === "url" ? parseRepositoryUrl(typedUrl) : null;
  const origin = host === "url" ? typedLocation?.origin ?? null : API_HOSTS[host].origin;
  const { credential, api } = useHostAccount(origin);
  const [repositories, setRepositories] = useState<{ items: HostRepository[]; loading: boolean; error: string | null }>({ items: [], loading: false, error: null });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HostRepository | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("main");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [cloning, setCloning] = useState<{ bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<AbortController | null>(null);
  // Returning from the browser after sign-in, or a long clone, must not unmount the dialog on mobile.
  const holdSessionCheck = useNativeHomepageAccount()?.profile.holdSessionCheck;

  useEffect(() => {
    setSelected(null);
    setRepositories({ items: [], loading: false, error: null });
    if (host === "url" || !api) return;
    let alive = true;
    setRepositories({ items: [], loading: true, error: null });
    void api.repositories().then((result) => {
      if (!alive) return;
      setRepositories(isOk(result)
        ? { items: result.value, loading: false, error: null }
        : { items: [], loading: false, error: result.error.message });
    });
    return () => {
      alive = false;
    };
  }, [api, host]);

  useEffect(() => {
    setBranches(null);
    if (!selected || !api) return;
    setBranch(selected.defaultBranch);
    let alive = true;
    void api.branches(selected.name).then((result) => {
      if (alive && isOk(result)) setBranches(result.value);
    });
    return () => {
      alive = false;
    };
  }, [api, selected]);

  const repositoryPath = host === "url" ? typedLocation?.path ?? "" : selected?.name ?? "";
  useEffect(() => {
    if (!nameEdited) setName(projectNameFor(repositoryPath));
  }, [nameEdited, repositoryPath]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? repositories.items.filter((repository) => repository.name.toLowerCase().includes(needle)) : repositories.items;
  }, [query, repositories.items]);

  const repositoryUrl = host === "url" ? (typedLocation ? typedUrl.trim() : "") : selected?.repositoryUrl ?? "";
  const trimmedName = name.trim();
  const nameTaken = existingNames.some((existing) => existing.toLowerCase() === trimmedName.toLowerCase());
  const prompt = origin ? signInPromptFor(origin) : null;
  const reason = !credential
    ? !prompt
      ? "Enter a repository URL."
      : prompt.deviceHost
        ? `Sign in to ${prompt.label} first.`
        : `Add a token for ${prompt.label} in Engine Settings → Source Control.`
    : !repositoryUrl
      ? host === "url" ? "Enter a repository URL." : "Choose a repository."
      : !branch.trim()
        ? "Enter a branch."
        : !trimmedName
          ? "Enter a project name."
          : nameTaken
            ? "A project with this name already exists."
            : null;

  const clone = async () => {
    const controller = new AbortController();
    cancel.current = controller;
    setCloning({ bytes: 0 });
    setError(null);
    const release = holdSessionCheck?.();
    const transfer: TransferMonitor = {
      bytes: (count) => setCloning((current) => (current ? { bytes: current.bytes + count } : current)),
      signal: () => controller.signal,
    };
    try {
      await onClone({ repositoryUrl, branch: branch.trim(), name: trimmedName }, transfer);
    } catch (failure) {
      // The Git client reports a refused request as a network failure: a cancel is known by its signal.
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      release?.();
      cancel.current = null;
      setCloning(null);
    }
  };

  const busy = cloning !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="homepage-theme sm:max-w-lg" data-testid="clone-project-dialog">
        <DialogHeader>
          <DialogTitle>Clone Project</DialogTitle>
        </DialogHeader>
        <FieldGroup className="gap-3">
          <div className="flex items-center gap-2">
            <ToggleGroup
              aria-label="Host"
              variant="outline"
              size="sm"
              spacing={0}
              value={[host]}
              disabled={busy}
              onValueChange={(value) => {
                const next = value[0] as CloneHost | undefined;
                if (next) setHost(next);
              }}
            >
              {(Object.keys(API_HOSTS) as ApiHost[]).map((key) => {
                const Icon = API_HOSTS[key].icon;
                return (
                  <ToggleGroupItem key={key} value={key} data-testid={`clone-host-${key}`}>
                    <Icon data-icon="inline-start" />
                    {API_HOSTS[key].label}
                  </ToggleGroupItem>
                );
              })}
              <ToggleGroupItem value="url" data-testid="clone-host-url">
                <URL_HOST_ICON data-icon="inline-start" />
                URL
              </ToggleGroupItem>
            </ToggleGroup>
            <span className="flex-1" />
            {origin ? <HostAccountState origin={origin} credential={credential} data-testid="clone-account" /> : null}
          </div>
          {host === "url" ? (
            <Field orientation="horizontal">
              <FieldLabel htmlFor="clone-url">Repository</FieldLabel>
              <Input
                id="clone-url"
                value={typedUrl}
                placeholder="https://"
                disabled={busy}
                onChange={(event) => setTypedUrl(event.target.value)}
                data-testid="clone-url"
              />
            </Field>
          ) : (
            <>
              <SearchInput value={query} onChange={setQuery} placeholder="Search Repositories" aria-label="Search Repositories" data-testid="clone-search" />
              <div role="listbox" aria-label="Repositories" className="flex max-h-56 min-h-16 flex-col overflow-y-auto rounded-md border" data-testid="clone-repositories">
                {repositories.error ? (
                  <Alert variant="destructive" className="border-0">
                    <AlertTitle>Could Not List Repositories</AlertTitle>
                    <AlertDescription>{repositories.error}</AlertDescription>
                  </Alert>
                ) : visible.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">
                    {!credential ? "Sign In To List Repositories." : repositories.loading ? "Loading Repositories…" : "No Repositories"}
                  </p>
                ) : (
                  visible.map((repository) => {
                    const active = selected?.repositoryUrl === repository.repositoryUrl;
                    return (
                      <div
                        key={repository.repositoryUrl}
                        role="option"
                        aria-selected={active}
                        tabIndex={0}
                        className={cn(
                          "flex min-h-[var(--chrome-row,28px)] cursor-default items-center gap-2 px-2 py-1 text-sm outline-none hover:bg-muted focus-visible:bg-muted",
                          active && "bg-accent text-accent-foreground",
                        )}
                        data-testid={`clone-repository-${repository.name}`}
                        onClick={() => { if (!busy) setSelected(repository); }}
                        onKeyDown={(event) => {
                          if (!busy && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            setSelected(repository);
                          }
                        }}
                      >
                        <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{repository.name}</span>
                          {repository.updatedAt ? (
                            <span className="truncate text-xs text-muted-foreground">
                              Updated {agoLabel(Date.parse(repository.updatedAt), Date.now())}
                            </span>
                          ) : null}
                        </div>
                        <Badge variant="outline">{repository.private ? "Private" : "Public"}</Badge>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="clone-branch">Branch</FieldLabel>
            {branches && host !== "url" ? (
              <Select value={branch} onValueChange={(value) => { if (value) setBranch(String(value)); }} disabled={busy}>
                <SelectTrigger id="clone-branch" className="w-full" data-testid="clone-branch">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {[...new Set([branch, ...branches])].map((entry) => (
                      <SelectItem key={entry} value={entry}>{entry}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input id="clone-branch" value={branch} disabled={busy} onChange={(event) => setBranch(event.target.value)} data-testid="clone-branch" />
            )}
          </Field>
          <Field orientation="horizontal" data-invalid={nameTaken || undefined}>
            <FieldLabel htmlFor="clone-name">Project Name</FieldLabel>
            <Input
              id="clone-name"
              value={name}
              disabled={busy}
              aria-invalid={nameTaken || undefined}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              data-testid="clone-name"
            />
          </Field>
          {cloning ? (
            <div role="status" className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="clone-progress">
              <span>Cloning{cloning.bytes > 0 ? ` · ${bytesLabel(cloning.bytes)} received` : "…"}</span>
              <Progress value={null} aria-label="Cloning" />
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive" data-testid="clone-error">
              <AlertTitle>Could Not Clone</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter className="items-center">
          {reason && !busy ? (
            <span role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="clone-reason">
              <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{reason}</span>
            </span>
          ) : null}
          {busy ? (
            <Button variant="outline" data-testid="clone-cancel" onClick={() => cancel.current?.abort()}>Cancel</Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          )}
          <Button data-testid="clone-submit" disabled={busy || reason !== null} onClick={() => void clone()}>
            <DownloadIcon data-icon="inline-start" />
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
