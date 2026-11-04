import { useCallback, useEffect, useRef, useState } from "react";
import { SaveGameService, createDefaultSaveGameDefinition, documentId, validateSaveGameId, type SaveGameInfo, type SaveGameResult, type SaveGameValue } from "@haptic/core";
import { createSaveGameStorage, pickImportFiles } from "@haptic/vfs";
import { AssetPicker, AssetPickerControl, LabelHint } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Input } from "@haptic/ui/components/input";
import { Switch } from "@haptic/ui/components/switch";
import { Badge } from "@haptic/ui/components/badge";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@haptic/ui/components/field";
import { SettingsSection } from "./settings-section";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@haptic/ui/components/alert-dialog";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { downloadBlob } from "../lib/download";
import { requireSaveGameDefinition } from "../lib/save-game-catalog";
import { useDataCatalog } from "../lib/use-data-catalog";

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

/**
 * Play's service rejects a default it cannot store; the preview service below never receives the defaults.
 * The core check decides; its message covers every kind of save ID, so name the field instead.
 */
function saveIdError(label: string, value: string): string | null {
  try { validateSaveGameId(value); return null; }
  catch {
    if (!value.trim()) return `${label} must not be empty.`;
    try { encodeURIComponent(value); } catch { return `${label} contains characters a save cannot store.`; }
    return `${label} is too long to store.`;
  }
}

function downloadSave(text: string, slot: string) {
  downloadBlob(
    new Blob([text], { type: "application/json" }),
    `${slot.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "save"}.babsave`,
  );
}

