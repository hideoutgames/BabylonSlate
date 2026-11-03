import { useEffect, useState } from "react";
import { isParticleEmitterAssetType, type ParticleLibraryEmitter } from "@haptic/assets";
import { particleGraphSpawnEmitters, type ParticleGraphDocument } from "@haptic/particle-graph";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";
import { loadSpawnedEmittersForPreview } from "./play-particles";

const EMITTER_KINDS = ["particle-emitter", "particle-graph"] as const;
const NONE: ReadonlyMap<string, ParticleLibraryEmitter> = new Map();

/**
 * The emitters a previewed Particle Graph's Spawn Emitters play, from open tabs or document
 * chunks, two levels deep. Empty until they load (the preview runs without spawns meanwhile);
 * reloads when the graph spawns other emitters or an emitter tab changes.
 */
export function useSpawnPreviewEmitters(document: ParticleGraphDocument | null): ReadonlyMap<string, ParticleLibraryEmitter> {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const open = useOpenDocumentsOfKinds(EMITTER_KINDS);
  const [emitters, setEmitters] = useState(NONE);
  const key = document ? particleGraphSpawnEmitters(document.nodes).join(",") : "";

  useEffect(() => {
    if (!document || !key) {
      setEmitters(NONE);
      return;
    }
    let cancelled = false;
    const assets = (assetRegistry?.list() ?? []).filter((asset) => isParticleEmitterAssetType(asset.header.type));
    const openPayloads = new Map<string, unknown>();
    for (const asset of assets) {
      const tab = open.find((entry) => entry.ref.path === asset.path);
      if (tab?.content) openPayloads.set(asset.header.guid, tab.content);
    }
    void loadSpawnedEmittersForPreview([{ kind: "graph", document }], {
      assets,
      openPayloads,
      loadDocument: (kind, path) => loadAssetDocument ? loadAssetDocument(kind, path) : Promise.resolve(null),
    }).then(
      (loaded) => { if (!cancelled) setEmitters(loaded); },
      () => { if (!cancelled) setEmitters(NONE); },
    );
    return () => {
      cancelled = true;
    };
    // `document` changes on every edit; only the emitters it spawns (`key`) and the open tabs matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, loadAssetDocument, assetRegistry]);
  return emitters;
}
