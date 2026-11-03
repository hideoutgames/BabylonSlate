import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@haptic/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { useDocumentActions, useRegistryState } from "../context/document-context";

export function useTexturePreview(textureGuid: string | null | undefined) {
  const { readAssetChunk } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const asset = textureGuid ? assetRegistry?.getByGuid(textureGuid) : undefined;
  const path = asset?.path;
  const revision =
    asset?.header.chunks?.find((chunk) => chunk.id === "pixels")?.sha256 ??
    asset?.mtime ??
    "";
  const sourceKey = `${textureGuid ?? ""}:${path ?? ""}:${revision}`;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    sourceKey: string;
    url?: string;
    error?: string;
  } | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const fail = useCallback(() => {
    if (path)
      setLoaded({
        sourceKey,
        error:
          "The texture image could not be decoded. Reimport the texture or pick a replacement in the Inspector.",
      });
  }, [path, sourceKey]);

  useEffect(() => {
    setLoaded(null);
    if (!path || !readAssetChunk) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const bytes = await readAssetChunk(path, "pixels");
        if (cancelled) return;
        if (!bytes?.byteLength)
          throw new Error(
            "Texture image data is missing. Reimport the texture or pick a replacement in the Inspector.",
          );
        objectUrl = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        );
        setLoaded({ sourceKey, url: objectUrl });
      } catch (error) {
        if (!cancelled)
          setLoaded({
            sourceKey,
            error:
              error instanceof Error
                ? error.message
                : "The texture could not be read.",
          });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, sourceKey, readAssetChunk, attempt]);

  const current = loaded?.sourceKey === sourceKey ? loaded : null;
  const status = !textureGuid
    ? "empty"
    : !path
      ? "missing"
      : !readAssetChunk || current?.error
        ? "failed"
        : current?.url
          ? "ready"
          : "loading";
  return {
    status,
    url: current?.url ?? null,
    error: current?.error,
    retry,
    fail,
    canRetry: Boolean(path && readAssetChunk),
  };
}

export type TexturePreview = ReturnType<typeof useTexturePreview>;

type LoadedTexture = { url?: string; error?: string; image?: HTMLImageElement };

/**
 * Loads and decodes every Texture in `guids` once and keeps them while they
 * stay listed, so switching between them (Sprite Animation playback) shows
 * the next image at once instead of reloading it. Returns each guid's preview.
 */
export function useTexturePreviews(guids: readonly string[]): (guid: string | null | undefined) => TexturePreview {
  const { readAssetChunk } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const sources = useMemo(() => {
    const byGuid = new Map<string, { path?: string; sourceKey: string }>();
    for (const guid of guids) {
      if (!guid || byGuid.has(guid)) continue;
      const asset = assetRegistry?.getByGuid(guid);
      const revision = asset?.header.chunks?.find((chunk) => chunk.id === "pixels")?.sha256 ?? asset?.mtime ?? "";
      byGuid.set(guid, { path: asset?.path, sourceKey: `${guid}:${asset?.path ?? ""}:${revision}` });
    }
    return byGuid;
  }, [assetRegistry, guids]);
  const cacheRef = useRef(new Map<string, LoadedTexture>());
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((value) => value + 1), []);
  const sourceKeys = [...sources.values()].filter((source) => source.path).map((source) => source.sourceKey).join("|");

  useEffect(() => {
    const cache = cacheRef.current;
    const wanted = new Map([...sources.values()].filter((source) => source.path).map((source) => [source.sourceKey, source.path!]));
    for (const [key, entry] of cache) {
      if (wanted.has(key)) continue;
      if (entry.url) URL.revokeObjectURL(entry.url);
      cache.delete(key);
    }
    if (!readAssetChunk) return;
    for (const [key, path] of wanted) {
      if (cache.has(key)) continue;
      const entry: LoadedTexture = {};
      cache.set(key, entry);
      void (async () => {
        try {
          const bytes = await readAssetChunk(path, "pixels");
          if (!bytes?.byteLength)
            throw new Error("Texture image data is missing. Reimport the texture or pick a replacement in the Inspector.");
          const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
          if (cache.get(key) !== entry) {
            URL.revokeObjectURL(url);
            return;
          }
          // Decode before showing it, and keep the image so it stays decoded.
          const image = new Image();
          image.src = url;
          if (typeof image.decode === "function") await image.decode().catch(() => undefined);
          if (cache.get(key) !== entry) {
            URL.revokeObjectURL(url);
            return;
          }
          entry.url = url;
          entry.image = image;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : "The texture could not be read.";
        }
        if (cache.get(key) === entry) bump();
      })();
    }
    // A retry drops its entry and bumps `revision`, which loads it again.
  }, [bump, readAssetChunk, revision, sourceKeys, sources]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
      cache.clear();
    };
  }, []);

  return (guid) => {
    const source = guid ? sources.get(guid) : undefined;
    const entry = source ? cacheRef.current.get(source.sourceKey) : undefined;
    const retry = () => {
      if (!source) return;
      cacheRef.current.delete(source.sourceKey);
      bump();
    };
    const fail = () => {
      if (!entry) return;
      entry.url = undefined;
      entry.error = "The texture image could not be decoded. Reimport the texture or pick a replacement in the Inspector.";
      bump();
    };
    const status = !guid
      ? "empty"
      : !source?.path
        ? "missing"
        : !readAssetChunk || entry?.error
          ? "failed"
          : entry?.url
            ? "ready"
            : "loading";
    return { status, url: entry?.url ?? null, error: entry?.error, retry, fail, canRetry: Boolean(source?.path && readAssetChunk) };
  };
}

export function TexturePreviewStatus({
  preview,
}: {
  preview: TexturePreview;
}) {
  const { status, error, canRetry, retry } = preview;
  const title =
    status === "empty"
      ? "No Texture"
      : status === "missing"
        ? "Missing Texture"
        : status === "failed"
          ? "Texture Preview Failed"
          : "Loading Texture…";
  const description =
    status === "empty"
      ? "Pick a Texture in the Inspector to see the preview."
      : status === "missing"
        ? "The selected Texture could not be found. Pick a replacement in the Inspector."
        : status === "failed"
          ? (error ??
            "Texture preview is unavailable. Reopen the document to try again.")
          : undefined;
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {status === "failed" && canRetry ? (
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
