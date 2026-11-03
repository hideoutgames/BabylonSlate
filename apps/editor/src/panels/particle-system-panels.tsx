import { useEffect, useRef, useState } from "react";
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
} from "@haptic/editor-kit";
import {
  PARTICLE_EMITTER_ASSET_TYPES,
  PARTICLE_SYSTEM_MAX_EMITTERS,
  isParticleEmitterAssetType,
  normalizeParticleSystemPayload,
  particleSystemParameters,
  type ParticleLibraryEmitter,
  type ParticleSystemPayload,
} from "@haptic/assets";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
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
import { particleParameterValueRow } from "../lib/particle-parameter-rows";

const EMITTER_TYPES: string[] = [...PARTICLE_EMITTER_ASSET_TYPES];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useSystemDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
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

function sameEntries(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

const idleControls = {
  paused: false,
  onPausedChange: () => {},
  onRestart: () => {},
  stats: null,
};

/**
 * Loads each slot's Basic emitter or Particle Graph (open tab first, then its
 * document) and previews them together.
 */
/** Basic emitters and Particle Graphs: the asset types a system can reference. */
const EMITTER_KINDS = ["particle-emitter", "particle-graph"] as const;

/**
 * The System's slot emitters, from open tabs first, else loaded from the project; refetched
 * when the slots or an open emitter change. Loaded emitters stay shown while a refetch runs.
 */
function useSystemEmitters(system: ParticleSystemPayload) {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const emitterDocuments = useOpenDocumentsOfKinds(EMITTER_KINDS);
  const assets = assetRegistry?.list() ?? [];
  const [emitters, setEmitters] = useState<Map<string, ParticleLibraryEmitter> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Only this system's emitters matter. An edit replaces an open tab's content
  // object, so the same objects mean nothing the preview reads has changed.
  const slotGuids = new Set(system.emitterGuids);
  const nextOpenPayloads = new Map<string, unknown>();
  for (const asset of assets) {
    if (!slotGuids.has(asset.header.guid) || !isParticleEmitterAssetType(asset.header.type)) continue;
    const doc = emitterDocuments.find((entry) => entry.ref.path === asset.path);
    if (doc?.content) nextOpenPayloads.set(asset.header.guid, doc.content);
  }
  const openPayloadsRef = useRef(nextOpenPayloads);
  if (!sameEntries(openPayloadsRef.current, nextOpenPayloads)) {
    openPayloadsRef.current = nextOpenPayloads;
  }
  const openPayloads = openPayloadsRef.current;
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
            error instanceof Error ? error.message : "An emitter could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // assets and system are rebuilt each render; guidKey and openPayloads capture
    // the inputs that should refetch Emitter documents. Loaded emitters stay
    // shown meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidKey, openPayloads, loadAssetDocument, attempt]);
  return { emitters, loadError, retry: () => setAttempt((value) => value + 1) };
}

/** The System's derived parameters (`particleSystemParameters`), with and without its own defaults. */
function systemParameters(system: ParticleSystemPayload, emitters: ReadonlyMap<string, ParticleLibraryEmitter> | null) {
  if (!emitters) return { parameters: [], conflicts: [], emitterDefaults: new Map<string, number[]>() };
  const library = (payload: ParticleSystemPayload) => ({ emitters, systems: new Map([[PREVIEW_SYSTEM_GUID, payload]]) });
  const derived = particleSystemParameters(library(system), PREVIEW_SYSTEM_GUID);
  const plain = particleSystemParameters(library({ ...system, parameterDefaults: {} }), PREVIEW_SYSTEM_GUID);
  return { ...derived, emitterDefaults: new Map(plain.parameters.map((parameter) => [parameter.name, parameter.defaultValue])) };
}

export function ParticleSystemPreview({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const { emitters, loadError, retry } = useSystemEmitters(system);

  const content =
    system.emitterGuids.length === 0 ? (
      <ParticlePreviewSurface
        {...idleControls}
        state={{
          status: "empty",
          title: "No Emitters",
          description: "Add Basic Particle Emitters or Particle Graphs in the Inspector.",
        }}
      />
    ) : loadError ? (
      <ParticlePreviewSurface
        {...idleControls}
        state={{
          status: "error",
          description: `${loadError} Check the linked emitters in the Inspector.`,
          onRetry: retry,
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
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}

/**
 * Space, Preview Skybox and up to 8 ordered emitter slots (duplicates allowed), each a
 * Basic Particle Emitter or a Particle Graph.
 */
export function ParticleSystemEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const [pick, setPick] = useState<number | "new" | null>(null);
  const { assetRegistry } = useRegistryState();
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
  const { emitters } = useSystemEmitters(system);
  const { parameters, conflicts, emitterDefaults } = systemParameters(system, emitters);
  const slotList = (slots: readonly number[]) => slots.map((slot) => slot + 1).join(", ");
  const setDefault = (name: string, value: number[] | null) => {
    const parameterDefaults = { ...(system.parameterDefaults ?? {}) };
    if (value) parameterDefaults[name] = value;
    else delete parameterDefaults[name];
    commit({ ...system, parameterDefaults });
  };
  const parameterRows: PropertyRow[] = [
    ...parameters.map((parameter) => {
      const emitterDefault = emitterDefaults.get(parameter.name) ?? parameter.defaultValue;
      return particleParameterValueRow({
        id: `system-parameter-${parameter.name}`,
        label: parameter.name,
        type: parameter.type,
        value: parameter.defaultValue,
        defaultValue: emitterDefault,
        description: `Emitter slot ${slotList(parameter.slots)}.${parameter.overridden ? " The System's default." : ""}`,
        // Back at the emitters' default drops the System's own.
        onChange: (value) => setDefault(parameter.name, JSON.stringify(value) === JSON.stringify(emitterDefault) ? null : value),
      });
    }),
    ...conflicts.map((conflict): PropertyRow => ({
      id: `system-parameter-conflict-${conflict.name}`,
      kind: "info",
      label: `${conflict.name} Conflict`,
      value: `Emitter slot ${slotList(conflict.slots)} reads it with another type and keeps its own default.`,
    })),
  ];

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
      {parameterRows.length ? (
        <div data-testid="particle-system-parameters">
          <PropertyGrid title="Parameters" rows={parameterRows} />
        </div>
      ) : null}
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
