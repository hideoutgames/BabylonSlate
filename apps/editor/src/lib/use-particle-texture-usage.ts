import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sniffImageSize, type ImageSize } from "@babylonslate/assets";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { useDocuments } from "../context/document-context";
import { TextureUsageChangedError } from "./asset-settings";
import {
  SET_PARTICLE_USAGE_LABEL,
  particleMaterialTextureSamples,
  particleTextureUsageWarnings,
  type MaterialTextureSample,
  type ParticleTextureUsageWarning,
} from "./particle-texture-usage";

const NO_SAMPLES: MaterialTextureSample[] = [];

/**
 * Decoded sizes of sampled Textures whose header stores none (extracted from
 * a Model), read from the `pixels` chunk the encoder decodes. Keyed by that
 * chunk's hash, so each source is read once; a failed read retries on the
 * next registry change.
 */
function useUnsizedTextureSourceSizes(
  samples: readonly MaterialTextureSample[],
): ReadonlyMap<string, ImageSize | null | undefined> {
  const { assetRegistry, readAssetChunk, registryVersion } = useDocuments();
  const unsized = useMemo(() => {
    void registryVersion; // Registry headers mutate in place.
    if (!assetRegistry) return [];
    return samples.flatMap((sample) => {
      const asset = assetRegistry.getByGuid(sample.textureGuid);
      if (asset?.header.type !== "Texture") return [];
      const { width, height } = asset.header.payload;
      if (typeof width === "number" && typeof height === "number") return [];
      const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels");
      if (!pixels) return [];
      return [{
        guid: sample.textureGuid,
        key: `${sample.textureGuid}:${pixels.sha256}`,
        path: asset.path,
        chunkId: pixels.id,
      }];
    });
  }, [assetRegistry, registryVersion, samples]);
  const [sizes, setSizes] = useState<ReadonlyMap<string, ImageSize | null>>(
    () => new Map(),
  );
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of unsized) {
      if (requested.current.has(entry.key)) continue;
      requested.current.add(entry.key);
      readAssetChunk(entry.path, entry.chunkId).then(
        (bytes) => {
          const size = bytes ? sniffImageSize(bytes) : null;
          setSizes((previous) => new Map(previous).set(entry.key, size));
        },
        () => {
          requested.current.delete(entry.key);
        },
      );
    }
  }, [readAssetChunk, unsized]);
  return useMemo(
    () => new Map(unsized.map((entry) => [entry.guid, sizes.get(entry.key)])),
    [sizes, unsized],
  );
}

/**
 * Warnings for the Textures in `samples`. Recomputed when the registry
 * changes (a save or encode) or an open Texture tab is edited, so a warning
 * clears as soon as the Usage is Particle.
 */
function useTextureUsageWarnings(
  samples: readonly MaterialTextureSample[],
): ParticleTextureUsageWarning[] {
  const { assetRegistry, openDocuments, registryVersion } = useDocuments();
  const sourceSizes = useUnsizedTextureSourceSizes(samples);
  return useMemo(() => {
    void registryVersion; // Registry payloads mutate in place.
    if (!assetRegistry || samples.length === 0) return [];
    return particleTextureUsageWarnings(samples, {
      textureByGuid: (guid) => assetRegistry.getByGuid(guid) ?? undefined,
      openDocuments,
      projectMax: assetRegistry.textureEncodeMaxDimension,
      sourceSize: (guid) => sourceSizes.get(guid),
    });
  }, [assetRegistry, openDocuments, registryVersion, samples, sourceSizes]);
}

/**
 * A warning row, with the one-click fix unless the Texture cannot change.
 * The fix is disabled while it, or its notification's Undo, is running.
 */
export type ParticleTextureUsageRow = ParticleTextureUsageWarning & {
  action?: { label: string; onClick: () => void; disabled: boolean };
};

/** What a fix did, shown until its Undo succeeds, it is dismissed, or the panel closes. */
export interface TextureUsageNotification {
  textureGuid: string;
  message: string;
  /** A save or Undo failed; the message says why. */
  failed: boolean;
  /** Present while the change can still be undone. */
  undo?: () => void;
  undoing: boolean;
  dismiss: () => void;
}

