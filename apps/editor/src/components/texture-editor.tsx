import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { BoxIcon, ImageIcon, Maximize2Icon, ScanIcon } from "lucide-react";
import {
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  ToolbarStrip,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  currentAreaEmissionChunk,
  isEnvironmentTexturePayload,
  shouldCompressTexture,
  type AreaEmissionProgress,
} from "@babylonslate/assets";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  applyTextureCompressionQualityChange,
  applyTextureDownsampleChange,
  patchTextureUsage,
  textureDownsampleSelectValue,
  TEXTURE_DOWNSAMPLE_LABELS,
  TEXTURE_USAGE_OPTIONS,
} from "../lib/asset-settings";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const CHECKERBOARD =
  "conic-gradient(var(--muted) 0.25turn, var(--background) 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, var(--background) 0.75turn)";

type TextureZoom = "fit" | "actual";

const FIT_INSET = 16;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useTextureDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const path = doc?.ref.path ?? "";
  const indexed = assetRegistry?.list().find((asset) => asset.path === path);
  return {
    path,
    payload: asRecord(doc?.content),
    guid: indexed?.header.guid,
    dependencies: indexed?.header.dependencies ?? [],
    commit: (next: Record<string, unknown>) => {
      void applyAssetDocumentChange(documentId, next);
    },
  };
}

export function TexturePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { path, payload } = useTextureDocument();
  return (
    <PanelFrame data-testid="texture-preview-panel">
      <TexturePreview path={path} payload={payload} />
    </PanelFrame>
  );
}

export function TextureDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, guid, dependencies, commit } = useTextureDocument();
  return (
    <PanelFrame data-testid="texture-details-panel">
      <TextureDetails
        guid={guid}
        dependencies={dependencies}
        payload={payload}
        onChange={commit}
      />
    </PanelFrame>
  );
}

