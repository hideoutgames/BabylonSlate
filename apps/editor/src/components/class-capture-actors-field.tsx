import { useEffect, useMemo, useState } from "react";
import { AssetPicker, PropertyGrid, type AssetPickerEntry } from "@babylonslate/editor-kit";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";
import { useActiveDocumentId, useDocumentActions, useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { RenderTargetCaptureActorsField } from "./render-target-capture-actors-field";

const SCENE_KINDS = ["scene"] as const;
const NO_ACTORS: readonly SerializedActor[] = [];
const NO_CREATE_TYPES: readonly string[] = [];

function sceneActors(content: unknown): readonly SerializedActor[] {
  const actors = (content as Partial<SerializedScene> | null | undefined)?.actors;
  return Array.isArray(actors) ? actors : NO_ACTORS;
}

/**
 * Class Details capture actors, picked from an explicit **Source Scene**. The
 * Scene is editor state, not component data: it follows the active Scene tab,
 * else the first open Scene, until the user picks one. An open Scene supplies
 * its unsaved actors; any other Scene is read without opening a tab.
 */
export function ClassCaptureActorsField({ actorIds, onChange }: {
  actorIds: readonly string[];
  onChange: (actorIds: string[]) => void;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { loadAssetDocument } = useDocumentActions();
  const activeDocumentId = useActiveDocumentId();
  const openScenes = useOpenDocumentsOfKinds(SCENE_KINDS);
  const scenes = useMemo<AssetPickerEntry[]>(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? [])
      .filter((asset) => asset.header.type === "Scene")
      .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  }, [assetRegistry, registryEpoch]);
  // `undefined` follows the open Scene; a pick (guid) stays until changed.
  const [pickedGuid, setPickedGuid] = useState<string | null>();
  const [picking, setPicking] = useState(false);
  const defaultPath = (openScenes.find((doc) => doc.id === activeDocumentId) ?? openScenes[0])?.ref.path ?? null;
  const selected = pickedGuid === undefined
    ? scenes.find((entry) => entry.path === defaultPath)
    : scenes.find((entry) => entry.guid === pickedGuid);
  const selectedPath = selected?.path ?? (pickedGuid === undefined ? defaultPath : null);
  const openContent = openScenes.find((doc) => doc.ref.path === selectedPath)?.content ?? null;
  const [loaded, setLoaded] = useState<{ path: string; actors: readonly SerializedActor[] } | null>(null);
  useEffect(() => {
    if (!selectedPath || openContent) return;
    let canceled = false;
    void loadAssetDocument("scene", selectedPath).then((content) => {
      if (!canceled) setLoaded({ path: selectedPath, actors: sceneActors(content) });
    });
    return () => { canceled = true; };
    // A saved Scene advances the registry epoch, so its actors reload.
  }, [selectedPath, openContent, loadAssetDocument, registryEpoch]);
  const actors = openContent ? sceneActors(openContent)
    : loaded && loaded.path === selectedPath ? loaded.actors : NO_ACTORS;
  return <>
    <RenderTargetCaptureActorsField actorIds={actorIds} actors={actors} onChange={onChange}
      source={<PropertyGrid density="compact" rows={[{
        id: "capture-source-scene", kind: "asset", label: "Source Scene", value: selected?.guid ?? null,
        description: "Which Scene's actors to list. Not saved.",
        displayLabel: selected?.name, displayType: "Scene", visual: { assetType: "Scene" },
        placeholder: "None", onPick: () => setPicking(true), onChange: (guid) => setPickedGuid(guid),
      }]} />} />
    <AssetPicker open={picking} onOpenChange={setPicking} assets={scenes} allowedTypes={["Scene"]} createTypes={NO_CREATE_TYPES}
      allowNone={false} title="Pick Source Scene"
      onPick={(guid) => { setPickedGuid(guid); setPicking(false); }}
      data-testid="capture-source-scene-picker" />
  </>;
}