interface FixedTexture {
  name: string;
  previousUsage: string;
  message: string;
  undoError?: string;
  /** A save failed, or the Undo was dropped; the message says why. */
  failed: boolean;
  canUndo: boolean;
  undoing: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Warnings as diagnostic rows with the one-click **Set Usage To Particle**
 * fix (`setTextureUsage`: an open Texture tab takes an undoable edit and is
 * saved, a closed Texture is saved directly), plus a notification for each
 * fix with an **Undo** that restores the previous Usage the same way, only
 * while the Texture still uses Particle. A read-only or locked Texture gets
 * the reason instead of the action; a failed fix says why on its row, a
 * failed Undo on its notification.
 */
export function useTextureUsageFix(warnings: readonly ParticleTextureUsageWarning[]): {
  rows: ParticleTextureUsageRow[];
  notifications: TextureUsageNotification[];
} {
  const { setTextureUsage, textureUsageBlockedReason } = useDocuments();
  // Read while rendering: locks and open tabs change without new warnings.
  const blocked = useStableElements(
    warnings.map((warning) => textureUsageBlockedReason(warning.textureGuid)),
  );
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const setFailure = useCallback((guid: string, failure: string | null) => {
    setFailures((previous) => {
      if ((previous.get(guid) ?? null) === failure) return previous;
      const next = new Map(previous);
      if (failure) next.set(guid, failure);
      else next.delete(guid);
      return next;
    });
  }, []);
  const [fixed, setFixed] = useState<ReadonlyMap<string, FixedTexture>>(
    () => new Map(),
  );
  const fixedRef = useRef(fixed);
  fixedRef.current = fixed;
  const undoingRef = useRef(new Set<string>());
  const setFixedTexture = useCallback((guid: string, entry: FixedTexture | null) => {
    setFixed((previous) => {
      const next = new Map(previous);
      if (entry) next.set(guid, entry);
      else next.delete(guid);
      return next;
    });
  }, []);
  // Fixes in flight: the ref refuses a second click before the row re-renders.
  const [fixing, setFixing] = useState<ReadonlySet<string>>(() => new Set());
  const fixingRef = useRef(new Set<string>());
  const apply = useCallback(
    async (guid: string, name: string) => {
      if (fixingRef.current.has(guid)) return;
      fixingRef.current.add(guid);
      setFixing(new Set(fixingRef.current));
      setFailure(guid, null);
      try {
        // Null: the Texture already uses Particle, so there is nothing to fix.
        const change = await setTextureUsage(guid, "particle");
        if (!change) return;
        const message = change.saveError
          ? `Texture "${name}" now uses Particle Usage in its open tab, which could not be saved: ${change.saveError}`
          : `Texture "${name}" now uses Particle Usage.`;
        setFixedTexture(guid, {
          name,
          previousUsage: change.previousUsage,
          message,
          failed: Boolean(change.saveError),
          canUndo: true,
          undoing: false,
        });
      } catch (error) {
        setFailure(guid, `Its Usage could not be changed: ${errorText(error)}`);
      } finally {
        fixingRef.current.delete(guid);
        setFixing(new Set(fixingRef.current));
      }
    },
    [setFailure, setFixedTexture, setTextureUsage],
  );
  const undo = useCallback(
    async (guid: string) => {
      const entry = fixedRef.current.get(guid);
      if (!entry?.canUndo || undoingRef.current.has(guid)) return;
      undoingRef.current.add(guid);
      const pending = { ...entry, undoError: undefined, undoing: true };
      setFixedTexture(guid, pending);
      // Leave the notification alone if it was dismissed or replaced meanwhile.
      const settle = (next: FixedTexture | null) =>
        setFixed((previous) => {
          if (previous.get(guid) !== pending) return previous;
          const map = new Map(previous);
          if (next) map.set(guid, next);
          else map.delete(guid);
          return map;
        });
      try {
        // Only over the fix's own Particle, so a later Usage change is kept.
        // Null: nothing left to restore (already restored, or the Texture is gone).
        const change = await setTextureUsage(guid, entry.previousUsage, "particle");
        settle(
          change?.saveError
            ? {
                ...pending,
                message: `Texture "${entry.name}" Usage was restored in its open tab, which could not be saved: ${change.saveError}`,
                failed: true,
                canUndo: false,
                undoing: false,
              }
            : null,
        );
      } catch (error) {
        settle(
          error instanceof TextureUsageChangedError
            ? {
                ...pending,
                message: `Texture "${entry.name}" Usage has changed since the fix, so it was not undone.`,
                failed: true,
                canUndo: false,
                undoing: false,
              }
            : { ...pending, undoError: errorText(error), undoing: false },
        );
      } finally {
        undoingRef.current.delete(guid);
      }
    },
    [setFixedTexture, setTextureUsage],
  );
  const rows = useMemo(
    () =>
      warnings.map((warning, index): ParticleTextureUsageRow => {
        const reason = blocked[index];
        if (reason) return { ...warning, message: `${warning.message} ${reason}` };
        const failure = failures.get(warning.textureGuid);
        return {
          ...warning,
          ...(failure ? { message: `${warning.message} ${failure}` } : {}),
          action: {
            label: SET_PARTICLE_USAGE_LABEL,
            onClick: () => void apply(warning.textureGuid, warning.textureName),
            disabled:
              fixing.has(warning.textureGuid) ||
              fixed.get(warning.textureGuid)?.undoing === true,
          },
        };
      }),
    [apply, blocked, failures, fixed, fixing, warnings],
  );
  const notifications = useMemo(
    () =>
      [...fixed].map(([guid, entry]): TextureUsageNotification => ({
        textureGuid: guid,
        message: entry.undoError
          ? `${entry.message} Undo failed: ${entry.undoError}`
          : entry.message,
        failed: entry.failed || entry.undoError !== undefined,
        ...(entry.canUndo ? { undo: () => void undo(guid) } : {}),
        undoing: entry.undoing,
        dismiss: () => setFixedTexture(guid, null),
      })),
    [fixed, setFixedTexture, undo],
  );
  return { rows, notifications };
}

/**
 * The open Material's warnings. A Material that does not lower still warns
 * about its own texture nodes, so the author sees them while fixing errors.
 */
export function useMaterialTextureUsageWarnings(
  document: MaterialDocument | null,
  functions: Record<string, MaterialFunctionDocument>,
): ParticleTextureUsageWarning[] {
  const samples = useMemo(
    () =>
      document
        ? particleMaterialTextureSamples(document, functions, { whenInvalid: "nodes" })
        : NO_SAMPLES,
    [document, functions],
  );
  return useTextureUsageWarnings(samples);
}

/** Same array while every element is the same, so effects do not re-run on unrelated edits. */
function useStableElements<T>(items: readonly T[]): readonly T[] {
  const ref = useRef(items);
  if (
    ref.current.length !== items.length ||
    items.some((item, index) => item !== ref.current[index])
  ) {
    ref.current = items;
  }
  return ref.current;
}

function sameSamples(
  a: readonly MaterialTextureSample[],
  b: readonly MaterialTextureSample[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (sample, index) =>
        sample.textureGuid === b[index]!.textureGuid &&
        sample.nodeId === b[index]!.nodeId,
    )
  );
}

