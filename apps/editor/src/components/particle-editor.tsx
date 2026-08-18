import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_PREWARM_CYCLES_MAX,
  PARTICLE_SYSTEM_MAX_EMITTERS,
  normalizeParticleEmitterPayload,
  normalizeParticleSystemPayload,
  type ParticleEmitterPayload,
  type ParticleEmitterShape,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { isParticleMaterialForPicker } from "../lib/content-browser-helpers";
import {
  emitterPreviewLibrary,
  emittersFromRegistry,
  systemPreviewLibrary,
} from "../lib/play-particles";
import { ParticlePreviewCanvas } from "./particle-preview-canvas";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

type IndexedAsset = {
  header: {
    guid: string;
    name: string;
    type: string;
    payload?: Record<string, unknown>;
  };
  path: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickerAssets(
  list: ReadonlyArray<IndexedAsset>,
  allowedTypes: readonly string[],
) {
  return list
    .filter((asset) => allowedTypes.includes(asset.header.type))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
}

function identityFor(
  assets: ReadonlyArray<IndexedAsset>,
  guid: string | null,
) {
  const asset = guid
    ? assets.find((entry) => entry.header.guid === guid)
    : undefined;
  return asset
    ? assetRowIdentity({ name: asset.header.name, type: asset.header.type })
    : {};
}

function defaultShape(kind: ParticleEmitterShape["kind"]): ParticleEmitterShape {
  if (kind === "box") {
    return {
      kind: "box",
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
      direction1: [0, 1, 0],
      direction2: [0, 1, 0],
    };
  }
  if (kind === "sphere") {
    return { kind: "sphere", radius: 0.5, radiusRange: 1 };
  }
  if (kind === "cone") {
    return { kind: "cone", radius: 0.25, angle: Math.PI / 6 };
  }
  return {
    kind: "point",
    direction1: [0, 1, 0],
    direction2: [0, 1, 0],
  };
}

function shapeRows(
  emitter: ParticleEmitterPayload,
  commit: (next: ParticleEmitterPayload) => void,
): PropertyRow[] {
  const shape = emitter.shape;
  if (shape.kind === "point" || shape.kind === "box") {
    const rows: PropertyRow[] = [
      {
        id: "direction1",
        kind: "vector3",
        label: "Direction Min",
        value: shape.direction1,
        onChange: (value) =>
          commit({
            ...emitter,
            shape: {
              ...shape,
              direction1: [value[0], value[1], value[2]],
            },
          }),
      },
      {
        id: "direction2",
        kind: "vector3",
        label: "Direction Max",
        value: shape.direction2,
        onChange: (value) =>
          commit({
            ...emitter,
            shape: {
              ...shape,
              direction2: [value[0], value[1], value[2]],
            },
          }),
      },
    ];
    if (shape.kind === "box") {
      rows.push(
        {
          id: "box-min",
          kind: "vector3",
          label: "Box Min",
          value: shape.min,
          onChange: (value) =>
            commit({
              ...emitter,
              shape: { ...shape, min: [value[0], value[1], value[2]] },
            }),
        },
        {
          id: "box-max",
          kind: "vector3",
          label: "Box Max",
          value: shape.max,
          onChange: (value) =>
            commit({
              ...emitter,
              shape: { ...shape, max: [value[0], value[1], value[2]] },
            }),
        },
      );
    }
    return rows;
  }
  if (shape.kind === "sphere") {
    return [
      {
        id: "sphere-radius",
        kind: "number",
        label: "Radius",
        value: shape.radius,
        min: 0,
        onChange: (radius) => commit({ ...emitter, shape: { ...shape, radius } }),
      },
      {
        id: "sphere-radius-range",
        kind: "slider",
        label: "Radius Range",
        value: shape.radiusRange,
        min: 0,
        max: 1,
        onChange: (radiusRange) =>
          commit({ ...emitter, shape: { ...shape, radiusRange } }),
      },
    ];
  }
  return [
    {
      id: "cone-radius",
      kind: "number",
      label: "Radius",
      value: shape.radius,
      min: 0,
      onChange: (radius) => commit({ ...emitter, shape: { ...shape, radius } }),
    },
    {
      id: "cone-angle",
      kind: "number",
      label: "Angle",
      value: shape.angle * RAD_TO_DEG,
      min: 0,
      max: 180,
      onChange: (degrees) =>
        commit({
          ...emitter,
          shape: { ...shape, angle: degrees * DEG_TO_RAD },
        }),
    },
  ];
}

function patchColorKey(
  emitter: ParticleEmitterPayload,
  end: boolean,
  rgb: [number, number, number] | null,
  alpha: number | null,
): ParticleEmitterPayload {
  const keys = emitter.colorGradient.map((key) => ({
    t: key.t,
    color: [...key.color] as [number, number, number, number],
  }));
  const index = end ? keys.length - 1 : 0;
  const current = keys[index];
  if (!current) return emitter;
  if (rgb) {
    current.color[0] = rgb[0];
    current.color[1] = rgb[1];
    current.color[2] = rgb[2];
  }
  if (alpha !== null) current.color[3] = alpha;
  return { ...emitter, colorGradient: keys };
}

export function ParticleEmitterPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="particle-emitter-preview-panel">
      <ParticleEmitterPreview payload={asRecord(doc?.content)} />
    </PanelFrame>
  );
}

