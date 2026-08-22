import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  ToolbarStrip,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  decodeSourceToRgba,
  defaultSkyboxCreatorSourcePlacement,
  fitSourceIntoSkyboxNet,
  letterboxSize,
  newAssetGuid,
  normalizeSkyboxCreatorPayload,
  SKYBOX_CREATOR_COMPASS_FACES,
  SKYBOX_CREATOR_NET_CELLS,
  SKYBOX_CREATOR_NET_COLS,
  SKYBOX_CREATOR_NET_ROWS,
  type SkyboxCreatorCompassFace,
  type SkyboxCreatorPayload,
  type SkyboxCreatorSourcePlacement,
} from "@babylonslate/assets";
import {
  SKYBOX_FACE_KEYS,
  type SkyboxFaceKey,
} from "@babylonslate/core";
import { encodePngRgba } from "@babylonslate/render";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOpenAssetDocument } from "../lib/use-open-asset-document";
import {
  readTextureImageBytes,
  writeSkyboxCreatorFaceAssets,
} from "../lib/skybox-creator-create";
import {
  SkyboxCreatorPreviewCanvas,
  type SkyboxCreatorPreviewFacePngs,
} from "./skybox-creator-preview-canvas";
import { SkyboxCreatorSourceOverlay } from "./skybox-creator-source-overlay";

const SOURCE_DECODE_MAX = 16384;
const SKYBOX_CREATOR_SOURCE_MERGE_KEY = "skybox-creator-source";

type DecodedSkyboxSource = {
  rgba: Uint8Array;
  width: number;
  height: number;
};

function texturePathForGuid(
  assets: ReadonlyArray<IndexedAsset>,
  guid: string | null,
): string | null {
  if (!guid) return null;
  return assets.find((asset) => asset.header.guid === guid)?.path ?? null;
}

