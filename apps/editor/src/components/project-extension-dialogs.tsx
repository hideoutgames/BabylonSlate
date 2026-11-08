import { useRef, useState } from "react";
import {
  DEFAULT_EXTENSION_GAME_SOURCE, EXTENSION_CODE_DIR, EXTENSION_SOURCE_MAX_BYTES, isExtensionCodePath, isExtensionLibraryName,
  resolveExtensionFieldValues,
  type ExtensionCodeFile, type ExtensionDescriptor, type ExtensionFieldValue, type ExtensionFieldValues, type ExtensionSettings,
} from "@haptic/assets";
import { LabelHint, NamePromptDialog, SearchDropdown } from "@haptic/editor-kit";
import { pickImportFiles } from "@haptic/vfs";
import { Button } from "@haptic/ui/components/button";
import { Input } from "@haptic/ui/components/input";
import { Textarea } from "@haptic/ui/components/textarea";
import { Switch } from "@haptic/ui/components/switch";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@haptic/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@haptic/ui/components/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@haptic/ui/components/alert-dialog";
import type { EditorExtensionCommandDescriptor, ExtensionMenuContext } from "../lib/editor-extension-host";
import type { EditorExtensionService } from "../services/editor-extension-service";
import { ensureEngineExtensionLibrary, type EngineExtensionEntry } from "../lib/engine-extension-library";
import { saveExtensionArchive } from "../lib/extension-download";
import { PLUGIN_ICON_OPTIONS } from "../lib/plugin-icons";
import { ExtensionFieldList } from "./extension-fields";
import { LazyCodeBodyEditor } from "./lazy-code-editors";

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

