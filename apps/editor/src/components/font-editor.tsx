import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ImportProgressDialog, type ImportProgress } from "./import-progress-dialog";
import { CheckIcon, MinusIcon, UploadIcon } from "lucide-react";
import {
  AssetPicker,
  AssetPickerControl,
  NamedListEditor,
  NumberField,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  SelectableText,
  ToolbarStrip,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Button } from "@haptic/ui/components/button";
import { FieldError } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Separator } from "@haptic/ui/components/separator";
import { cn } from "@haptic/ui/lib/utils";
import {
  fontFamilyFromRepresentationFileName,
  glyphsFallingToFallback,
  groupMsdfImportBatch,
  mergeFontAttachPayload,
  msdfAtlasPickError,
  normalizeFontPayload,
} from "@haptic/assets";
import { FontRegistry } from "@haptic/render";
import { pickImportFiles } from "@haptic/vfs";
import {
  useDocumentActions,
  useOpenDocument,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { familyFromAssetPayload, fontEditorStack } from "../lib/font-preview";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const WATERFALL_SIZES = [12, 16, 24, 36, 48] as const;
const GLYPH_ROWS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!?.,:;'\"()[]{}&@#%*+-=/\\_<>~$€£",
] as const;

function useFontDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  return {
    path: doc?.ref.path ?? "",
    payload,
    commit: (next: Record<string, unknown>) => void applyAssetDocumentChange(documentId, next, undefined),
  };
}

export function FontPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { path, payload } = useFontDocument();
  return (
    <PanelFrame data-testid="font-preview-panel">
      <FontPreview path={path} payload={payload} />
    </PanelFrame>
  );
}

export function FontDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { path, payload, commit } = useFontDocument();
  return (
    <PanelFrame data-testid="font-details-panel">
      <FontInspector path={path} payload={payload} onChange={commit} />
    </PanelFrame>
  );
}

/**
 * The family loaded from its source chunk, set in a sample line, a size
 * waterfall and a glyph sheet, with the project fallback stack behind it.
 */