function useSkyboxCreatorDecodedSource(sourceTextureGuid: string | null) {
  const { assetRegistry, readAssetChunk } = useDocuments();
  const texturePath = texturePathForGuid(
    (assetRegistry?.list() ?? []) as IndexedAsset[],
    sourceTextureGuid,
  );
  const [decoded, setDecoded] = useState<DecodedSkyboxSource | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setDecoded(null);
    setUrl(null);
    if (!sourceTextureGuid || !texturePath || !readAssetChunk) return;
    void (async () => {
      const image = await readTextureImageBytes(readAssetChunk, texturePath);
      if (!image || cancelled) return;
      objectUrl = URL.createObjectURL(
        new Blob([image.bytes], image.mime ? { type: image.mime } : undefined),
      );
      if (!cancelled) setUrl(objectUrl);
      try {
        const result = await decodeSourceToRgba(
          image.bytes,
          SOURCE_DECODE_MAX,
          image.mime ?? undefined,
        );
        if (!cancelled) {
          setDecoded({
            rgba: result.rgba,
            width: result.width,
            height: result.height,
          });
        }
      } catch {
        if (!cancelled) setDecoded(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [readAssetChunk, sourceTextureGuid, texturePath]);

  return { decoded, url };
}

const COMPASS_LABEL: Record<SkyboxCreatorCompassFace, string> = {
  up: "UP",
  left: "LEFT",
  front: "FRONT",
  right: "RIGHT",
  back: "BACK",
  down: "DOWN",
};

const SKYBOX_FACE_LABELS: Record<SkyboxFaceKey, string> = {
  px: "Positive X",
  py: "Positive Y",
  pz: "Positive Z",
  nx: "Negative X",
  ny: "Negative Y",
  nz: "Negative Z",
};

type IndexedAsset = {
  header: { guid: string; name: string; type: string };
  path: string;
  rootId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identityFor(assets: ReadonlyArray<IndexedAsset>, guid: string | null) {
  const asset = guid
    ? assets.find((entry) => entry.header.guid === guid)
    : undefined;
  return asset
    ? assetRowIdentity({
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      })
    : {};
}

function pickerAssets(list: ReadonlyArray<IndexedAsset>) {
  return list
    .filter((asset) => asset.header.type === "Texture")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
}

function netCellFace(col: number, row: number): SkyboxCreatorCompassFace | null {
  for (const compass of SKYBOX_CREATOR_COMPASS_FACES) {
    const cell = SKYBOX_CREATOR_NET_CELLS[compass];
    if (cell.col === col && cell.row === row) return compass;
  }
  return null;
}

function placementFromKey(key: string): SkyboxCreatorSourcePlacement | null {
  if (!key) return null;
  const parts = key.split(",").map(Number);
  const x = parts[0];
  const y = parts[1];
  const width = parts[2];
  const height = parts[3];
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return null;
  }
  return { x, y, width, height };
}

function CreateSkyboxButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      disabled={disabled}
      data-testid="skybox-creator-create"
      onClick={onClick}
    >
      Create Skybox Textures
    </Button>
  );
}

function SkyboxCreatorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" data-testid="skybox-creator-alert">
      <AlertTitle>Couldn&apos;t Create Skybox Textures</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function useSkyboxCreatorCreate(
  payload: Record<string, unknown>,
  helperPath: string,
  onChange: (next: Record<string, unknown>) => void,
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const {
    assetRegistry,
    readAssetChunk,
    refreshAssetRegistry,
  } = useDocuments();

  const create = async () => {
    const helper = normalizeSkyboxCreatorPayload(payload);
    setError(null);
    if (!helper.sourceTextureGuid) {
      setError("Pick a Texture before creating skybox faces.");
      return;
    }
    const assets = (assetRegistry?.list() ?? []) as IndexedAsset[];
    const source = assets.find(
      (asset) => asset.header.guid === helper.sourceTextureGuid,
    );
    if (!source || !readAssetChunk) {
      setError("The source Texture is missing.");
      return;
    }
    if (!assetRegistry?.createAsset || !assetRegistry.deleteAsset) {
      setError("The asset registry is unavailable.");
      return;
    }
    setBusy(true);
    try {
      const image = await readTextureImageBytes(readAssetChunk, source.path);
      if (!image) {
        setError("The source Texture has no image data.");
        return;
      }
      const decoded = await decodeSourceToRgba(
        image.bytes,
        SOURCE_DECODE_MAX,
        image.mime ?? undefined,
      );
      const helperAsset = assets.find((asset) => asset.path === helperPath);
      const rootId = helperAsset?.rootId ?? source.rootId ?? "project";
      const root = assetRegistry.getRoot?.(rootId);
      const pathPrefix = root?.pathPrefix ?? "assets";
      const existingByGuid = new Map(
        assets.map((asset) => [asset.header.guid, { path: asset.path }]),
      );
      const occupiedPaths = new Set(assets.map((asset) => asset.path));
      const generatedFaces = await writeSkyboxCreatorFaceAssets({
        helperPath,
        payload: helper,
        rgba: decoded.rgba,
        width: decoded.width,
        height: decoded.height,
        existingByGuid,
        occupiedPaths,
        rootId,
        pathPrefix,
        encodePng: encodePngRgba,
        newGuid: newAssetGuid,
        createAsset: (id, relativePath, result) =>
          assetRegistry.createAsset(id, relativePath, result),
        deleteAsset: (guid) => assetRegistry.deleteAsset(guid),
      });
      onChange({ ...helper, generatedFaces });
      await refreshAssetRegistry?.();
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      setError(message || "The source Texture could not be decoded.");
    } finally {
      setBusy(false);
    }
  };

  return { error, busy, create };
}

export function SkyboxCreatorPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = asRecord(doc?.content);
  const helperPath = doc?.ref.path ?? "";
  const { error, busy, create } = useSkyboxCreatorCreate(
    payload,
    helperPath,
    (next) => {
      void applyAssetDocumentChange(documentId, next);
    },
  );
  return (
    <PanelFrame data-testid="skybox-creator-preview-panel">
      <SkyboxCreatorPreview
        payload={payload}
        onCreate={() => {
          void create();
        }}
        creating={busy}
        error={error}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function SkyboxCreatorCubemapPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = asRecord(doc?.content);
  return (
    <PanelFrame data-testid="skybox-creator-cubemap-panel">
      <SkyboxCreatorCubemap payload={payload} />
    </PanelFrame>
  );
}

export function SkyboxCreatorDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = asRecord(doc?.content);
  const helperPath = doc?.ref.path ?? "";
  return (
    <PanelFrame data-testid="skybox-creator-details-panel">
      <SkyboxCreatorEditor
        payload={payload}
        helperPath={helperPath}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}


function hostSize(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: element.clientWidth || rect.width,
    height: element.clientHeight || rect.height,
  };
}

