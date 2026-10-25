import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ProjectDocument, ProjectStorage } from "@haptic/core";
import { readThumbnail, ThumbnailDecodeLru, writeThumbnail } from "@haptic/assets";
import {
  createAssetThumbnailRevisionIndex,
  type AssetThumbnailWriteIdentity,
} from "../lib/asset-thumbnail-revision";
import type { ProjectService } from "../services/project-service";
import type { DocumentActions } from "./document-context-types";

const THUMBNAIL_DECODE_LRU_ENTRIES = 64;

export interface AssetThumbnailDeps {
  projectService: ProjectService;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  /** Its 2D Pixels Per Unit is part of each thumbnail's saved revision. */
  projectDocument: ProjectDocument | null;
  /** The provider's `registryEpoch`. */
  registryEpoch: number;
  ensureDerived: () => Promise<ProjectStorage>;
}

/**
 * Asset thumbnails: the decoded thumbnail cache, the saved revision each
 * asset's thumbnail was read for (a new revision bumps its version), and the
 * Thumbnails engine setting. Every callback keeps its identity for the
 * provider's lifetime.
 */
export function useAssetThumbnails({
  projectService,
  projectDocumentRef,
  projectDocument,
  registryEpoch,
  ensureDerived,
}: AssetThumbnailDeps) {
  // Keyed by saved revision, and projects made from one template share guids:
  // opening a project replaces it (`resetThumbnails`) so one project never
  // shows another's thumbnails.
  const thumbnailLruRef = useRef(new ThumbnailDecodeLru(THUMBNAIL_DECODE_LRU_ENTRIES));
  const requestedThumbnailRevisionsRef = useRef(new Map<string, string>());
  const thumbnailsEnabledRef = useRef(true);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<string, number>>({});
  const previousThumbnailIndexRef = useRef<ReturnType<typeof createAssetThumbnailRevisionIndex> | null>(null);
  const thumbnailRevisionIndex = useMemo(
    () => {
      void registryEpoch;
      const assets = projectService.registry?.list() ?? [];
      const previous = previousThumbnailIndexRef.current;
      // Plugin and search-index changes also advance the epoch. Reuse saved
      // revisions until an indexed header actually changes.
      const pixelsPerUnit = projectDocument?.settings.twoD.pixelsPerUnit;
      const next = previous?.matches(assets, pixelsPerUnit) ? previous : createAssetThumbnailRevisionIndex(assets, pixelsPerUnit);
      previousThumbnailIndexRef.current = next;
      return next;
    },
    [projectDocument?.settings.twoD.pixelsPerUnit, projectService, registryEpoch],
  );
  const thumbnailRevisionIndexRef = useRef(thumbnailRevisionIndex);
  useLayoutEffect(() => {
    thumbnailRevisionIndexRef.current = thumbnailRevisionIndex;
  }, [thumbnailRevisionIndex]);
  useEffect(() => {
    const changed: string[] = [];
    for (const [guid, previous] of requestedThumbnailRevisionsRef.current) {
      const next = thumbnailRevisionIndex.revision(guid);
      if (next === previous) continue;
      if (next === null) requestedThumbnailRevisionsRef.current.delete(guid);
      else requestedThumbnailRevisionsRef.current.set(guid, next);
      changed.push(guid);
    }
    if (changed.length) setThumbnailVersions((versions) => {
      const next = { ...versions };
      for (const guid of changed) next[guid] = (next[guid] ?? 0) + 1;
      return next;
    });
  }, [thumbnailRevisionIndex]);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(true);

  /** Project open: the previous project's decoded and requested thumbnails go. */
  const resetThumbnails = useCallback(() => {
    thumbnailLruRef.current = new ThumbnailDecodeLru(THUMBNAIL_DECODE_LRU_ENTRIES);
    requestedThumbnailRevisionsRef.current.clear();
    setThumbnailVersions({});
  }, []);

  /** The Thumbnails engine setting, read when the provider mounts. */
  const applyThumbnailsEnabled = useCallback((enabled: boolean) => {
    thumbnailsEnabledRef.current = enabled;
    setThumbnailsEnabled(enabled);
  }, []);

  const loadAssetThumbnail = useCallback(
    async (assetGuid: string): Promise<Uint8Array | null> => {
      if (!thumbnailsEnabledRef.current) return null;
      // A read that finishes after a project switch fills the old cache only.
      const lru = thumbnailLruRef.current;
      const guid = projectService.guid;
      if (!guid) return null;
      const asset = projectService.registry?.getByGuid(assetGuid);
      const revisionIndex = thumbnailRevisionIndexRef.current;
      const revision = revisionIndex.revision(assetGuid);
      if (revision !== null) {
        const requested = requestedThumbnailRevisionsRef.current;
        requested.delete(assetGuid);
        requested.set(assetGuid, revision);
        if (requested.size > 512) requested.delete(requested.keys().next().value!);
      }
      else if (asset?.header.type === "Class") return null;
      const key = revision !== null ? await revisionIndex.cacheKey(assetGuid) : assetGuid;
      if (!key || projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        thumbnailRevisionIndexRef.current.revision(assetGuid) !== revision) return null;
      const cached = lru.get(key);
      if (cached) return cached;
      const derived = await ensureDerived();
      const bytes = await readThumbnail(derived, guid, key);
      if (projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        thumbnailRevisionIndexRef.current.revision(assetGuid) !== revision) return null;
      if (bytes) lru.set(key, bytes);
      // Browsing may read derived thumbnails but never trigger source loading.
      // Explicit import/save operations schedule generation separately.
      return bytes;
    },
    [ensureDerived, projectService],
  );

  const writeAssetThumbnail = useCallback(
    async (assetGuid: string, bytes: Uint8Array, expected?: AssetThumbnailWriteIdentity): Promise<void> => {
      const guid = projectService.guid;
      if (!guid || (expected && expected.projectGuid !== guid)) return;
      const lru = thumbnailLruRef.current;
      const derived = await ensureDerived();
      const revisionIndex = createAssetThumbnailRevisionIndex(projectService.registry?.list() ?? [], projectDocumentRef.current?.settings.twoD.pixelsPerUnit);
      const revision = revisionIndex.revision(assetGuid);
      const key = revision !== null ? await revisionIndex.cacheKey(assetGuid) : assetGuid;
      if (!key || projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        (expected && expected.cacheKey !== key)) return;
      await writeThumbnail(derived, guid, key, bytes);
      if (projectService.guid !== guid || thumbnailLruRef.current !== lru) return;
      lru.delete(key);
      setThumbnailVersions((versions) => ({
        ...versions,
        [assetGuid]: (versions[assetGuid] ?? 0) + 1,
      }));
    },
    [ensureDerived, projectService, projectDocumentRef],
  );

  const actions = useMemo(
    (): Pick<DocumentActions, "loadAssetThumbnail" | "writeAssetThumbnail"> => ({
      loadAssetThumbnail,
      writeAssetThumbnail,
    }),
    [loadAssetThumbnail, writeAssetThumbnail],
  );

  return {
    thumbnailVersions,
    thumbnailsEnabled,
    resetThumbnails,
    applyThumbnailsEnabled,
    actions,
  };
}
