import { useCallback, useEffect, useRef, useState } from "react";
import { SaveGameService, validateSaveGameDefinition, type SaveGameInfo, type SaveGameResult, type SaveGameValue } from "@babylonslate/core";
import { createSaveGameStorage, pickImportFiles } from "@babylonslate/vfs";
import { AssetPicker, AssetPickerControl } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { Switch } from "@babylonslate/ui/components/switch";
import { Badge } from "@babylonslate/ui/components/badge";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@babylonslate/ui/components/alert-dialog";
import { useDocuments } from "../context/document-context";

function resultValue<T>(result: SaveGameResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function displayValue(value: SaveGameValue): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return value.map(displayValue).join(", ") || "Empty Array";
  if (typeof value === "object") return Object.entries(value).map(([key, entry]) => `${key}: ${displayValue(entry)}`).join(" · ");
  return String(value);
}

function downloadSave(text: string, slot: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slot.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "save"}.babsave`;
    anchor.click();
  } finally { URL.revokeObjectURL(url); }
}

export function ProjectSaveGamesSettings() {
  const { projectDocument, projectGuid, updateProjectSettings, assetRegistry, registryEpoch, loadAssetDocument, openDocuments } = useDocuments();
  const settings = projectDocument?.settings.saveGame;
  const definitionAsset = settings?.definitionGuid ? assetRegistry?.getByGuid(settings.definitionGuid) : undefined;
  const openDefinition = openDocuments.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === definitionAsset?.path)?.content;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [service, setService] = useState<SaveGameService | null>(null);
  const [saves, setSaves] = useState<SaveGameInfo[]>([]);
  const [profile, setProfile] = useState(settings?.defaultProfile ?? "default");
  const [slot, setSlot] = useState(settings?.defaultSlot ?? "default");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{ slot: string; values: Record<string, SaveGameValue> } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SaveGameInfo | "all" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setService(null);
    setSaves([]);
    setInspection(null);
    setError(null);
    if (!projectGuid || !definitionAsset || !settings) return;
    void (async () => {
      try {
        const definition = validateSaveGameDefinition(openDefinition ?? await loadAssetDocument("save-game", definitionAsset.path));
        const next = new SaveGameService({ projectId: projectGuid, definition, preview: true, storage: createSaveGameStorage(), defaultProfile: settings.defaultProfile, defaultSlot: settings.defaultSlot });
        if (!cancelled) setService(next);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { cancelled = true; };
  }, [projectGuid, definitionAsset?.path, settings?.definitionGuid, settings?.defaultProfile, settings?.defaultSlot, registryEpoch, loadAssetDocument, openDefinition]); // eslint-disable-line react-hooks/exhaustive-deps -- depend on stable definition identity and settings values

  const refresh = useCallback(async () => {
    if (!service) return;
    setSaves(resultValue(await service.listSaves({ profile })));
  }, [service, profile]);

  useEffect(() => {
    let cancelled = false;
    if (service) void service.listSaves({ profile }).then((result) => {
      if (cancelled) return;
      if (result.ok) { setSaves(result.value); setError(null); }
      else setError(`${result.error.code}: ${result.error.message}`);
    });
    return () => { cancelled = true; };
  }, [service, profile]);

  const run = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  if (!settings) return null;
  const disabled = pending || !service;
  return <FieldGroup data-testid="settings-save-games-panel">
    <FieldSet>
      <FieldLegend>Save Games</FieldLegend>
      <Field><FieldLabel htmlFor="settings-save-definition">Default Definition</FieldLabel>
        <AssetPickerControl value={settings.definitionGuid}><Button id="settings-save-definition" variant="outline" className="w-full justify-start pointer-coarse:min-h-11" onClick={() => setPickerOpen(true)}>{definitionAsset?.header.name ?? "Choose Save Game"}</Button></AssetPickerControl>
        <FieldDescription>Create a Save Game asset with typed fields and defaults, then select it here. Save Game and Load Game use the default slot automatically.</FieldDescription>
      </Field>
      <Field><FieldLabel htmlFor="settings-save-slot">Default Slot</FieldLabel><Input id="settings-save-slot" value={settings.defaultSlot} onChange={(event) => updateProjectSettings({ saveGame: { ...settings, defaultSlot: event.target.value } })} /></Field>
      <Field><FieldLabel htmlFor="settings-save-profile">Default Profile</FieldLabel><Input id="settings-save-profile" value={settings.defaultProfile} onChange={(event) => updateProjectSettings({ saveGame: { ...settings, defaultProfile: event.target.value } })} /></Field>
      <Field orientation="horizontal"><FieldContent><FieldLabel htmlFor="settings-save-wipe-on-play">Wipe Preview Saves On Play</FieldLabel><FieldDescription>Clear this project's local preview profiles before each Play session. Exported game saves use a separate namespace.</FieldDescription></FieldContent><Switch id="settings-save-wipe-on-play" checked={settings.wipeOnPlay} onCheckedChange={(wipeOnPlay) => updateProjectSettings({ saveGame: { ...settings, wipeOnPlay } })} /></Field>
    </FieldSet>
    <FieldSet>
      <FieldLegend>Preview Saves</FieldLegend>
      <FieldDescription>Inspect and manage this project's editor Play data on this device. Browser data can be cleared by the browser or user; export saves you need to keep.</FieldDescription>
      <div className="flex flex-wrap gap-3"><Field className="min-w-36 flex-1"><FieldLabel htmlFor="save-manager-profile">Profile</FieldLabel><Input id="save-manager-profile" value={profile} disabled={pending} onChange={(event) => setProfile(event.target.value)} /></Field><Field className="min-w-36 flex-1"><FieldLabel htmlFor="save-manager-slot">Import Slot</FieldLabel><Input id="save-manager-slot" value={slot} disabled={pending} onChange={(event) => setSlot(event.target.value)} /></Field></div>
      {error ? <Alert variant="destructive"><AlertTitle>Save Action Failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {pending ? <p role="status">Working…</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void run(refresh)}>Refresh Saves</Button>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void run(async () => {
          const [file] = await pickImportFiles({ multiple: false, accept: ".babsave,.json" });
          if (!file || !service) return;
          const info = resultValue(await service.importSave(new TextDecoder().decode(file.bytes), { profile, slot }));
          setNotice(`Imported ${info.slot}.`);
          await refresh();
        })}>Import Save</Button>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => setDeleteTarget("all")}>Reset Preview Saves</Button>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void run(async () => {
          if (service) setNotice(resultValue(await service.requestPersistence()) ? "Persistent storage granted for this origin." : "Persistent storage was not granted. Keep exported backups.");
        })}>Request Persistent Storage</Button>
      </div>
      {!saves.length ? <Empty><EmptyHeader><EmptyTitle>{service ? "No Preview Saves" : "Choose A Save Definition"}</EmptyTitle><EmptyDescription>{service ? "Save from Play or import a save to inspect it here." : "Select the project's default Save Game asset to manage its preview saves."}</EmptyDescription></EmptyHeader></Empty> : saves.map((save) => <Field key={`${save.profile}:${save.slot}`} className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{save.slot}</span><Badge variant="outline">{save.status === "ok" ? save.recovered ? "Recovered" : "Valid" : save.status === "corrupt" ? "Corrupt" : "Incompatible"}</Badge></div>
        <FieldDescription>{save.createdAt ? `${new Date(save.createdAt).toLocaleString()} · Schema ${save.schemaVersion} · Generation ${save.sequence}` : save.error?.message}</FieldDescription>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled || save.status !== "ok"} aria-label={`Inspect ${save.slot}`} onClick={() => void run(async () => { if (!service) return; resultValue(await service.loadGame(save)); setInspection({ slot: save.slot, values: structuredClone(service.getSaveData()) }); })}>Inspect</Button>
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled || save.status === "corrupt"} aria-label={`Export ${save.slot}`} onClick={() => void run(async () => { if (service) downloadSave(resultValue(await service.exportSave(save)), save.slot); })}>Export Save</Button>
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} aria-label={`Delete ${save.slot}`} onClick={() => setDeleteTarget(save)}>Delete Save</Button>
        </div>
      </Field>)}
      {inspection ? <FieldSet className="rounded-md border border-border p-3"><FieldLegend>Saved Fields · {inspection.slot}</FieldLegend>{Object.entries(inspection.values).map(([name, value]) => <Field key={name}><FieldLabel>{name}</FieldLabel><p className="select-text break-words text-sm">{displayValue(value)}</p></Field>)}{Object.keys(inspection.values).length === 0 ? <FieldDescription>No custom fields in this save.</FieldDescription> : null}</FieldSet> : null}
    </FieldSet>
    <AssetPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Save Game" assets={(assetRegistry?.list() ?? []).map((entry) => ({ guid: entry.header.guid, name: entry.header.name, type: entry.header.type, path: entry.path }))} allowedTypes={["SaveGame"]} allowNone createOptions={{ ownerPath: "project.babproject" }} onPick={(definitionGuid) => { updateProjectSettings({ saveGame: { ...settings, definitionGuid } }); setPickerOpen(false); }} />
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}><AlertDialogContent variant="destructive"><AlertDialogHeader><AlertDialogTitle>{deleteTarget === "all" ? "Reset Preview Saves" : "Delete Save"}</AlertDialogTitle><AlertDialogDescription>{deleteTarget === "all" ? "Permanently delete every editor preview save profile for this project on this device. Exported game saves are separate. This cannot be undone." : `Permanently delete ${deleteTarget?.slot ?? "this save"} and both recovery generations. This cannot be undone.`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => {
      const target = deleteTarget; setDeleteTarget(null);
      void run(async () => { if (!service || !target) return; resultValue(await (target === "all" ? service.resetLocalSaves() : service.deleteSave(target))); setInspection(null); await refresh(); setNotice(target === "all" ? "Preview saves reset." : "Save deleted."); });
    }}>{deleteTarget === "all" ? "Reset Saves" : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </FieldGroup>;
}
