import { useCallback, useEffect, useState } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";

export function useTexturePreview(textureGuid: string | null | undefined) {
  const { assetRegistry, readAssetChunk } = useDocuments();
  const asset = assetRegistry
    ?.list()
    .find((entry) => entry.header.guid === textureGuid);
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
          "The texture image could not be decoded. Reimport the texture or pick a replacement in Details.",
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
            "Texture image data is missing. Reimport the texture or pick a replacement in Details.",
          );
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "image/png" }),
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

export function TexturePreviewStatus({
  preview,
}: {
  preview: ReturnType<typeof useTexturePreview>;
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
      ? "Pick a Texture in Details to see the preview."
      : status === "missing"
        ? "The selected Texture could not be found. Pick a replacement in Details."
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