function usageLabel(value: string): string {
  if (value === "pixelArt") return "Pixel Art";
  if (value === "ui") return "UI";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function TexturePreview({
  path,
  payload,
}: {
  path: string;
  payload: Record<string, unknown>;
}) {
  const { readAssetChunk } = useDocuments();
  const environment = isEnvironmentTexturePayload(payload);
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<TextureZoom>("fit");

  useEffect(() => {
    if (environment) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setStatus("loading");
    setUrl(null);
    void (async () => {
      const bytes = await readAssetChunk(path, "pixels");
      if (cancelled) return;
      if (!bytes || bytes.byteLength === 0) {
        setStatus("missing");
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      setUrl(objectUrl);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [environment, path, readAssetChunk]);

  const payloadWidth = typeof payload.sourceWidth === "number" ? payload.sourceWidth : null;
  const payloadHeight = typeof payload.sourceHeight === "number" ? payload.sourceHeight : null;
  const width = naturalSize?.width ?? payloadWidth;
  const height = naturalSize?.height ?? payloadHeight;
  const usage = typeof payload.usage === "string" ? payload.usage : "albedo";
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const next = { width: host.clientWidth - FIT_INSET * 2, height: host.clientHeight - FIT_INSET * 2 };
      setHostSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const scale =
    zoom === "actual" || !width || !height || hostSize.width <= 0 || hostSize.height <= 0
      ? 1
      : Math.min(hostSize.width / width, hostSize.height / height);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="texture-preview">
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="texture-preview-toolbar">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[zoom]}
          disabled={environment}
          onValueChange={(value) => {
            const next = value[0] as TextureZoom | undefined;
            if (next) setZoom(next);
          }}
          aria-label="Preview Zoom"
        >
          <ToggleGroupItem value="fit" className={TOOL_ITEM} data-testid="texture-zoom-fit">
            <Maximize2Icon />
            Fit
          </ToggleGroupItem>
          <ToggleGroupItem value="actual" className={TOOL_ITEM} data-testid="texture-zoom-actual">
            <ScanIcon />
            Actual Size
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {environment ? (
            <span className="truncate">Cube · {String(payload.width)} × {String(payload.height)}</span>
          ) : (
            <>
              <Badge variant="outline" className="font-normal">{usageLabel(usage)}</Badge>
              <span className="truncate tabular-nums" data-testid="texture-preview-size">
                {width && height ? `${width} × ${height}` : "Size Unknown"}
              </span>
              {url && width && height ? (
                <span className="tabular-nums" data-testid="texture-preview-zoom">{Math.round(scale * 100)}%</span>
              ) : null}
            </>
          )}
        </span>
      </ToolbarStrip>
      <div
        ref={hostRef}
        className={cn(
          "relative flex min-h-0 flex-1 bg-sidebar",
          zoom === "actual" ? "overflow-auto p-4" : "overflow-hidden",
        )}
      >
        {environment ? (
          <TexturePreviewEmpty
            icon={<BoxIcon />}
            title="Environment Cube"
            description="Cube faces are not previewed here. Assign this Texture in Scene Defaults to see it."
          />
        ) : status === "missing" ? (
          <TexturePreviewEmpty
            icon={<ImageIcon />}
            title="No Image Data"
            description="This Texture has no decoded pixels yet. Reimport the source image."
          />
        ) : url ? (
          <img
            src={url}
            alt=""
            data-testid="texture-preview-image"
            className={cn(
              "m-auto max-w-none shrink-0 ring-1 ring-border",
              (usage === "pixelArt" || scale >= 2) && "[image-rendering:pixelated]",
            )}
            style={{
              backgroundImage: CHECKERBOARD,
              backgroundSize: "16px 16px",
              ...(width && height ? { width: width * scale, height: height * scale } : {}),
            }}
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        ) : (
          <TexturePreviewEmpty icon={<ImageIcon />} title="Loading Preview…" />
        )}
      </div>
    </div>
  );
}

function TexturePreviewEmpty({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <Empty className="m-auto border-0" data-testid="texture-preview-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

const COMPRESSION_LABELS: Record<string, string> = {
  none: "Not Compressed",
  pending: "Queued",
  encoding: "Encoding",
  compressed: "Compressed",
  encode_failed: "Failed",
};

function compressionBadge(state: string) {
  const label = COMPRESSION_LABELS[state] ?? usageLabel(state);
  const variant = state === "encode_failed" ? "destructive" : state === "compressed" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className="font-normal" data-testid="texture-compression-state">
      {label}
    </Badge>
  );
}

export function TextureDetails({
  guid,
  dependencies,
  payload,
  onChange,
}: {
  guid?: string;
  dependencies: string[];
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { retryTextureEncoding, prepareAreaEmission, assetRegistry } = useDocuments();
  const emissionJob = useRef<AbortController | null>(null);
  const [emissionProgress, setEmissionProgress] = useState<AreaEmissionProgress | null>(null);
  const [emissionError, setEmissionError] = useState("");
  useEffect(() => () => { emissionJob.current?.abort(); }, [guid]);
  const emissionHeader = guid ? assetRegistry?.getByGuid(guid)?.header : undefined;
  const emissionReady = emissionHeader && currentAreaEmissionChunk(emissionHeader);
  const prepareEmission = async () => {
    if (!guid || emissionJob.current) return;
    const job = new AbortController();
    emissionJob.current = job;
    setEmissionError("");
    try { await prepareAreaEmission(guid, { signal: job.signal, onProgress: setEmissionProgress }); }
    catch (error) { if (!job.signal.aborted) setEmissionError(error instanceof Error ? error.message : String(error)); }
    finally { if (emissionJob.current === job) { emissionJob.current = null; setEmissionProgress(null); } }
  };

  if (isEnvironmentTexturePayload(payload)) {
    const rows: PropertyRow[] = [
      ["dimension", "Dimension", "Cube"],
      ["container", "Container", String(payload.container).toUpperCase()],
      ["encoding", "Encoding", payload.encoding === "rgbd" ? "RGBD" : payload.encoding === "linearFloat16" ? "Linear RGBA16F" : "Linear RGBA32F"],
      ["size", "Face Size", `${payload.width} × ${payload.height}`],
      ["mips", "Roughness Mip Levels", String(payload.mipLevels)],
    ].map(([id, label, value]) => ({ id: id!, label: label!, kind: "text" as const, value: value!, disabled: true, onChange: () => undefined }));
    return (
      <div className="flex flex-col" data-testid="texture-details">
        <Alert className="m-2 w-auto">
          <AlertTitle>Environment Cube</AlertTitle>
          <AlertDescription>Assign this texture in Scene Defaults → Environment Texture. The source and authored roughness mips are retained. DDS cubes must be authored as prefiltered; importing does not generate filtering.</AlertDescription>
        </Alert>
        <PropertyGrid title="Cube" rows={rows} />
      </div>
    );
  }

  const usage = typeof payload.usage === "string" ? payload.usage : "albedo";
  const compression = typeof payload.compressionState === "string" ? payload.compressionState : "none";
  const encodeError = typeof payload.encodeError === "string" ? payload.encodeError : "";
  const compressed = shouldCompressTexture(usage);
  const importRows: PropertyRow[] = [
    {
      id: "usage",
      kind: "enum",
      label: "Usage",
      value: usage,
      options: TEXTURE_USAGE_OPTIONS.map((value) => ({ value, label: usageLabel(value) })),
      onChange: (value) => onChange(patchTextureUsage(payload, value)),
    },
    {
      id: "downsample",
      kind: "enum",
      label: "Downsample",
      value: textureDownsampleSelectValue(payload),
      options: Object.entries(TEXTURE_DOWNSAMPLE_LABELS).map(([value, label]) => ({ value, label })),
      onChange: (value) => {
        const { payload: next, shouldRequeue } = applyTextureDownsampleChange(payload, value);
        onChange(next);
        if (guid && shouldRequeue) void retryTextureEncoding(guid, { force: true });
      },
    },
  ];
  if (compressed) {
    importRows.push({
      id: "compressionQuality",
      kind: "number",
      label: "Compression Quality",
      value: typeof payload.compressionQuality === "number" ? payload.compressionQuality : 2,
      onChange: (value) => {
        const { payload: next, shouldRequeue } = applyTextureCompressionQualityChange(payload, value);
        onChange(next);
        if (guid && shouldRequeue) void retryTextureEncoding(guid, { force: true });
      },
    });
  }
  if (dependencies.length > 0) {
    importRows.push({
      id: "dependencies",
      kind: "text",
      label: "Dependencies",
      value: String(dependencies.length),
      disabled: true,
      onChange: () => undefined,
    });
  }
  const emissionStatus = emissionProgress
    ? `${emissionProgress.phase === "queued" ? "Queued" : emissionProgress.phase === "decoding" ? "Decoding" : emissionProgress.phase === "filtering" ? "Filtering" : "Saving"} ${Math.round(emissionProgress.progress * 100)}%`
    : emissionReady ? "Ready" : "Not Prepared";

  return (
    <div className="flex flex-col" data-testid="texture-details">
      <PropertyGrid title="Import" rows={importRows} />
      <PropertySectionTitle aside={compressionBadge(compression)}>Compression</PropertySectionTitle>
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-xs text-muted-foreground">
          {compressed
            ? "Encoded to GPU formats in the background after import or when settings change."
            : `${usageLabel(usage)} Textures stay uncompressed to keep exact pixels.`}
        </p>
        {encodeError ? (
          <Alert variant="destructive" data-testid="texture-encode-error">
            <AlertTitle>Encoding Failed</AlertTitle>
            <AlertDescription>{encodeError}</AlertDescription>
          </Alert>
        ) : null}
        {guid && compression === "encode_failed" ? (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            data-testid="texture-retry-encode"
            onClick={() => void retryTextureEncoding(guid, { force: true })}
          >
            Retry Encoding
          </Button>
        ) : null}
      </div>
      {guid ? (
        <>
          <PropertySectionTitle
            aside={
              <Badge variant={emissionReady && !emissionProgress ? "secondary" : "outline"} className="font-normal" role="status">
                {emissionStatus}
              </Badge>
            }
          >
            Area Light Emission
          </PropertySectionTitle>
          <div className="flex flex-col gap-2 px-2 py-2">
            <p className="text-xs text-muted-foreground">
              Prepare this Texture for rectangular lights. The original image stays available for materials. Prepared data is saved with the asset and included in game exports.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={emissionProgress !== null} onClick={() => void prepareEmission()}>
                {emissionReady ? "Check Emission Data" : "Prepare Emission"}
              </Button>
              {emissionProgress ? (
                <Button size="sm" variant="ghost" onClick={() => emissionJob.current?.abort()}>
                  Cancel
                </Button>
              ) : null}
            </div>
            {emissionError ? (
              <Alert variant="destructive">
                <AlertTitle>Emission Failed</AlertTitle>
                <AlertDescription>{emissionError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
