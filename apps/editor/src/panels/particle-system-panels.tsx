import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  AssetPickerControl,
  EntryListEditor,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  selectedPickerIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  PARTICLE_EMITTER_ASSET_TYPES,
  PARTICLE_SYSTEM_MAX_EMITTERS,
  isParticleEmitterAssetType,
  normalizeParticleSystemPayload,
  type ParticleLibraryEmitter,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  creatableAssetTypeLabel,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import {
  PREVIEW_SYSTEM_GUID,
  loadEmittersForPreview,
  systemPreviewLibrary,
} from "../lib/play-particles";
import { ParticlePreviewCanvas } from "../components/particle-preview-canvas";
import { ParticlePreviewSurface } from "../components/particle-preview-surface";

const EMITTER_TYPES: string[] = [...PARTICLE_EMITTER_ASSET_TYPES];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useSystemDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const onChange = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };
  return { payload: asRecord(doc?.content), onChange };
}

export function ParticleSystemPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload } = useSystemDocument();
  return (
    <PanelFrame data-testid="particle-system-preview-panel">
      <ParticleSystemPreview payload={payload} />
    </PanelFrame>
  );
}

export function ParticleSystemDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, onChange } = useSystemDocument();
  return (
    <PanelFrame data-testid="particle-system-details-panel">
      <ParticleSystemEditor payload={payload} onChange={onChange} />
    </PanelFrame>
  );
}

const idleControls = {
  paused: false,
  onPausedChange: () => {},
  onRestart: () => {},
  stats: null,
};

/** Loads each slot's emitter (open tab first, then its document) and previews them together. */
export function ParticleSystemPreview({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const { assetRegistry, openDocuments, loadAssetDocument } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const [emitters, setEmitters] = useState<Map<string, ParticleLibraryEmitter> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const openPayloads = new Map<string, unknown>();
  for (const asset of assets) {
    if (!isParticleEmitterAssetType(asset.header.type)) continue;
    const doc = openDocuments?.find((entry) => entry.ref.path === asset.path);
    if (doc?.content) openPayloads.set(asset.header.guid, doc.content);
  }
  const openKey = JSON.stringify([...openPayloads.entries()]);
  const guidKey = system.emitterGuids.join(",");

  useEffect(() => {
    setLoadError(null);
    if (system.emitterGuids.length === 0) {
      setEmitters(new Map());
      return;
    }
    let cancelled = false;
    void loadEmittersForPreview({
      system,
      assets,
      openPayloads,
      loadDocument: (kind, path) =>
        loadAssetDocument ? loadAssetDocument(kind, path) : Promise.resolve(null),
    })
      .then((next) => {
        if (!cancelled) setEmitters(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "A Particle Emitter could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // assets/openPayloads are rebuilt each render; keys capture the inputs that
    // should refetch Emitter documents. Loaded emitters stay shown meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidKey, openKey, loadAssetDocument, attempt]);

  const content =
    system.emitterGuids.length === 0 ? (
      <ParticlePreviewSurface
        {...idleControls}
        state={{
          status: "empty",
          title: "No Emitters",
          description: "Add Basic Particle Emitters in Details to preview them together.",
        }}
      />
    ) : loadError ? (
      <ParticlePreviewSurface
        {...idleControls}
        state={{
          status: "error",
          description: `${loadError} Check the linked Particle Emitters in Details.`,
          onRetry: () => setAttempt((value) => value + 1),
        }}
      />
    ) : emitters === null ? (
      <ParticlePreviewSurface {...idleControls} state={{ status: "loading" }} />
    ) : (
      <ParticlePreviewCanvas
        library={systemPreviewLibrary(system, emitters)}
        systemGuid={PREVIEW_SYSTEM_GUID}
        testId="particle-system-preview-canvas"
        showSkybox={system.previewSkybox}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="particle-system-preview">
      {content}
    </div>
  );
}

/** Space, Preview Skybox and up to 8 ordered emitter slots (duplicates allowed). */
export function ParticleSystemEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const [pick, setPick] = useState<number | "new" | null>(null);
  const { assetRegistry } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const emitterAssets = assets
    .filter((asset) => isParticleEmitterAssetType(asset.header.type))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  const commit = (next: ParticleSystemPayload) => {
    onChange(normalizeParticleSystemPayload(next) as unknown as Record<string, unknown>);
  };
  const setGuids = (emitterGuids: string[]) => commit({ ...system, emitterGuids });

  const rows: PropertyRow[] = [
    {
      id: "space",
      kind: "enum",
      label: "Space",
      value: system.space,
      defaultValue: "world",
      options: [
        { value: "world", label: "World" },
        { value: "local", label: "Local" },
      ],
      onChange: (space) => commit({ ...system, space: space === "local" ? "local" : "world" }),
    },
    {
      id: "previewSkybox",
      kind: "boolean",
      label: "Preview Skybox",
      value: system.previewSkybox,
      onChange: (previewSkybox) => commit({ ...system, previewSkybox }),
    },
  ];

  return (
    <div className="flex flex-col gap-3 pb-2" data-testid="particle-system-editor">
      <PropertyGrid rows={rows} />
      <div className="px-2">
        <EntryListEditor<string>
          title="Emitters"
          items={system.emitterGuids}
          onChange={setGuids}
          onAdd={() => setPick("new")}
          maxItems={PARTICLE_SYSTEM_MAX_EMITTERS}
          addLabel="Add Emitter"
          countNoun={{ one: "emitter", other: "emitters" }}
          renderItemHeader={({ item, index }) => {
            const asset = emitterAssets.find((entry) => entry.guid === item);
            const id = `particle-system-emitter-${index}`;
            return (
              <Field className="min-w-0 gap-0">
                <FieldLabel className="sr-only" htmlFor={id}>
                  {`Emitter ${index + 1}`}
                </FieldLabel>
                <AssetPickerControl value={item}>
                  <Button
                    type="button"
                    id={id}
                    variant="outline"
                    size="sm"
                    className="w-full min-w-0 justify-start pointer-coarse:min-h-11"
                    onClick={() => setPick(index)}
                    data-testid={id}
                  >
                    {asset ? (
                      selectedPickerIdentity({ ...assetRowIdentity(asset), displayType: undefined })
                    ) : (
                      <span className="text-destructive">Missing Emitter</span>
                    )}
                  </Button>
                </AssetPickerControl>
              </Field>
            );
          }}
          renderItem={({ item }) => {
            const type = emitterAssets.find((entry) => entry.guid === item)?.type;
            return type ? (
              <span className="px-1 text-xs text-muted-foreground">
                {creatableAssetTypeLabel(type as CreatableAssetType)}
              </span>
            ) : null;
          }}
          data-testid="particle-system-emitters"
        />
      </div>
      <AssetPicker
        open={pick !== null}
        onOpenChange={(open) => {
          if (!open) setPick(null);
        }}
        assets={emitterAssets}
        allowedTypes={EMITTER_TYPES}
        title="Pick Emitter"
        allowNone={false}
        onPick={(guid) => {
          if (guid && pick === "new") setGuids([...system.emitterGuids, guid]);
          else if (guid && pick !== null) {
            setGuids(system.emitterGuids.map((entry, index) => (index === pick ? guid : entry)));
          }
          setPick(null);
        }}
        data-testid="particle-system-emitter-picker"
      />
    </div>
  );
}