export function ParticleEmitterDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="particle-emitter-details-panel">
      <ParticleEmitterEditor
        payload={asRecord(doc?.content)}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function ParticleSystemPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="particle-system-preview-panel">
      <ParticleSystemPreview payload={asRecord(doc?.content)} />
    </PanelFrame>
  );
}

export function ParticleSystemDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="particle-system-details-panel">
      <ParticleSystemEditor
        payload={asRecord(doc?.content)}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function ParticleEmitterPreview({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const emitter = normalizeParticleEmitterPayload(payload);
  return (
    <div className="flex h-full flex-col p-3" data-testid="particle-emitter-preview">
      {emitter.textureGuid ? (
        <ParticlePreviewCanvas
          library={emitterPreviewLibrary(emitter)}
          systemGuid="preview-sys"
          testId="particle-emitter-preview-canvas"
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Texture</EmptyTitle>
            <EmptyDescription>
              Pick a Texture in Details. Babylon billboard quads need
              particleTexture.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

export function ParticleSystemPreview({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const { assetRegistry, openDocuments } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const openPayloads = new Map<string, unknown>();
  for (const asset of assets) {
    if (asset.header.type !== "ParticleEmitter") continue;
    const doc = openDocuments?.find((entry) => entry.ref.path === asset.path);
    if (doc?.content) openPayloads.set(asset.header.guid, doc.content);
  }
  const emitters = emittersFromRegistry(assets, openPayloads);
  return (
    <div className="flex h-full flex-col p-3" data-testid="particle-system-preview">
      {system.emitterGuids.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Emitters</EmptyTitle>
            <EmptyDescription>
              Add Particle Emitter slots in Details. Play starts one Babylon
              system per slot on the actor.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ParticlePreviewCanvas
          library={systemPreviewLibrary(system, emitters)}
          systemGuid="preview-sys"
          testId="particle-system-preview-canvas"
        />
      )}
    </div>
  );
}

export function ParticleEmitterEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const emitter = normalizeParticleEmitterPayload(payload);
  const [pickTarget, setPickTarget] = useState<"texture" | "material" | null>(
    null,
  );
  const { assetRegistry, openDocuments } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const commit = (next: ParticleEmitterPayload) => {
    onChange(
      normalizeParticleEmitterPayload(next) as unknown as Record<string, unknown>,
    );
  };
  const start = emitter.colorGradient[0]?.color ?? [1, 1, 1, 1];
  const end =
    emitter.colorGradient[emitter.colorGradient.length - 1]?.color ?? [
      1, 1, 1, 0,
    ];
  const textureIdentity = identityFor(assets, emitter.textureGuid);
  const materialIdentity = identityFor(assets, emitter.materialGuid);
  const materialAssets = pickerAssets(
    assets.filter((asset) =>
      isParticleMaterialForPicker(asset, openDocuments ?? []),
    ),
    ["Material"],
  );

  const rows: PropertyRow[] = [
    {
      id: "texture",
      kind: "asset",
      label: "Texture",
      value: emitter.textureGuid,
      placeholder: "None",
      onPick: () => setPickTarget("texture"),
      onChange: (textureGuid) => commit({ ...emitter, textureGuid }),
      ...textureIdentity,
    },
    {
      id: "material",
      kind: "asset",
      label: "Material",
      value: emitter.materialGuid,
      placeholder: "None",
      onPick: () => setPickTarget("material"),
      onChange: (materialGuid) => commit({ ...emitter, materialGuid }),
      ...materialIdentity,
    },
    {
      id: "capacity",
      kind: "number",
      label: "Capacity",
      value: emitter.capacity,
      min: PARTICLE_CAPACITY_MIN,
      max: PARTICLE_CAPACITY_MAX,
      onChange: (capacity) => commit({ ...emitter, capacity }),
    },
    {
      id: "emitRate",
      kind: "number",
      label: "Emit Rate",
      value: emitter.emitRate,
      min: 0,
      onChange: (emitRate) => commit({ ...emitter, emitRate }),
    },
    {
      id: "blendMode",
      kind: "enum",
      label: "Blend Mode",
      value: emitter.blendMode,
      options: [
        { value: "standard", label: "Standard" },
        { value: "additive", label: "Additive" },
      ],
      onChange: (blendMode) =>
        commit({
          ...emitter,
          blendMode: blendMode === "standard" ? "standard" : "additive",
        }),
    },
    {
      id: "shape",
      kind: "enum",
      label: "Shape",
      value: emitter.shape.kind,
      options: [
        { value: "point", label: "Point" },
        { value: "box", label: "Box" },
        { value: "sphere", label: "Sphere" },
        { value: "cone", label: "Cone" },
      ],
      onChange: (kind) =>
        commit({
          ...emitter,
          shape: defaultShape(kind as ParticleEmitterShape["kind"]),
        }),
    },
    ...shapeRows(emitter, commit),
    {
      id: "minLifeTime",
      kind: "number",
      label: "Min Life Time",
      value: emitter.minLifeTime,
      min: 0,
      onChange: (minLifeTime) => commit({ ...emitter, minLifeTime }),
    },
    {
      id: "maxLifeTime",
      kind: "number",
      label: "Max Life Time",
      value: emitter.maxLifeTime,
      min: 0,
      onChange: (maxLifeTime) => commit({ ...emitter, maxLifeTime }),
    },
    {
      id: "minEmitPower",
      kind: "number",
      label: "Min Emit Power",
      value: emitter.minEmitPower,
      min: 0,
      onChange: (minEmitPower) => commit({ ...emitter, minEmitPower }),
    },
    {
      id: "maxEmitPower",
      kind: "number",
      label: "Max Emit Power",
      value: emitter.maxEmitPower,
      min: 0,
      onChange: (maxEmitPower) => commit({ ...emitter, maxEmitPower }),
    },
    {
      id: "minSize",
      kind: "number",
      label: "Min Size",
      value: emitter.minSize,
      min: 0,
      onChange: (minSize) => commit({ ...emitter, minSize }),
    },
    {
      id: "maxSize",
      kind: "number",
      label: "Max Size",
      value: emitter.maxSize,
      min: 0,
      onChange: (maxSize) => commit({ ...emitter, maxSize }),
    },
    {
      id: "gravity",
      kind: "vector3",
      label: "Gravity",
      value: emitter.gravity,
      onChange: (value) =>
        commit({ ...emitter, gravity: [value[0], value[1], value[2]] }),
    },
    {
      id: "color-start",
      kind: "color",
      label: "Color Start",
      value: [start[0], start[1], start[2]],
      onChange: (rgb) => commit(patchColorKey(emitter, false, rgb, null)),
    },
    {
      id: "color-start-alpha",
      kind: "slider",
      label: "Color Start Alpha",
      value: start[3],
      min: 0,
      max: 1,
      onChange: (alpha) => commit(patchColorKey(emitter, false, null, alpha)),
    },
    {
      id: "color-end",
      kind: "color",
      label: "Color End",
      value: [end[0], end[1], end[2]],
      onChange: (rgb) => commit(patchColorKey(emitter, true, rgb, null)),
    },
    {
      id: "color-end-alpha",
      kind: "slider",
      label: "Color End Alpha",
      value: end[3],
      min: 0,
      max: 1,
      onChange: (alpha) => commit(patchColorKey(emitter, true, null, alpha)),
    },
    {
      id: "minAngularSpeed",
      kind: "number",
      label: "Min Angular Speed",
      value: emitter.minAngularSpeed,
      onChange: (minAngularSpeed) => commit({ ...emitter, minAngularSpeed }),
    },
    {
      id: "maxAngularSpeed",
      kind: "number",
      label: "Max Angular Speed",
      value: emitter.maxAngularSpeed,
      onChange: (maxAngularSpeed) => commit({ ...emitter, maxAngularSpeed }),
    },
    {
      id: "preWarmCycles",
      kind: "number",
      label: "Pre Warm Cycles",
      value: emitter.preWarmCycles,
      min: 0,
      max: PARTICLE_PREWARM_CYCLES_MAX,
      onChange: (preWarmCycles) => commit({ ...emitter, preWarmCycles }),
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="particle-emitter-editor">
      <PropertyGrid rows={rows} />
      <AssetPicker
        open={pickTarget === "texture"}
        onOpenChange={(open) => {
          if (!open) setPickTarget(null);
        }}
        assets={pickerAssets(assets, ["Texture"])}
        allowedTypes={["Texture"]}
        title="Pick Texture"
        allowNone
        onPick={(textureGuid) => {
          commit({ ...emitter, textureGuid });
          setPickTarget(null);
        }}
        data-testid="particle-emitter-texture-picker"
      />
      <AssetPicker
        open={pickTarget === "material"}
        onOpenChange={(open) => {
          if (!open) setPickTarget(null);
        }}
        assets={materialAssets}
        allowedTypes={["Material"]}
        title="Pick Particle Material"
        allowNone
        onPick={(materialGuid) => {
          commit({ ...emitter, materialGuid });
          setPickTarget(null);
        }}
        data-testid="particle-emitter-material-picker"
      />
    </div>
  );
}

export function ParticleSystemEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const system = normalizeParticleSystemPayload(payload);
  const [pickIndex, setPickIndex] = useState<number | "new" | null>(null);
  const { assetRegistry } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const commit = (next: ParticleSystemPayload) => {
    onChange(
      normalizeParticleSystemPayload(next) as unknown as Record<string, unknown>,
    );
  };
  const slotCount = Math.max(1, system.emitterGuids.length);
  const slots: Array<string | null> = Array.from(
    { length: slotCount },
    (_, index) => system.emitterGuids[index] ?? null,
  );

  const setSlot = (index: number, guid: string | null) => {
    const next = [...system.emitterGuids];
    if (guid === null) {
      if (index < next.length) next.splice(index, 1);
    } else if (index >= next.length) {
      next.push(guid);
    } else {
      next[index] = guid;
    }
    commit({
      ...system,
      emitterGuids: next.slice(0, PARTICLE_SYSTEM_MAX_EMITTERS),
    });
  };

  const rows: PropertyRow[] = [
    {
      id: "space",
      kind: "enum",
      label: "Space",
      value: system.space,
      options: [
        { value: "world", label: "World" },
        { value: "local", label: "Local" },
      ],
      onChange: (space) =>
        commit({ ...system, space: space === "local" ? "local" : "world" }),
    },
    {
      id: "looping",
      kind: "boolean",
      label: "Looping",
      value: system.looping,
      onChange: (looping) => commit({ ...system, looping }),
    },
    {
      id: "duration",
      kind: "number",
      label: "Duration",
      value: system.duration,
      min: 0,
      onChange: (duration) => commit({ ...system, duration }),
    },
  ];

  slots.forEach((guid, index) => {
    const identity = identityFor(assets, guid);
    rows.push({
      id: `emitter-${index}`,
      kind: "asset",
      label: `Emitter ${index + 1}`,
      value: guid,
      placeholder: "None",
      onPick: () => setPickIndex(index),
      onChange: (nextGuid) => setSlot(index, nextGuid),
      ...identity,
    });
  });

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="particle-system-editor">
      <PropertyGrid rows={rows} />
      {system.emitterGuids.length < PARTICLE_SYSTEM_MAX_EMITTERS ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)]"
          data-testid="particle-system-add-emitter"
          onClick={() => setPickIndex("new")}
        >
          Add Emitter
        </Button>
      ) : null}
      <AssetPicker
        open={pickIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPickIndex(null);
        }}
        assets={pickerAssets(assets, ["ParticleEmitter"])}
        allowedTypes={["ParticleEmitter"]}
        title="Pick Particle Emitter"
        allowNone={pickIndex !== "new"}
        onPick={(guid) => {
          if (pickIndex === null) return;
          if (pickIndex === "new") {
            if (guid) {
              commit({
                ...system,
                emitterGuids: [...system.emitterGuids, guid].slice(
                  0,
                  PARTICLE_SYSTEM_MAX_EMITTERS,
                ),
              });
            }
          } else {
            setSlot(pickIndex, guid);
          }
          setPickIndex(null);
        }}
        data-testid="particle-system-emitter-picker"
      />
    </div>
  );
}
