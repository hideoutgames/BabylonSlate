import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Mesh, type AbstractEngine } from "@babylonjs/core";
import {
  installedAssetIdentity,
  modelMaterialGuids,
  type ModelMaterialSlot,
} from "@haptic/assets";
import {
  MaterialLibrary,
  acquireMaterialTexture,
  applyModelMaterialSlots,
  bindResourceCacheToHandle,
  installTextureBytes,
  materialTextureSampling,
  materialUnavailable,
  prewarmMaterial,
  resourceCacheForEngine,
  visualMeshes,
  type MaterialPreviewScene,
} from "@haptic/render";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { savedMaterialLibraryKey } from "./material-asset-revision";
import { useEditorViewportPrefs } from "./viewport-engine-prefs";

/**
 * Compile a Model's slot Materials from the saved documents on a preview host and draw its meshes with them.
 * Each host generation replaces the previous Materials; the caller calls `release` before disposing the host.
 */
export function useModelSlotMaterials({
  hostRef,
  engine,
  slots,
  generation,
  onApplied,
}: {
  hostRef: RefObject<MaterialPreviewScene | null>;
  engine: AbstractEngine | null;
  slots: readonly Pick<ModelMaterialSlot, "index" | "name" | "materialGuid">[];
  generation: number;
  onApplied: () => void;
}): { ready: boolean; error: string | null; release: () => void } {
  const { collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const { editorTextureLodEnabled, editorTextureLodQuality } = useEditorViewportPrefs();
  const materialRevision = savedMaterialLibraryKey(assetRegistry?.list() ?? []);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerRef = useRef<(() => void) | null>(null);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const slotKey = JSON.stringify(slots);
  const release = useCallback(() => {
    ownerRef.current?.();
    ownerRef.current = null;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !engine) return;
    let cancelled = false;
    const current = JSON.parse(slotKey) as ModelMaterialSlot[];
    setReady(false);
    let releaseCandidate: (() => void) | undefined;
    let published = false;
    void (async () => {
      try {
        const materials = await collectPlayMaterialLibrary(
          undefined,
          [],
          modelMaterialGuids({ materialSlots: current, clipNames: [] }),
        );
        const textureBytes = installTextureBytes(await collectPlayTextureBytes(
          new Map(),
          new Map(),
          materials.textureGuids,
        ))!;
        if (cancelled || hostRef.current !== host) return;
        const lease = bindResourceCacheToHandle(resourceCacheForEngine(engine));
        const library = new MaterialLibrary({
          textureIdentity: (guid) => { const source = textureBytes.get(guid); return source ? installedAssetIdentity(source) : undefined; },
          functions: () => Object.fromEntries(materials.functions),
          acquireTexture: (guid, _scene, filter) => {
            const data = textureBytes.get(guid);
            if (!data) return null;
            return acquireMaterialTexture(lease.cache, guid, engine, data, materialTextureSampling(filter));
          },
        });
        releaseCandidate = () => { library.dispose(); lease.dispose(); };
        for (const [guid, document] of materials.documents) {
          const acquired = library.acquire(host.scene, guid, document);
          if (materialUnavailable(acquired)) throw new Error(acquired.diagnostics.map((d) => d.message).join("; "));
          const errors = await acquired.ready;
          if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
          for (const mesh of visualMeshes(host.mesh)) {
            if (mesh instanceof Mesh) await prewarmMaterial(acquired.material, mesh);
          }
          if (cancelled || hostRef.current !== host) return;
        }
        applyModelMaterialSlots(host.mesh, current, (guid) =>
          library.materialFor(host.scene, guid),
        );
        const previous = ownerRef.current;
        ownerRef.current = releaseCandidate;
        published = true;
        setReady(true);
        previous?.();
        setError(null);
        onAppliedRef.current();
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!published) { releaseCandidate?.(); releaseCandidate = undefined; }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    engine,
    generation,
    hostRef,
    slotKey,
    materialRevision,
    editorTextureLodEnabled,
    editorTextureLodQuality,
  ]);

  return { ready, error, release };
}
