import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import type { AssetDiff, TextureDiff, TextureRaster } from "@haptic/assets/asset-diff";
import { Slider } from "@haptic/ui/components/slider";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useRegistryState } from "../context/document-context";
import { PropertyDiffTable } from "./diff-property-table";

type Mode = "side-by-side" | "swipe" | "difference";
type Channel = "rgb" | "alpha";

/** The longest edge a preview draws: enough for the window, and cheap to read back for Alpha and Difference. */
const PREVIEW_EDGE = 1024;
/** Transparency shows as the theme's checkerboard. */
const CHECKERBOARD = { background: "conic-gradient(var(--muted) 0.25turn, var(--border) 0 0.5turn, var(--muted) 0 0.75turn, var(--border) 0) 0 0 / 12px 12px" };

/** Each side's raster as a bitmap the browser decoded (null where it has none or cannot decode it). */
function useBitmaps(base: TextureRaster | null, compare: TextureRaster | null): { base: ImageBitmap | null; compare: ImageBitmap | null } {
  const [bitmaps, setBitmaps] = useState<{ base: ImageBitmap | null; compare: ImageBitmap | null }>({ base: null, compare: null });
  useEffect(() => {
    let live = true;
    const opened: ImageBitmap[] = [];
    const decode = async (raster: TextureRaster | null) => {
      if (!raster || typeof createImageBitmap !== "function") return null;
      try {
        const bitmap = await createImageBitmap(new Blob([raster.bytes.slice()], { type: raster.mime }));
        opened.push(bitmap);
        return bitmap;
      } catch {
        // A format the browser cannot decode (KTX2, DDS): no preview.
        return null;
      }
    };
    void (async () => {
      const first = await decode(base);
      const second = compare === base ? first : await decode(compare);
      if (live) setBitmaps({ base: first, compare: second });
    })();
    return () => {
      live = false;
      for (const bitmap of opened) bitmap.close();
    };
  }, [base, compare]);
  return bitmaps;
}

function previewSize(bitmap: ImageBitmap): [number, number] {
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
  return [Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale))];
}

/** Draws a bitmap, its alpha as grey, or the per-channel difference of two (same size: the compare's). */
function paint(canvas: HTMLCanvasElement, first: ImageBitmap, channel: Channel, second?: ImageBitmap): void {
  const [width, height] = previewSize(second ?? first);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  context.clearRect(0, 0, width, height);
  context.drawImage(first, 0, 0, width, height);
  if (channel === "rgb" && !second) return;
  const pixels = context.getImageData(0, 0, width, height);
  let other: Uint8ClampedArray | null = null;
  if (second) {
    context.clearRect(0, 0, width, height);
    context.drawImage(second, 0, 0, width, height);
    other = context.getImageData(0, 0, width, height).data;
  }
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (channel === "alpha") {
      const alpha = other ? Math.abs(data[index + 3]! - other[index + 3]!) : data[index + 3]!;
      data[index] = data[index + 1] = data[index + 2] = alpha;
    } else if (other) {
      for (let offset = 0; offset < 3; offset += 1) data[index + offset] = Math.abs(data[index + offset]! - other[index + offset]!);
    }
    data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}

function Raster({ bitmap, channel, other, testId, style }: { bitmap: ImageBitmap | null; channel: Channel; other?: ImageBitmap | null; testId: string; style?: React.CSSProperties }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current && bitmap) paint(canvas.current, bitmap, channel, other ?? undefined);
  }, [bitmap, channel, other]);
  if (!bitmap) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground" data-testid={`${testId}-none`}>
        <ImageIcon className="size-5" aria-hidden="true" />
        No Preview
      </div>
    );
  }
  return <canvas ref={canvas} className="max-h-full max-w-full object-contain" style={style} data-testid={testId} />;
}

function Well({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="flex min-h-48 min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="truncate text-muted-foreground">{detail}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-sm border border-border" style={CHECKERBOARD}>
        {children}
      </div>
    </div>
  );
}

/** How many Materials reference the Texture, from the registry's headers (no file is read). */
function useMaterialCount(path: string): number {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch;
    const guid = assetRegistry?.getByPath(path)?.header.guid;
    if (!assetRegistry || !guid) return 0;
    return assetRegistry.list().filter((asset) => (asset.header.type === "Material" || asset.header.type === "MaterialInstance") && asset.header.dependencies.includes(guid)).length;
  }, [assetRegistry, registryEpoch, path]);
}

