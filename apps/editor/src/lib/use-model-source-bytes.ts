import { useEffect, useState } from "react";
import { useDocumentActions } from "../context/document-context";

export type ModelSourceRead = { bytes: Uint8Array | null; error: string | null };

const NO_MODEL_SOURCE: ModelSourceRead = { bytes: null, error: null };

/**
 * The `source` chunk of the Model at `path`. Bytes read for another path are
 * never returned, so a path change shows no mesh until its own read lands, and
 * a failed read reports its error instead of leaving the previous mesh.
 */
export function useModelSourceBytes(path: string | undefined): ModelSourceRead {
  const { readAssetChunk } = useDocumentActions();
  const [loaded, setLoaded] = useState<(ModelSourceRead & { path: string }) | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    readAssetChunk(path, "source").then(
      (bytes) => {
        if (!cancelled) setLoaded({ path, bytes, error: null });
      },
      (error: unknown) => {
        if (!cancelled)
          setLoaded({
            path,
            bytes: null,
            error: error instanceof Error ? error.message : "The Model source could not be read.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, readAssetChunk]);
  return path && loaded?.path === path ? loaded : NO_MODEL_SOURCE;
}
