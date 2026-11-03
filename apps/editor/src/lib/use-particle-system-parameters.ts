import { useEffect, useMemo, useState } from "react";
import type { SerializedComponent } from "@haptic/core";
import {
  normalizeParticleSystemPayload,
  particleSystemParameters,
  type ParticleSystemParameter,
} from "@haptic/assets";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { loadEmittersForPreview, PREVIEW_SYSTEM_GUID, systemPreviewLibrary } from "./play-particles";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const PARTICLE_DOCUMENT_KINDS = ["particle-system", "particle-emitter", "particle-graph"] as const;

/** The sorted, unique Particle Systems an actor's (or Prefab's) Particle components play. */
export function particleSystemGuidsOf(owner: { components: readonly SerializedComponent[] } | null | undefined): string[] {
  const guids = new Set<string>();
  for (const component of owner?.components ?? []) {
    const guid = component.classId === "ParticleComponent" ? component.properties.particleSystemGuid : null;
    if (typeof guid === "string" && guid) guids.add(guid);
  }
  return [...guids].sort();
}

/**
 * Each listed Particle System's derived parameters (`particleSystemParameters`), from open tabs
 * first, else loaded from the project. A System is missing from the map until it has loaded;
 * open particle tabs refetch, so unsaved edits show at once. Pass a stable, sorted guid list.
 */
export function useParticleSystemParameters(systemGuids: readonly string[]): ReadonlyMap<string, readonly ParticleSystemParameter[]> {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const openDocuments = useOpenDocumentsOfKinds(PARTICLE_DOCUMENT_KINDS);
  const [parameters, setParameters] = useState<ReadonlyMap<string, readonly ParticleSystemParameter[]>>(new Map());
  const key = systemGuids.join(",");
  const guids = useMemo(() => (key ? key.split(",") : []), [key]);

  useEffect(() => {
    let cancelled = false;
    const assets = assetRegistry?.list() ?? [];
    const openPayloads = new Map<string, unknown>();
    for (const asset of assets) {
      const doc = openDocuments.find((entry) => entry.ref.path === asset.path);
      if (doc?.content) openPayloads.set(asset.header.guid, doc.content);
    }
    const load = loadAssetDocument ?? (() => Promise.resolve(null));
    void Promise.all(guids.map(async (guid): Promise<[string, readonly ParticleSystemParameter[]]> => {
      const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "ParticleSystem");
      if (!asset) return [guid, []];
      const system = normalizeParticleSystemPayload(openPayloads.get(guid) ?? (await load("particle-system", asset.path)));
      const emitters = await loadEmittersForPreview({ system, assets, openPayloads, loadDocument: load });
      return [guid, particleSystemParameters(systemPreviewLibrary(system, emitters), PREVIEW_SYSTEM_GUID).parameters];
    })).then((entries) => {
      if (!cancelled) setParameters((previous) => keepIfSame(previous, new Map(entries)));
    }, () => {
      // A System that cannot load lists no parameters; its Inspector row already reports the asset.
      if (!cancelled) setParameters((previous) => keepIfSame(previous, new Map(guids.map((guid) => [guid, []]))));
    });
    return () => { cancelled = true; };
  }, [guids, openDocuments, loadAssetDocument, assetRegistry, registryEpoch]);

  return parameters;
}

/** The previous map when nothing changed, so an idle refetch never re-renders the Inspector. */
function keepIfSame<T>(previous: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  if (previous.size !== next.size) return next;
  for (const [key, value] of next) if (JSON.stringify(previous.get(key)) !== JSON.stringify(value)) return next;
  return previous;
}