export function SkyboxCreatorPreview({
  payload,
  onCreate,
  creating,
  error,
  onChange,
}: {
  payload: Record<string, unknown>;
  onCreate: () => void;
  creating?: boolean;
  error?: string | null;
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const helper = normalizeSkyboxCreatorPayload(payload);
  const { decoded, url } = useSkyboxCreatorDecodedSource(helper.sourceTextureGuid);
  const hostRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const size = hostSize(host);
      const next = letterboxSize(size.width, size.height);
      setBox((prev) =>
        prev.width === next.width && prev.height === next.height
          ? prev
          : { width: next.width, height: next.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  });

  const cells = useMemo(() => {
    const rows: Array<{
      col: number;
      row: number;
      compass: SkyboxCreatorCompassFace | null;
    }> = [];
    for (let row = 0; row < SKYBOX_CREATOR_NET_ROWS; row++) {
      for (let col = 0; col < SKYBOX_CREATOR_NET_COLS; col++) {
        rows.push({ col, row, compass: netCellFace(col, row) });
      }
    }
    return rows;
  }, []);

  const overlayPlacement: SkyboxCreatorSourcePlacement | null =
    helper.sourcePlacement ??
    (decoded
      ? defaultSkyboxCreatorSourcePlacement(decoded.width, decoded.height)
      : null);

  const commitPlacement = (sourcePlacement: SkyboxCreatorSourcePlacement) => {
    onChange?.(
      { ...helper, sourcePlacement },
      SKYBOX_CREATOR_SOURCE_MERGE_KEY,
    );
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="skybox-creator-preview"
    >
      <ToolbarStrip>
        <CreateSkyboxButton disabled={creating} onClick={onCreate} />
      </ToolbarStrip>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {error ? <SkyboxCreatorAlert message={error} /> : null}
        <div
          ref={hostRef}
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          data-testid="skybox-creator-net-host"
        >
          <div
            ref={netRef}
            className="relative overflow-hidden rounded-md border border-border bg-muted/30"
            style={{ width: box.width, height: box.height }}
            data-testid="skybox-creator-net"
          >
            {helper.sourceTextureGuid && overlayPlacement && onChange ? (
              <SkyboxCreatorSourceOverlay
                placement={overlayPlacement}
                imageUrl={url}
                onChange={commitPlacement}
                getNetRect={() => netRef.current?.getBoundingClientRect()}
              />
            ) : null}
            <div
              className="pointer-events-none absolute inset-0 z-20 grid"
              style={{
                gridTemplateColumns: `repeat(${SKYBOX_CREATOR_NET_COLS}, 1fr)`,
                gridTemplateRows: `repeat(${SKYBOX_CREATOR_NET_ROWS}, 1fr)`,
              }}
            >
              {cells.map((cell) => (
                <div
                  key={`${cell.col}-${cell.row}`}
                  data-testid={
                    cell.compass
                      ? `skybox-creator-cell-${cell.compass}`
                      : undefined
                  }
                  className={
                    cell.compass
                      ? "relative flex items-start justify-center border border-border/80 bg-background/20 p-1"
                      : "border border-dashed border-border/50 bg-muted/40"
                  }
                >
                  {cell.compass ? (
                    <span className="rounded bg-background/80 px-1 text-[10px] font-medium tracking-wide text-foreground">
                      {COMPASS_LABEL[cell.compass]}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            {helper.sourceTextureGuid ? null : (
              <Empty
                className="pointer-events-none absolute inset-0 z-30 justify-center"
                data-testid="skybox-creator-empty"
              >
                <EmptyHeader>
                  <EmptyTitle>No Texture</EmptyTitle>
                  <EmptyDescription>
                    Pick a Texture in Details. Place it on this 4×3 net of
                    square cells, then Create writes six skybox faces.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkyboxCreatorCubemap({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const helper = normalizeSkyboxCreatorPayload(payload);
  const { decoded } = useSkyboxCreatorDecodedSource(helper.sourceTextureGuid);
  const [facePngs, setFacePngs] = useState<SkyboxCreatorPreviewFacePngs | null>(
    null,
  );
  const placementKey = helper.sourcePlacement
    ? `${helper.sourcePlacement.x},${helper.sourcePlacement.y},${helper.sourcePlacement.width},${helper.sourcePlacement.height}`
    : "";

  useEffect(() => {
    if (!decoded) {
      setFacePngs(null);
      return;
    }
    const sliced = fitSourceIntoSkyboxNet(
      decoded.rgba,
      decoded.width,
      decoded.height,
      placementFromKey(placementKey),
    );
    const pngs = {} as SkyboxCreatorPreviewFacePngs;
    for (const key of SKYBOX_FACE_KEYS) {
      const face = sliced.faces[key];
      pngs[key] = encodePngRgba(face.size, face.size, face.rgba);
    }
    setFacePngs(pngs);
  }, [decoded, placementKey]);

  return (
    <div
      className="h-full min-h-0 overflow-hidden"
      data-testid="skybox-creator-cubemap"
    >
      {facePngs ? <SkyboxCreatorPreviewCanvas facePngs={facePngs} /> : null}
    </div>
  );
}

export function SkyboxCreatorEditor({
  payload,
  helperPath,
  onChange,
}: {
  payload: Record<string, unknown>;
  helperPath: string;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const helper = normalizeSkyboxCreatorPayload(payload);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { assetRegistry } = useDocuments();
  const openAssetDocument = useOpenAssetDocument();
  const assets = (assetRegistry?.list() ?? []) as IndexedAsset[];
  const { error, busy, create } = useSkyboxCreatorCreate(
    payload,
    helperPath,
    onChange,
  );
  const commit = (next: SkyboxCreatorPayload) => {
    onChange(normalizeSkyboxCreatorPayload(next) as unknown as Record<string, unknown>);
  };

  const rows: PropertyRow[] = [
    {
      id: "source",
      kind: "asset",
      label: "Texture",
      value: helper.sourceTextureGuid,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onOpenAsset: () => {
        const entry = assets.find(
          (asset) => asset.header.guid === helper.sourceTextureGuid,
        );
        if (entry)
          void openAssetDocument({
            type: entry.header.type,
            path: entry.path,
          });
      },
      onChange: (sourceTextureGuid) =>
        commit({ ...helper, sourceTextureGuid, sourcePlacement: null }),
      ...identityFor(assets, helper.sourceTextureGuid),
    },
    ...SKYBOX_FACE_KEYS.map((key) => ({
      id: `face-${key}`,
      kind: "asset" as const,
      label: SKYBOX_FACE_LABELS[key],
      value: helper.generatedFaces[key],
      placeholder: "None",
      disabled: true,
      onPick: () => {},
      onChange: () => {},
      ...identityFor(assets, helper.generatedFaces[key]),
    })),
  ];

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="skybox-creator-editor">
      {error ? <SkyboxCreatorAlert message={error} /> : null}
      <PropertyGrid rows={rows} />
      <CreateSkyboxButton disabled={busy} onClick={() => void create()} />
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={pickerAssets(assets)}
        allowedTypes={["Texture"]}
        title="Pick Texture"
        allowNone
        onPick={(sourceTextureGuid) => {
          commit({ ...helper, sourceTextureGuid, sourcePlacement: null });
          setPickerOpen(false);
        }}
        data-testid="skybox-creator-texture-picker"
      />
    </div>
  );
}