/**
 * Warnings for the Material an emitter uses, loaded the way its Preview loads
 * it: open Material and Material Function tabs win, and Functions are
 * followed. A Material that does not lower binds nothing (the emitter is
 * skipped anyway), and one outside the Particle domain has no warnings.
 */
export function useParticleMaterialTextureUsageWarnings(
  materialGuid: string | null | undefined,
): ParticleTextureUsageWarning[] {
  const { collectPlayMaterialLibrary, openDocuments, registryVersion } =
    useDocuments();
  // Reload only when a Material or Material Function tab changes, not on
  // every edit in other tabs.
  const materialContents = useStableElements(
    openDocuments
      .filter(
        (entry) =>
          entry.ref.kind === "material" || entry.ref.kind === "material-function",
      )
      .map((entry) => entry.content),
  );
  const [loaded, setLoaded] = useState<{
    guid: string;
    samples: MaterialTextureSample[];
  } | null>(null);

  useEffect(() => {
    if (!materialGuid) return;
    let cancelled = false;
    const publish = (samples: MaterialTextureSample[]) => {
      if (cancelled) return;
      setLoaded((previous) =>
        previous?.guid === materialGuid && sameSamples(previous.samples, samples)
          ? previous
          : { guid: materialGuid, samples },
      );
    };
    void (async () => {
      const library = await collectPlayMaterialLibrary(undefined, [], [materialGuid]);
      const document = library.documents.get(materialGuid);
      publish(
        document
          ? particleMaterialTextureSamples(
              document,
              Object.fromEntries(library.functions),
            )
          : NO_SAMPLES,
      );
    })().catch(() => publish(NO_SAMPLES));
    return () => {
      cancelled = true;
    };
  }, [collectPlayMaterialLibrary, materialContents, materialGuid, registryVersion]);

  const samples =
    materialGuid && loaded?.guid === materialGuid ? loaded.samples : NO_SAMPLES;
  return useTextureUsageWarnings(samples);
}