export function FontPreview({ path, payload }: { path: string; payload: Record<string, unknown> }) {
  const { readAssetChunk } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry } = useRegistryState();
  const font = normalizeFontPayload(payload, "Custom Font");
  const [sample, setSample] = useState("The quick brown fox");
  const [size, setSize] = useState(48);
  const [fontsReady, setFontsReady] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontAttempt, setFontAttempt] = useState(0);
  const stack = fontEditorStack({
    family: font.family,
    fallbackGuids: font.fallbackGuids,
    defaultFontGuid: projectDocument?.settings.fonts.defaultFontGuid ?? null,
    globalFallback: projectDocument?.settings.fonts.globalFallback ?? "sans-serif",
    familyForGuid: (guid) => familyFromAssetPayload(assetRegistry?.getByGuid(guid)?.header.payload),
  });
  const fontGuid = assetRegistry?.list().find((asset) => asset.path === path)?.header.guid ?? path;
  useEffect(() => {
    let cancelled = false;
    setFontsReady(false);
    setFontError(null);
    const registry = new FontRegistry();
    void (async () => {
      const bytes = await readAssetChunk(path, "source");
      if (cancelled) return;
      if (bytes && bytes.byteLength > 0) {
        const registered = await registry.register({
          guid: fontGuid,
          family: font.family,
          bytes: bytes.slice().buffer,
          weight: font.weight,
          style: font.style,
        });
        if (!registered) throw new Error(registry.getWarnings()[0]?.message ?? "This font could not be loaded.");
      } else {
        throw new Error("The source font is missing. Import its source file to preview this family.");
      }
      if (!cancelled) setFontsReady(true);
    })().catch((error: unknown) => {
      if (!cancelled) setFontError(error instanceof Error ? error.message : "This font could not be loaded.");
    });
    return () => {
      cancelled = true;
      // Remove this preview's FontFace so each rerun or close releases its bytes.
      registry.dispose();
    };
  }, [fontAttempt, fontGuid, font.family, font.style, font.weight, path, readAssetChunk]);
  const flagged = glyphsFallingToFallback(sample, font.family, (text, measureStack) => {
    if (typeof document === "undefined") {
      return measureStack.includes(font.family) && /[A-Za-z]/.test(text) ? 10 : 7;
    }
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return 0;
    // A large size keeps close advances apart.
    ctx.font = `64px ${measureStack}`;
    return ctx.measureText(text).width;
  });
  const shown = { fontFamily: stack, fontWeight: font.weight, fontStyle: font.style };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="font-editor">
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="font-preview-toolbar">
        <Input
          aria-label="Sample Text"
          data-testid="font-sample-input"
          className="h-7 w-56 text-xs pointer-coarse:h-11"
          value={sample}
          onChange={(event) => setSample(event.target.value)}
        />
        <Separator orientation="vertical" className="my-1" />
        <span className="text-xs text-muted-foreground">Size</span>
        <NumberField
          integer
          aria-label="Sample Size"
          unit="px"
          data-testid="font-sample-size"
          className={cn("h-7 w-16 text-xs", TOOL_ITEM)}
          min={6}
          max={200}
          value={size}
          onChange={setSize}
        />
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" data-testid="font-fallback-glyphs">
          {fontError
            ? null
            : !fontsReady
              ? <span role="status">Loading Font…</span>
              : flagged.length > 0
                ? `Fallback glyphs: ${flagged.join(" ")}`
                : "No fallback glyphs detected"}
        </span>
      </ToolbarStrip>
      <div className="min-h-0 flex-1 overflow-auto bg-sidebar">
        {fontError ? (
          <Alert className="m-3 w-auto">
            <AlertTitle>Font Preview Unavailable</AlertTitle>
            <AlertDescription>
              <SelectableText>{fontError} The sample uses a fallback font.</SelectableText>
              <Button type="button" variant="outline" size="sm" onClick={() => setFontAttempt((attempt) => attempt + 1)}>Retry</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <section className="border-b border-border px-4 py-5">
          <p
            className="break-words leading-tight text-foreground"
            data-testid="font-sample-preview"
            data-fonts-ready={fontsReady ? "true" : "false"}
            data-font-stack={stack}
            style={{ ...shown, fontSize: size }}
          >
            <SelectableText>{sample}</SelectableText>
          </p>
        </section>
        <section className="flex flex-col border-b border-border py-2" data-testid="font-waterfall">
          {WATERFALL_SIZES.map((px) => (
            <div key={px} className="flex items-baseline gap-3 px-4 py-1">
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{px}</span>
              <span className="min-w-0 truncate text-foreground" style={{ ...shown, fontSize: px }}>{sample || font.family}</span>
            </div>
          ))}
        </section>
        <section className="px-4 py-3" data-testid="font-glyphs">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Glyphs</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] overflow-hidden rounded-md border-l border-t border-border">
            {GLYPH_ROWS.join("").split("").map((glyph, index) => (
              <span
                key={`${glyph}-${index}`}
                className="flex aspect-square items-center justify-center border-b border-r border-border bg-background text-xl text-foreground"
                style={shown}
              >
                {glyph}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Family, fallback order and the stored representations, with MSDF atlas import. */
export function FontInspector({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { assetRegistry } = useRegistryState();
  const font = normalizeFontPayload(payload, "Custom Font");
  // The attach awaits storage; its follow-up commit starts from the document
  // as it is then, not from the render that started the import.
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const [fallbackPick, setFallbackPick] = useState<number | "new" | null>(null);
  const [msdfError, setMsdfError] = useState<string | null>(null);
  const [msdfConfirm, setMsdfConfirm] = useState<{
    files: Array<{ name: string; bytes: Uint8Array }>;
    family: string;
  } | null>(null);
  const indexedFont = assetRegistry?.list().find((asset) => asset.path === path);
  const [msdfProgress, setMsdfProgress] = useState<ImportProgress | null>(null);
  const msdfJob = useRef<AbortController | null>(null);

  const attachMsdfFiles = async (files: Array<{ name: string; bytes: Uint8Array }>) => {
    if (!assetRegistry || !indexedFont || msdfJob.current) return;
    const prepared = groupMsdfImportBatch(files);
    const folder = indexedFont.path.includes("/")
      ? indexedFont.path.slice(0, indexedFont.path.lastIndexOf("/")).replace(/^assets\//, "")
      : "";
    const job = new AbortController();
    msdfJob.current = job;
    try {
      for (const [index, file] of prepared.entries()) {
        setMsdfProgress((current) => ({
          title: "Importing",
          phase: file.name,
          completed: index,
          total: prepared.length,
          fraction: null,
          canceling: current?.canceling ?? false,
        }));
        await assetRegistry.importFile(indexedFont.rootId, folder, file.name, file.bytes, {
          sidecars: file.sidecars,
          attachToGuid: indexedFont.header.guid,
          signal: job.signal,
        });
      }
    } catch (error) {
      if (job.signal.aborted) return;
      throw error;
    } finally {
      msdfJob.current = null;
      setMsdfProgress(null);
    }
    const updated = assetRegistry.getByGuid(indexedFont.header.guid);
    if (updated) {
      // A saved Font keeps its payload in the document chunk, so the header
      // only reliably carries the newly attached representation flags. Merge
      // those into the open document instead of replacing it with the header.
      const attached = normalizeFontPayload(updated.header.payload, font.family);
      onChange(
        mergeFontAttachPayload(
          payloadRef.current,
          { representations: attached.representations },
          font.family,
        ) as unknown as Record<string, unknown>,
      );
    }
  };
  const fontAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "Font" && asset.path !== path)
    .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));

  const importMsdf = () => {
    void (async () => {
      try {
        const files = await pickImportFiles({ multiple: true, accept: ".json,.png" });
        if (!files.length) return;
        const error = msdfAtlasPickError(files);
        if (error) {
          setMsdfError(error);
          return;
        }
        setMsdfError(null);
        const json = files.find((file) => file.name.toLowerCase().endsWith(".json"));
        const family = json ? fontFamilyFromRepresentationFileName(json.name) : "";
        if (family && family.toLowerCase() !== font.family.toLowerCase()) {
          setMsdfConfirm({ files, family });
          return;
        }
        await attachMsdfFiles(files);
      } catch (err) {
        setMsdfError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const representations = [
    ["font-rep-source", "Source Font", font.representations.source],
    ["font-rep-typeface", "Typeface", font.representations.facetype],
    ["font-rep-msdf-json", "MSDF JSON", font.representations.msdfJson],
    ["font-rep-msdf-atlas", "MSDF Atlas", font.representations.msdfPng],
  ] as const;

  return (
    <div className="flex flex-col" data-testid="font-inspector">
      <PropertySectionTitle>Font</PropertySectionTitle>
      <PropertyGrid
        rows={[
          {
            id: "family",
            kind: "text",
            label: "Family",
            value: font.family,
            onChange: (value) => onChange({ ...font, family: value }),
          },
        ]}
      />
      <PropertySectionTitle>Fallbacks</PropertySectionTitle>
      <div className="px-1 py-1">
        <NamedListEditor
          values={font.fallbackGuids}
          onChange={(fallbackGuids) => onChange({ ...font, fallbackGuids })}
          addLabel="Add Fallback"
          onAdd={() => setFallbackPick("new")}
          data-testid="font-fallbacks"
          renderItem={({ value, index }) => (
            <AssetPickerControl value={value}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-h-7 w-full justify-start pointer-coarse:min-h-11"
                data-testid={`font-fallback-${index}`}
                onClick={() => setFallbackPick(index)}
              >
                {selectedPickerIdentity(
                  assetRowIdentity(
                    (() => {
                      const asset = assetRegistry?.getByGuid(value);
                      return asset ? { name: asset.header.name, type: asset.header.type } : undefined;
                    })(),
                  ),
                  value,
                )}
              </Button>
            </AssetPickerControl>
          )}
        />
        {font.fallbackGuids.length === 0 ? (
          <p className="px-1 pb-1 text-xs text-muted-foreground">Missing glyphs use the project default font, then the global fallback.</p>
        ) : null}
      </div>
      <PropertySectionTitle
        aside={
          <Button type="button" variant="ghost" size="xs" className={TOOL_ITEM} data-testid="font-import-msdf" onClick={importMsdf}>
            <UploadIcon />
            Import MSDF Atlas
          </Button>
        }
      >
        Representations
      </PropertySectionTitle>
      <ul className="flex flex-col py-1" data-testid="font-representations">
        {representations.map(([id, label, present]) => (
          <li key={id} className="flex items-center justify-between gap-2 px-2 py-1 text-xs" data-testid={id} data-present={present ? "true" : "false"}>
            <span>{label}</span>
            <span className={cn("flex items-center gap-1", present ? "text-foreground" : "text-muted-foreground")}>
              {present ? <CheckIcon className="size-3.5" /> : <MinusIcon className="size-3.5" />}
              {present ? "Present" : "Missing"}
            </span>
          </li>
        ))}
      </ul>
      {!font.representations.msdf ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          MSDF text needs a JSON glyph map and an atlas PNG (msdf-bmfont). Import both together.
        </p>
      ) : null}
      {msdfError ? <FieldError className="px-2 pb-2">{msdfError}</FieldError> : null}
      <AssetPicker
        open={fallbackPick !== null}
        onOpenChange={(open) => {
          if (!open) setFallbackPick(null);
        }}
        assets={fontAssets}
        allowedTypes={["Font"]}
        title="Pick Fallback Font"
        allowNone={fallbackPick !== "new"}
        onPick={(guid) => {
          if (fallbackPick === "new") {
            if (guid) onChange({ ...font, fallbackGuids: [...font.fallbackGuids, guid] });
          } else if (typeof fallbackPick === "number") {
            const fallbackGuids = [...font.fallbackGuids];
            if (guid) fallbackGuids[fallbackPick] = guid;
            else fallbackGuids.splice(fallbackPick, 1);
            onChange({ ...font, fallbackGuids });
          }
          setFallbackPick(null);
        }}
        data-testid="font-fallback-picker"
      />
      <AlertDialog
        open={msdfConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setMsdfConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attach MSDF Atlas</AlertDialogTitle>
            <AlertDialogDescription>
              {msdfConfirm ? `This atlas is named ${msdfConfirm.family}. Attach it to ${font.family} anyway?` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = msdfConfirm;
                setMsdfConfirm(null);
                if (pending) {
                  attachMsdfFiles(pending.files).catch((error: unknown) =>
                    setMsdfError(error instanceof Error ? error.message : String(error)));
                }
              }}
            >
              Attach
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ImportProgressDialog
        progress={msdfProgress}
        onCancel={() => {
          msdfJob.current?.abort();
          setMsdfProgress((current) => current && { ...current, canceling: true });
        }}
      />
    </div>
  );
}