/**
 * A Texture's two versions over a checkerboard: Side By Side, Swipe or the
 * Difference, in RGB or Alpha; its size, file size, source, usage and
 * compression compared; and how many Materials use it.
 */
export function TextureDiffView({ diff, view, baseLabel, compareLabel, toolbar }: {
  diff: AssetDiff;
  view: TextureDiff;
  baseLabel: string;
  compareLabel: string;
  toolbar: (controls: ReactNode) => ReactNode;
}) {
  const [mode, setMode] = useState<Mode>("side-by-side");
  const [channel, setChannel] = useState<Channel>("rgb");
  const [swipe, setSwipe] = useState(50);
  const bitmaps = useBitmaps(view.base, view.compare);
  const materials = useMaterialCount(diff.path);
  const controls = (
    <>
      <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="View" value={[mode]} onValueChange={(value) => { if (value[0]) setMode(value[0] as Mode); }}>
        <ToggleGroupItem value="side-by-side" data-testid="diff-texture-side-by-side">Side By Side</ToggleGroupItem>
        <ToggleGroupItem value="swipe" data-testid="diff-texture-swipe">Swipe</ToggleGroupItem>
        <ToggleGroupItem value="difference" data-testid="diff-texture-difference">Difference</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Channels" value={[channel]} onValueChange={(value) => { if (value[0]) setChannel(value[0] as Channel); }}>
        <ToggleGroupItem value="rgb" data-testid="diff-texture-rgb">RGB</ToggleGroupItem>
        <ToggleGroupItem value="alpha" data-testid="diff-texture-alpha">Alpha</ToggleGroupItem>
      </ToggleGroup>
    </>
  );
  const size = (row: string) => view.rows.find((entry) => entry.id === row);
  const detail = (side: "base" | "compare") => [size("size")?.[side], size("fileSize")?.[side]].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar(controls)}
      <div className="flex min-h-0 flex-1 flex-wrap gap-2 overflow-auto p-2" data-testid="diff-texture">
        <div className="flex min-h-64 min-w-64 flex-[2] flex-col gap-2">
          {mode === "side-by-side" ? (
            <div className="flex min-h-0 flex-1 flex-wrap gap-2">
              <Well title="Base" detail={`${baseLabel} · ${detail("base")}`}><Raster bitmap={bitmaps.base} channel={channel} testId="diff-texture-base" /></Well>
              <Well title={compareLabel} detail={detail("compare")}><Raster bitmap={bitmaps.compare} channel={channel} testId="diff-texture-compare" /></Well>
            </div>
          ) : mode === "swipe" ? (
            <>
              <Well title={`Base ← → ${compareLabel}`} detail={baseLabel}>
                <div className="relative grid size-full place-items-center">
                  <div className="col-start-1 row-start-1 grid size-full place-items-center"><Raster bitmap={bitmaps.base} channel={channel} testId="diff-texture-base" /></div>
                  <div className="col-start-1 row-start-1 grid size-full place-items-center" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}>
                    <Raster bitmap={bitmaps.compare} channel={channel} testId="diff-texture-compare" />
                  </div>
                </div>
              </Well>
              <Slider value={swipe} min={0} max={100} onValueChange={(value) => setSwipe(Array.isArray(value) ? value[0]! : value)} aria-label="Swipe" />
            </>
          ) : (
            <Well title="Difference" detail={`${baseLabel} → ${compareLabel}`}>
              <Raster bitmap={bitmaps.base && bitmaps.compare ? bitmaps.base : null} other={bitmaps.compare} channel={channel} testId="diff-texture-difference" />
            </Well>
          )}
        </div>
        <aside className="flex min-w-64 flex-1 flex-col gap-2" aria-label="Texture Changes">
          <PropertyDiffTable groups={[{ id: "texture", title: diff.name, status: diff.status, rows: view.rows }]} layout="side-by-side" changedOnly={false} baseLabel={baseLabel} compareLabel={compareLabel} />
          <p className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground" data-testid="diff-texture-materials">
            {materials === 1 ? "Used By 1 Material" : `Used By ${materials} Materials`}
          </p>
        </aside>
      </div>
    </div>
  );
}