export function ExtensionCommandDialog({ command, service, context, onClose }: {
  command: EditorExtensionCommandDescriptor;
  service: EditorExtensionService;
  /** What the menu that opened it was opened on; `{}` from Project Settings. */
  context?: ExtensionMenuContext;
  onClose(): void;
}) {
  const [values, setValues] = useState<ExtensionFieldValues>(() => resolveExtensionFieldValues(command.fields));
  // null until the command completes; then its returned message, if any.
  const [completed, setCompleted] = useState<{ message?: string } | null>(null);
  const { busy, error, run } = useExtensionAction();
  const setValue = (id: string, value: ExtensionFieldValue) => { setValues((previous) => ({ ...previous, [id]: value })); setCompleted(null); };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="editor-dialog-large sm:max-w-2xl" bodyClassName="flex min-w-0 flex-col overflow-hidden">
      <DialogHeader><DialogTitle>{command.title}</DialogTitle><DialogDescription>{command.description ?? "Run this editor extension command."}</DialogDescription></DialogHeader>
      <FieldGroup className="-mx-3 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3">
        <ExtensionFieldList fields={command.fields} values={values} onChange={setValue} idPrefix="extension-command" disabled={busy} />
      </FieldGroup>
      <ActionError message={error} />
      {completed ? <Alert role="status"><AlertTitle>Command Completed</AlertTitle><AlertDescription>{completed.message ?? "The extension command completed successfully."}</AlertDescription></Alert> : null}
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Close</Button>
        <Button size="sm" disabled={busy || completed !== null} onClick={() => void run(async () => {
          const message = await service.run(command.extensionId, command.id, { ...values }, context);
          setCompleted(message ? { message } : {});
        })}>{busy ? "Running…" : "Run"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** Entry first, then the game entry, then every other file by path. */
function orderedCodePaths(paths: Iterable<string>, settings: ExtensionSettings): string[] {
  const rank = (path: string) => path === settings.entryPoint ? 0 : path === settings.gameEntryPoint ? 1 : 2;
  return [...paths].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function codeFileLabel(path: string, settings: ExtensionSettings): string {
  if (path === settings.entryPoint) return `${path} (Editor Entry)`;
  if (path === settings.gameEntryPoint) return `${path} (Game Entry)`;
  return path;
}

/** The `code/` path for a typed or picked file name; `.ts` when it has no extension. */
function extensionCodeFilePath(name: string): string | null {
  const trimmed = name.trim().replace(/^code\//, "");
  const withExtension = /\.(?:ts|js)$/i.test(trimmed) ? trimmed : /\.[^./]+$/.test(trimmed) ? null : `${trimmed}.ts`;
  if (!withExtension) return null;
  const path = `${EXTENSION_CODE_DIR}/${withExtension}`;
  return isExtensionCodePath(path) ? path : null;
}

export function ExtensionEditorDialog({ entry, entries, initialFiles, service, onClose }: {
  entry: ExtensionDescriptor;
  entries: ExtensionDescriptor[];
  initialFiles: readonly ExtensionCodeFile[];
  service: EditorExtensionService;
  onClose(): void;
}) {
  const [settings, setSettings] = useState<ExtensionSettings>(() => structuredClone(entry.settings));
  const [original] = useState(() => new Map(initialFiles.map((file) => [file.path, file.source])));
  const [sources, setSources] = useState<Map<string, string>>(() => new Map(original));
  const [activePath, setActivePath] = useState(entry.settings.entryPoint);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [contributes, setContributes] = useState(() => JSON.stringify(entry.settings.contributes, null, 2));
  const { busy, error, run } = useExtensionAction();
  const [fileError, setFileError] = useState<string | null>(null);
  const patch = (value: Partial<ExtensionSettings>) => setSettings((previous) => ({ ...previous, ...value }));
  // A gameplay package edits its game entry, starting from a template when it has none.
  const visible = new Map(sources);
  if (!settings.editorOnly && !visible.has(settings.gameEntryPoint)) visible.set(settings.gameEntryPoint, DEFAULT_EXTENSION_GAME_SOURCE);
  const paths = orderedCodePaths(visible.keys(), settings);
  const shownPath = visible.has(activePath) ? activePath : settings.entryPoint;
  const setSource = (path: string, source: string) => setSources((previous) => new Map(previous).set(path, source));
  const removable = shownPath !== settings.entryPoint && shownPath !== settings.gameEntryPoint;
  const libraryError = !settings.editorOnly && !isExtensionLibraryName(settings.libraryName.trim())
    ? "Use letters, digits, _ or $, not starting with a digit." : null;
  const addFiles = async () => {
    setFileError(null);
    const picked = await pickImportFiles({ multiple: true, accept: ".ts,.js" });
    const next = new Map(sources);
    const problems: string[] = [];
    for (const file of picked) {
      const path = /\.(?:ts|js)$/i.test(file.name) ? extensionCodeFilePath(file.name.split("/").pop() ?? file.name) : null;
      if (!path) problems.push(`${file.name} is not a .ts or .js file.`);
      else if (next.has(path)) problems.push(`${path} already exists.`);
      else if (file.bytes.byteLength > EXTENSION_SOURCE_MAX_BYTES) problems.push(`${file.name} exceeds 1 MiB.`);
      else next.set(path, new TextDecoder().decode(file.bytes));
    }
    setSources(next);
    const added = [...next.keys()].find((path) => !sources.has(path));
    if (added) setActivePath(added);
    if (problems.length) setFileError(problems.join("\n"));
  };
  const save = async () => {
    let parsedContributes: unknown;
    try {
      parsedContributes = contributes.trim() ? JSON.parse(contributes) : {};
    } catch (cause) {
      throw new Error(`Contributions are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    const final = new Map(sources);
    if (!settings.editorOnly && !final.has(settings.gameEntryPoint)) final.set(settings.gameEntryPoint, DEFAULT_EXTENSION_GAME_SOURCE);
    await service.save(entry.extensionGuid, {
      ...settings, libraryName: settings.libraryName.trim(), contributes: parsedContributes as ExtensionSettings["contributes"],
    }, {
      write: [...final].filter(([path, source]) => original.get(path) !== source).map(([path, source]) => ({ path, source })),
      remove: [...original.keys()].filter((path) => !final.has(path)),
    });
    onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="editor-dialog-large sm:max-w-3xl" bodyClassName="flex min-w-0 flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Edit Extension</DialogTitle><DialogDescription>Saving reloads enabled extensions. Code runs in the editor, and in games when Editor Only is off.</DialogDescription></DialogHeader>
      {/* The gutter holds the Switches' touch hit areas, which reach past the controls, so the list scrolls only vertically. */}
      <FieldGroup className="-mx-3 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3" data-testid="extension-editor-fields">
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
        <Field orientation="horizontal">
          <FieldContent><LabelHint hint="Turn off to add a game library and content that Play and packaged games include."><FieldLabel htmlFor="extension-edit-editorOnly">Editor Only</FieldLabel></LabelHint></FieldContent>
          <Switch id="extension-edit-editorOnly" checked={settings.editorOnly} disabled={busy} onCheckedChange={(checked) => patch({ editorOnly: checked === true })} />
        </Field>
        {!settings.editorOnly ? <>
          <Field data-invalid={libraryError ? true : undefined}>
            <LabelHint hint="Execute JavaScript nodes call the game entry's exports as extensions.<Library Name>."><FieldLabel htmlFor="extension-edit-libraryName">Library Name</FieldLabel></LabelHint>
            <Input id="extension-edit-libraryName" value={settings.libraryName} disabled={busy} aria-invalid={libraryError ? true : undefined} onChange={(event) => patch({ libraryName: event.target.value })} />
            {libraryError ? <FieldError>{libraryError}</FieldError> : null}
          </Field>
          <Field orientation="horizontal">
            <FieldContent><LabelHint hint="Shows the extension's assets folder in the Content Browser tree."><FieldLabel htmlFor="extension-edit-appearInContentBrowser">Appear In Content Browser</FieldLabel></LabelHint></FieldContent>
            <Switch id="extension-edit-appearInContentBrowser" checked={settings.appearInContentBrowser} disabled={busy} onCheckedChange={(checked) => patch({ appearInContentBrowser: checked === true })} />
          </Field>
        </> : null}
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
        <Field className="min-w-0">
          <LabelHint hint="What the extension adds to the editor, as JSON, such as a Project Settings category."><FieldLabel>Contributions</FieldLabel></LabelHint>
          <div className="flex h-48 min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border" role="group" aria-label="Contributions" data-testid="extension-contributions-editor">
            <LazyCodeBodyEditor language="javascript" ariaLabel="Contributions" value={contributes} readOnly={busy} onChange={setContributes} />
          </div>
        </Field>
        <Field className="min-w-0">
          <LabelHint hint={`Saved in extensions/${entry.folderName}/ in the project folder, so other code editors can open them. Files import each other with relative paths.`}><FieldLabel htmlFor="extension-edit-file">Code Files</FieldLabel></LabelHint>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select value={shownPath} onValueChange={(value) => setActivePath(String(value))}>
              <SelectTrigger id="extension-edit-file" size="sm" className="min-w-0 max-w-full sm:w-72" disabled={busy}>
                <SelectValue>{codeFileLabel(shownPath, settings)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {paths.map((path) => <SelectItem key={path} value={path}>{codeFileLabel(path, settings)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setNewFileOpen(true)}>New Code File</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(addFiles)}>Add Code File</Button>
            <Button variant="outline" size="sm" disabled={busy || !removable} onClick={() => setSources((previous) => { const next = new Map(previous); next.delete(shownPath); return next; })}>Remove Code File</Button>
          </div>
          {fileError ? <FieldError className="whitespace-pre-wrap">{fileError}</FieldError> : null}
          <div className="flex h-96 min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border" role="group" aria-label="Extension Source" data-testid="extension-source-editor">
            <LazyCodeBodyEditor key={shownPath} language="javascript" ariaLabel={`${shownPath} Source`} value={visible.get(shownPath) ?? ""} onChange={(value) => setSource(shownPath, value)} />
          </div>
        </Field>
      </FieldGroup>
      <ActionError message={error} />
      <DialogFooter><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" disabled={busy || !settings.displayName.trim() || !settings.version.trim() || Boolean(libraryError)} onClick={() => void run(save)}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      <NamePromptDialog open={newFileOpen} onOpenChange={setNewFileOpen} title="New Code File" label="File Name" confirmLabel="Create"
        validate={(name) => { const path = extensionCodeFilePath(name); return !path ? "Use a .ts or .js file name." : visible.has(path) ? `${path} already exists.` : null; }}
        onSubmit={(name) => { const path = extensionCodeFilePath(name)!; setSource(path, ""); setActivePath(path); setNewFileOpen(false); }} />
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
      <DialogHeader><DialogTitle>Export Extension</DialogTitle><DialogDescription>Save {entry.settings.displayName} as a file or add it to Engine Extensions for new projects.</DialogDescription></DialogHeader>
      <ActionError message={error} />
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { if ((await saveExtensionArchive(await service.export(entry.extensionGuid), entry.settings.displayName)) !== "cancelled") onClose(); })}>Export To File</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => install(await service.export(entry.extensionGuid)))}>Export To Engine Extensions</Button>
      </DialogFooter>
    </DialogContent></Dialog>
    <AlertDialog open={Boolean(conflict)} onOpenChange={(open) => { if (!open && !busy) setConflict(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Replace Engine Extension</AlertDialogTitle><AlertDialogDescription>{conflict?.existing.settings.displayName} already exists in Engine Extensions. Existing projects keep their copies.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (conflict) { const { bytes, existing } = conflict; setConflict(null); void run(() => install(bytes, existing.extensionGuid)); } }}>Replace</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