export function ProjectSaveGamesSettings() {
  const { updateProjectSettings, loadAssetDocument } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { projectGuid, assetRegistry, registryEpoch } = useRegistryState();
  const settings = projectDocument?.settings.saveGame;
  const definitionAsset = settings?.definitionGuid ? assetRegistry?.getByGuid(settings.definitionGuid) : undefined;
  const openDefinition = useOpenDocument(
    definitionAsset ? documentId({ kind: "save-game", path: definitionAsset.path }) : null,
  )?.content;
  // A linked Save Game's fields come from its Data Definition: rebuild when Data Definition content changes,
  // not whenever the type catalog is recomputed.
  const schemas = useDataCatalog().schemas;
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;
  const dataDefinitionsKey = JSON.stringify(schemas.dataDefinitions ?? {});
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
  // Advanced whenever an effect clears the inspection, so an Inspect still loading then cannot bring back a stale save.
  const inspectionGeneration = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<SaveGameInfo | "all" | null>(null);

  useEffect(() => { setProfile(settings?.defaultProfile ?? "default"); }, [projectGuid, settings?.defaultProfile]);
  useEffect(() => { setSlot(settings?.defaultSlot ?? "default"); }, [projectGuid, settings?.defaultSlot]);

  useEffect(() => {
    let cancelled = false;
    setService(null);
    setSaves([]);
    inspectionGeneration.current += 1;
    setInspection(null);
    setError(null);
    if (!projectGuid || !definitionAsset || !settings) return;
    void (async () => {
      try {
        const definition = requireSaveGameDefinition(openDefinition ?? await loadAssetDocument("save-game", definitionAsset.path), schemasRef.current);
        // Every call below names its profile and slot, so editing the defaults never rebuilds this service.
        const next = new SaveGameService({ projectId: projectGuid, definition, preview: true, storage: createSaveGameStorage() });
        if (!cancelled) setService(next);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { cancelled = true; };
  }, [projectGuid, definitionAsset?.path, settings?.definitionGuid, registryEpoch, loadAssetDocument, openDefinition, dataDefinitionsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- depend on stable definition identity, not the settings object

  const refresh = useCallback(async () => {
    if (!service) return;
    setSaves(resultValue(await service.listSaves({ profile })));
  }, [service, profile]);

  useEffect(() => {
    let cancelled = false;
    // An open inspection belongs to the profile it was loaded from.
    inspectionGeneration.current += 1;
    setInspection(null);
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
  const defaultSlotError = saveIdError("Default Slot", settings.defaultSlot);
  const defaultProfileError = saveIdError("Default Profile", settings.defaultProfile);
  return <FieldGroup className="min-w-0" data-testid="settings-save-games-panel">
    <SettingsSection id="defaults" title="Defaults">
      <Field className="settings-field"><LabelHint hint="The Save Game asset that defines the typed fields and defaults saves use. Save Game and Load Game use the Default Slot automatically."><FieldLabel htmlFor="settings-save-definition">Default Definition</FieldLabel></LabelHint>
        <AssetPickerControl value={settings.definitionGuid}><Button id="settings-save-definition" variant="outline" className="w-full justify-start pointer-coarse:min-h-11" onClick={() => setPickerOpen(true)}>{definitionAsset?.header.name ?? "Choose Save Game"}</Button></AssetPickerControl>
      </Field>
      <Field className="settings-field" data-invalid={defaultSlotError ? true : undefined}><FieldLabel htmlFor="settings-save-slot">Default Slot</FieldLabel><div className="flex min-w-0 flex-col gap-1"><Input id="settings-save-slot" value={settings.defaultSlot} aria-invalid={defaultSlotError ? true : undefined} aria-describedby={defaultSlotError ? "settings-save-slot-error" : undefined} onChange={(event) => updateProjectSettings({ saveGame: { ...settings, defaultSlot: event.target.value } })} />{defaultSlotError ? <FieldError id="settings-save-slot-error">{defaultSlotError}</FieldError> : null}</div></Field>
      <Field className="settings-field" data-invalid={defaultProfileError ? true : undefined}><FieldLabel htmlFor="settings-save-profile">Default Profile</FieldLabel><div className="flex min-w-0 flex-col gap-1"><Input id="settings-save-profile" value={settings.defaultProfile} aria-invalid={defaultProfileError ? true : undefined} aria-describedby={defaultProfileError ? "settings-save-profile-error" : undefined} onChange={(event) => updateProjectSettings({ saveGame: { ...settings, defaultProfile: event.target.value } })} />{defaultProfileError ? <FieldError id="settings-save-profile-error">{defaultProfileError}</FieldError> : null}</div></Field>
    </SettingsSection>
    <SettingsSection id="previewSaves" title="Preview Saves">
      <Field orientation="horizontal" className="settings-field"><LabelHint hint="Clears this project's local preview profiles before each Play session. Exported game saves are kept separately."><FieldLabel htmlFor="settings-save-wipe-on-play">Wipe Preview Saves On Play</FieldLabel></LabelHint><Switch id="settings-save-wipe-on-play" checked={settings.wipeOnPlay} onCheckedChange={(wipeOnPlay) => updateProjectSettings({ saveGame: { ...settings, wipeOnPlay } })} /></Field>
      <div className="settings-row flex min-w-0 flex-col gap-3">
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
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={pending || !projectGuid} onClick={() => setDeleteTarget("all")}>Reset Preview Saves</Button>
        <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void run(async () => {
          if (service) setNotice(resultValue(await service.requestPersistence()) ? "Persistent storage granted for this origin." : "Persistent storage was not granted. Keep exported backups.");
        })}>Request Persistent Storage</Button>
      </div>
      {!saves.length ? <Empty><EmptyHeader><EmptyTitle>{service ? "No Preview Saves" : "Choose A Save Definition"}</EmptyTitle><EmptyDescription>{service ? "Save from Play or import a save to inspect it here." : "Select the project's default Save Game asset to inspect or import saves. Reset remains available without a definition."}</EmptyDescription></EmptyHeader></Empty> : saves.map((save) => <Field key={`${save.profile}:${save.slot}`} className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{save.slot}</span><Badge variant="outline">{save.status === "ok" ? save.recovered ? "Recovered" : "Valid" : save.status === "corrupt" ? "Corrupt" : "Incompatible"}</Badge></div>
        <FieldDescription>{save.createdAt ? `${new Date(save.createdAt).toLocaleString()} · Schema ${save.schemaVersion} · Generation ${save.sequence}` : save.error?.message}</FieldDescription>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled || save.status !== "ok"} aria-label={`Inspect ${save.slot}`} onClick={() => void run(async () => {
            if (!service) return;
            const generation = inspectionGeneration.current;
            resultValue(await service.loadGame(save));
            // A Default Profile edit or a new definition while it loaded already cleared the inspection.
            if (inspectionGeneration.current !== generation) return;
            setInspection({ slot: save.slot, values: structuredClone(service.getSaveData()) });
          })}>Inspect</Button>
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled || save.status === "corrupt"} aria-label={`Export ${save.slot}`} onClick={() => void run(async () => { if (service) downloadSave(resultValue(await service.exportSave(save)), save.slot); })}>Export Save</Button>
          <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={disabled} aria-label={`Delete ${save.slot}`} onClick={() => setDeleteTarget(save)}>Delete Save</Button>
        </div>
      </Field>)}
      {inspection ? <FieldSet className="rounded-md border border-border p-3"><FieldLegend>Saved Fields · {inspection.slot}</FieldLegend>{Object.entries(inspection.values).map(([name, value]) => <Field key={name}><FieldLabel>{name}</FieldLabel><p className="select-text break-words text-sm">{displayValue(value)}</p></Field>)}{Object.keys(inspection.values).length === 0 ? <FieldDescription>No custom fields in this save.</FieldDescription> : null}</FieldSet> : null}
      </div>
    </SettingsSection>
    <AssetPicker open={pickerOpen} onOpenChange={setPickerOpen} title="Pick Save Game" assets={(assetRegistry?.list() ?? []).map((entry) => ({ guid: entry.header.guid, name: entry.header.name, type: entry.header.type, path: entry.path }))} allowedTypes={["SaveGame"]} allowNone createOptions={{ ownerPath: null }} onPick={(definitionGuid) => { updateProjectSettings({ saveGame: { ...settings, definitionGuid } }); setPickerOpen(false); }} />
    <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}><AlertDialogContent variant="destructive"><AlertDialogHeader><AlertDialogTitle>{deleteTarget === "all" ? "Reset Preview Saves" : "Delete Save"}</AlertDialogTitle><AlertDialogDescription>{deleteTarget === "all" ? "Permanently delete every editor preview save profile for this project on this device. Exported game saves are separate. This cannot be undone." : `Permanently delete ${deleteTarget?.slot ?? "this save"} and both recovery generations. This cannot be undone.`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => {
      const target = deleteTarget; setDeleteTarget(null);
      void run(async () => {
        if (!target || !projectGuid) return;
        // Reset needs only the project's namespace. This service never inspects,
        // imports, loads, or saves data using a substituted definition.
        const manager = service ?? (target === "all" ? new SaveGameService({
          projectId: projectGuid, preview: true, storage: createSaveGameStorage(),
          definition: createDefaultSaveGameDefinition("editor-preview-reset"),
        }) : null);
        if (!manager) return;
        resultValue(await (target === "all" ? manager.resetLocalSaves() : manager.deleteSave(target)));
        setInspection(null);
        if (target === "all") setSaves([]);
        await refresh();
        setNotice(target === "all" ? "Preview saves reset." : "Save deleted.");
      });
    }}>{deleteTarget === "all" ? "Reset Saves" : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </FieldGroup>;
}
