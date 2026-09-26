import { useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionDescriptor } from "@babylonslate/assets";
import { NamePromptDialog } from "@babylonslate/editor-kit";
import { pickImportFiles } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { Badge } from "@babylonslate/ui/components/badge";
import { Switch } from "@babylonslate/ui/components/switch";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import { useDocuments } from "../context/document-context";
import type { EditorExtensionCommandDescriptor } from "../lib/editor-extension-host";
import { resolvePluginIcon } from "../lib/plugin-icons";
import { ExtensionCommandDialog, ExtensionEditorDialog, ExtensionExportDialog } from "./project-extension-dialogs";

export function ProjectExtensionsSettings() {
  const { extensionService: service, projectDocument, updateProjectSettings } = useDocuments();
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [newOpen, setNewOpen] = useState(false);
  const [enableTarget, setEnableTarget] = useState<ExtensionDescriptor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExtensionDescriptor | null>(null);
  const [exportTarget, setExportTarget] = useState<ExtensionDescriptor | null>(null);
  const [editor, setEditor] = useState<{ entry: ExtensionDescriptor; source: string } | null>(null);
  const [command, setCommand] = useState<EditorExtensionCommandDescriptor | null>(null);
  const [conflict, setConflict] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; retry(): void } | null>(null);
  const pendingRef = useRef(false);
  const overrides = projectDocument?.settings.extensionOverrides ?? {};

  const run = async (label: string, action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    try { await action(); }
    catch (cause) { setError({ message: cause instanceof Error ? cause.message : String(cause), retry: () => { void run(label, action); } }); }
    finally { pendingRef.current = false; setPending(null); }
  };
  const setEnabled = async (entry: ExtensionDescriptor, enabled: boolean) => {
    const next = { ...service.getOverrides(), [entry.extensionGuid]: { enabled } };
    await service.refresh(next);
    updateProjectSettings({ extensionOverrides: next });
  };
  const importArchive = async (bytes: Uint8Array, replace = false) => {
    const result = await service.import(bytes, replace);
    if (result.status === "conflict") { setConflict({ name: result.name, bytes }); return; }
    setConflict(null);
    updateProjectSettings({ extensionOverrides: service.getOverrides() });
  };
  const edit = async (entry: ExtensionDescriptor) => setEditor({ entry, source: await service.readSource(entry.extensionGuid) });
  const maturity = enableTarget ? [enableTarget.settings.experimental ? "Experimental" : "", enableTarget.settings.beta ? "Beta" : ""].filter(Boolean).join(" / ") : "";

  return <FieldGroup data-testid="settings-extensions-panel">
    <FieldSet>
      <FieldLegend>Project Extensions</FieldLegend>
      <FieldDescription>Editor tools for project assets and TypeScript or JavaScript code. Extensions do not run in the game.</FieldDescription>
      {pending ? <p role="status">{pending}…</p> : null}
      {error ? <Alert variant="destructive"><AlertTitle>Extension Action Failed</AlertTitle><AlertDescription>{error.message}<Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={error.retry}>Retry</Button></AlertDescription></Alert> : null}
      {snapshot.diagnostics.length > 0 ? <Alert><AlertTitle>Extension Diagnostics</AlertTitle><AlertDescription><ul className="list-disc pl-4">{snapshot.diagnostics.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul></AlertDescription></Alert> : null}
      {snapshot.entries.map((entry) => {
        const enabled = overrides[entry.extensionGuid]?.enabled ?? entry.settings.enabledByDefault;
        const commands = snapshot.commands.filter((value) => value.extensionId === entry.extensionGuid);
        const Icon = resolvePluginIcon(entry.settings.iconKey);
        return <Field key={entry.extensionGuid} className="rounded-md border border-border p-3" data-testid={`settings-extension-row-${entry.extensionGuid}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
              <span className="font-medium">{entry.settings.displayName}</span>
              <Badge variant="outline">{entry.source === "engine" ? "Engine" : "Project"}</Badge>
              {entry.settings.experimental ? <Badge variant="secondary">Experimental</Badge> : null}
              {entry.settings.beta ? <Badge variant="secondary">Beta</Badge> : null}
              <span className="text-sm text-muted-foreground">v{entry.settings.version}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {!entry.readOnly ? <Button variant="outline" size="sm" disabled={Boolean(pending)} aria-label={`Edit ${entry.settings.displayName}`} onClick={() => void run("Opening Extension", () => edit(entry))}>Edit</Button> : null}
              <Button variant="outline" size="sm" disabled={Boolean(pending)} aria-label={`Export ${entry.settings.displayName}`} onClick={() => setExportTarget(entry)}>Export</Button>
              {!entry.readOnly ? <Button variant="outline" size="sm" disabled={Boolean(pending)} aria-label={`Delete ${entry.settings.displayName}`} onClick={() => setDeleteTarget(entry)}>Delete</Button> : null}
            </div>
          </div>
          {entry.settings.description ? <FieldDescription>{entry.settings.description}</FieldDescription> : null}
          {entry.settings.extensionDependencies.length ? <FieldDescription>Dependencies: {entry.settings.extensionDependencies.map((dependency) => `${snapshot.entries.find((value) => value.extensionGuid === dependency.guid)?.settings.displayName ?? dependency.guid} (${dependency.version || "Any Version"})`).join(", ")}</FieldDescription> : null}
          <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor={`extension-enabled-${entry.extensionGuid}`}>Enabled</FieldLabel></FieldContent>
            <Switch id={`extension-enabled-${entry.extensionGuid}`} aria-label={`Enable ${entry.settings.displayName}`} checked={enabled} disabled={Boolean(pending)} onCheckedChange={(checked) => {
              if (checked) setEnableTarget(entry);
              else void run("Disabling Extension", () => setEnabled(entry, false));
            }} />
          </Field>
          {commands.length ? <div className="flex flex-wrap gap-2">{commands.map((value) => <Button key={value.id} variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => setCommand(value)}>{value.title}</Button>)}</div> : null}
        </Field>;
      })}
      {snapshot.entries.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Extensions</EmptyTitle><EmptyDescription>Create an editor tool or import a .babextension package.</EmptyDescription></EmptyHeader></Empty> : null}
      <div className="flex flex-wrap gap-2">
        <Button id="settings-extension-new" variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => setNewOpen(true)}>New Extension</Button>
        <Button id="settings-extension-import" variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => void run("Importing Extension", async () => { const [file] = await pickImportFiles({ multiple: false, accept: ".babextension" }); if (file) await importArchive(file.bytes); })}>Import Extension</Button>
      </div>
    </FieldSet>
    <NamePromptDialog open={newOpen} onOpenChange={setNewOpen} title="New Extension" label="Display Name" confirmLabel="Create" onSubmit={(name) => void run("Creating Extension", async () => { await edit(await service.create(name)); })} />
    {editor ? <ExtensionEditorDialog entry={editor.entry} entries={snapshot.entries} initialSource={editor.source} service={service} onClose={() => setEditor(null)} /> : null}
    {command ? <ExtensionCommandDialog command={command} service={service} onClose={() => setCommand(null)} /> : null}
    {exportTarget ? <ExtensionExportDialog entry={exportTarget} service={service} onClose={() => setExportTarget(null)} /> : null}
    <AlertDialog open={Boolean(enableTarget)} onOpenChange={(open) => { if (!open) setEnableTarget(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{`Enable ${maturity ? `${maturity} ` : ""}Extension`}</AlertDialogTitle><AlertDialogDescription>{enableTarget?.settings.displayName}{maturity ? ` is marked ${maturity}` : ""}. Its code runs in the editor and can modify project assets and code. Enable only code you trust.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (enableTarget) { const entry = enableTarget; setEnableTarget(null); void run("Enabling Extension", () => setEnabled(entry, true)); } }}>Enable</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}><AlertDialogContent variant="destructive">
      <AlertDialogHeader><AlertDialogTitle>Delete Extension</AlertDialogTitle><AlertDialogDescription>Permanently delete {deleteTarget?.settings.displayName} and its package files from this project. Created project assets remain. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (deleteTarget) { const guid = deleteTarget.extensionGuid; setDeleteTarget(null); void run("Deleting Extension", async () => { await service.remove(guid); updateProjectSettings({ extensionOverrides: service.getOverrides() }); }); } }}>Delete</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <AlertDialog open={Boolean(conflict)} onOpenChange={(open) => { if (!open) setConflict(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Extension Already Installed</AlertDialogTitle><AlertDialogDescription>{conflict?.name} is already installed. Replace its code and settings? The imported extension stays disabled until enabled again.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Keep</AlertDialogCancel><AlertDialogAction onClick={() => { if (conflict) { const bytes = conflict.bytes; setConflict(null); void run("Replacing Extension", () => importArchive(bytes, true)); } }}>Replace</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </FieldGroup>;
}
