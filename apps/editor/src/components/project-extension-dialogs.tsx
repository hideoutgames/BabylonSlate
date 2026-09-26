import { useRef, useState } from "react";
import type { ExtensionDescriptor, ExtensionSettings } from "@babylonslate/assets";
import { SearchDropdown } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { Textarea } from "@babylonslate/ui/components/textarea";
import { Switch } from "@babylonslate/ui/components/switch";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@babylonslate/ui/components/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import type { EditorExtensionCommandDescriptor } from "../lib/editor-extension-host";
import type { EditorExtensionService } from "../services/editor-extension-service";
import { ensureEngineExtensionLibrary, type EngineExtensionEntry } from "../lib/engine-extension-library";
import { downloadExtensionArchive } from "../lib/extension-download";
import { PLUGIN_ICON_OPTIONS } from "../lib/plugin-icons";
import { CodeBodyEditor } from "./js-body-editor";

function useExtensionAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, run };
}

function ActionError({ message }: { message: string | null }) {
  return message ? <Alert variant="destructive"><AlertTitle>Extension Action Failed</AlertTitle><AlertDescription className="whitespace-pre-wrap">{message}</AlertDescription></Alert> : null;
}

export function ExtensionCommandDialog({ command, service, onClose }: {
  command: EditorExtensionCommandDescriptor;
  service: EditorExtensionService;
  onClose(): void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(command.fields.map((field) => [field.id, field.defaultValue ?? ""])));
  const [succeeded, setSucceeded] = useState(false);
  const { busy, error, run } = useExtensionAction();
  const setValue = (id: string, value: string) => { setValues((previous) => ({ ...previous, [id]: value })); setSucceeded(false); };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="editor-dialog-large flex min-h-0 flex-col overflow-hidden sm:max-w-2xl">
      <DialogHeader><DialogTitle>{command.title}</DialogTitle><DialogDescription>{command.description ?? "Run this editor extension command."}</DialogDescription></DialogHeader>
      <FieldGroup className="min-h-0 flex-1 overflow-y-auto">
        {command.fields.map((field) => <Field key={field.id}>
          <FieldLabel htmlFor={`extension-command-${field.id}`}>{field.label}{field.required ? " *" : ""}</FieldLabel>
          {field.type === "multiline" && command.id === "glsl-to-material" && field.id === "source" ?
            <div className="h-64 min-h-0 overflow-hidden rounded-md border border-border" role="group" aria-label={field.label}>
              <CodeBodyEditor language="glsl" ariaLabel={field.label} value={values[field.id] ?? ""} onChange={(value) => setValue(field.id, value)} />
            </div> : field.type === "multiline" ?
              <Textarea id={`extension-command-${field.id}`} value={values[field.id] ?? ""} disabled={busy} onChange={(event) => setValue(field.id, event.target.value)} /> :
              <Input id={`extension-command-${field.id}`} value={values[field.id] ?? ""} disabled={busy} onChange={(event) => setValue(field.id, event.target.value)} />}
        </Field>)}
      </FieldGroup>
      <ActionError message={error} />
      {succeeded ? <Alert role="status"><AlertTitle>{command.id === "glsl-to-material" ? "Material Created" : "Command Completed"}</AlertTitle><AlertDescription>{command.id === "glsl-to-material" ? `${values.name} is available in the Content Browser.` : "The extension command completed successfully."}</AlertDescription></Alert> : null}
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Close</Button>
        <Button size="sm" disabled={busy || succeeded} onClick={() => void run(async () => {
          await service.run(command.extensionId, command.id, { ...values });
          setSucceeded(true);
        })}>{busy ? "Running…" : "Run"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ExtensionEditorDialog({ entry, entries, initialSource, service, onClose }: {
  entry: ExtensionDescriptor;
  entries: ExtensionDescriptor[];
  initialSource: string;
  service: EditorExtensionService;
  onClose(): void;
}) {
  const [settings, setSettings] = useState<ExtensionSettings>(() => structuredClone(entry.settings));
  const [source, setSource] = useState(initialSource);
  const { busy, error, run } = useExtensionAction();
  const patch = (value: Partial<ExtensionSettings>) => setSettings((previous) => ({ ...previous, ...value }));
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="editor-dialog-large flex min-h-0 flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader><DialogTitle>Edit Extension</DialogTitle><DialogDescription>Saving reloads enabled extensions. Code runs in the editor and can modify project assets and code.</DialogDescription></DialogHeader>
      <FieldGroup className="min-h-0 flex-1 overflow-y-auto">
        <Field><FieldLabel htmlFor="extension-edit-guid">Extension ID</FieldLabel><Input id="extension-edit-guid" value={entry.extensionGuid} readOnly /></Field>
        {([['displayName', 'Display Name'], ['version', 'Version'], ['author', 'Author'], ['category', 'Category']] as const).map(([key, label]) => <Field key={key}>
          <FieldLabel htmlFor={`extension-edit-${key}`}>{label}</FieldLabel>
          <Input id={`extension-edit-${key}`} value={settings[key]} disabled={busy} onChange={(event) => patch({ [key]: event.target.value })} />
        </Field>)}
        <Field><FieldLabel htmlFor="extension-edit-description">Description</FieldLabel><Textarea id="extension-edit-description" value={settings.description} disabled={busy} onChange={(event) => patch({ description: event.target.value })} /></Field>
        <Field><FieldLabel>Icon</FieldLabel><SearchDropdown modal title="Extension Icon" items={PLUGIN_ICON_OPTIONS.map(({ key, label, icon: Icon }) => ({ id: key, label, leading: <Icon className="size-4" /> }))} onSelect={(iconKey) => patch({ iconKey })}>
          <Button variant="outline" size="sm" className="w-fit" disabled={busy}>{PLUGIN_ICON_OPTIONS.find((value) => value.key === settings.iconKey)?.label ?? "Choose Icon"}</Button>
        </SearchDropdown></Field>
        {([['experimental', 'Experimental'], ['beta', 'Beta'], ['enabledByDefault', 'Enabled By Default']] as const).map(([key, label]) => <Field key={key} orientation="horizontal">
          <FieldContent><FieldLabel htmlFor={`extension-edit-${key}`}>{label}</FieldLabel></FieldContent><Switch id={`extension-edit-${key}`} checked={settings[key]} disabled={busy} onCheckedChange={(checked) => patch({ [key]: checked === true })} />
        </Field>)}
        <FieldSet><FieldLegend>Extension Dependencies</FieldLegend>
          {settings.extensionDependencies.map((dependency) => {
            const name = entries.find((value) => value.extensionGuid === dependency.guid)?.settings.displayName ?? dependency.guid;
            return <Field key={dependency.guid} orientation="horizontal">
              <FieldContent><FieldLabel>{name}</FieldLabel><FieldDescription>Version {dependency.version || "Any"}</FieldDescription></FieldContent>
              <Button variant="outline" size="sm" disabled={busy} aria-label={`Remove ${name} Dependency`} onClick={() => patch({ extensionDependencies: settings.extensionDependencies.filter((value) => value.guid !== dependency.guid) })}>Remove</Button>
            </Field>;
          })}
          <SearchDropdown modal title="Add Extension Dependency" items={entries.filter((value) => value.extensionGuid !== entry.extensionGuid && !settings.extensionDependencies.some((dependency) => dependency.guid === value.extensionGuid)).map((value) => ({ id: value.extensionGuid, label: value.settings.displayName, description: `Version ${value.settings.version}` }))} onSelect={(guid) => patch({ extensionDependencies: [...settings.extensionDependencies, { guid, version: entries.find((value) => value.extensionGuid === guid)!.settings.version }] })}>
            <Button variant="outline" size="sm" disabled={busy} className="w-fit">Add Dependency</Button>
          </SearchDropdown>
        </FieldSet>
        <Field><FieldLabel>Entry Source</FieldLabel><FieldDescription>{settings.entryPoint} · Export activate(api). Module imports are not supported.</FieldDescription>
          <div className="h-72 min-h-0 overflow-hidden rounded-md border border-border" role="group" aria-label="Extension Source"><CodeBodyEditor language="javascript" ariaLabel="Extension Source" value={source} onChange={setSource} /></div>
        </Field>
      </FieldGroup>
      <ActionError message={error} />
      <DialogFooter><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" disabled={busy || !settings.displayName.trim() || !settings.version.trim()} onClick={() => void run(async () => { await service.save(entry.extensionGuid, settings, source); onClose(); })}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ExtensionExportDialog({ entry, service, onClose }: { entry: ExtensionDescriptor; service: EditorExtensionService; onClose(): void }) {
  const { busy, error, run } = useExtensionAction();
  const [conflict, setConflict] = useState<{ existing: EngineExtensionEntry; bytes: Uint8Array } | null>(null);
  const install = async (bytes: Uint8Array, replaceGuid?: string) => {
    const result = await (await ensureEngineExtensionLibrary()).import(bytes, { replaceGuid });
    if (result.status === "conflict") { setConflict({ existing: result.existing, bytes }); return; }
    onClose();
  };
  return <>
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent>
      <DialogHeader><DialogTitle>Export Extension</DialogTitle><DialogDescription>Download {entry.settings.displayName} or add it to Engine Extensions for new projects.</DialogDescription></DialogHeader>
      <ActionError message={error} />
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { downloadExtensionArchive(await service.export(entry.extensionGuid), entry.settings.displayName); onClose(); })}>Export To Download</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => install(await service.export(entry.extensionGuid)))}>Export To Engine Extensions</Button>
      </DialogFooter>
    </DialogContent></Dialog>
    <AlertDialog open={Boolean(conflict)} onOpenChange={(open) => { if (!open && !busy) setConflict(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Replace Engine Extension</AlertDialogTitle><AlertDialogDescription>{conflict?.existing.settings.displayName} already exists in Engine Extensions. Existing projects keep their copies.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (conflict) { const { bytes, existing } = conflict; setConflict(null); void run(() => install(bytes, existing.extensionGuid)); } }}>Replace</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
