import { useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  EntryListEditor,
  ModuleCard,
  ModuleStack,
  ModuleStage,
  PanelFrame,
  PropertyGrid,
  VALUE_MODE_CONSTANT,
  VALUE_MODE_CURVE,
  VALUE_MODE_GRADIENT,
  VALUE_MODE_RANGE,
  ValueModeField,
  assetRowIdentity,
  type PropertyRow,
  type Vector3Value,
} from "@babylonslate/editor-kit";
import {
  PARTICLE_BILLBOARD_MODE_IDS,
  PARTICLE_BLEND_MODE_IDS,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_CURVE_MAX_KEYS,
  PARTICLE_CURVE_MIN_KEYS,
} from "@babylonslate/core";
import {
  PARTICLE_BURST_MAX_ENTRIES,
  PARTICLE_COLOR_SPEC,
  PARTICLE_EMITTER_LIMITS,
  PARTICLE_SHAPE_KINDS,
  PARTICLE_VALUE_SPECS,
  convertColorValueMode,
  convertScalarValueMode,
  createDefaultParticleShape,
  normalizeParticleEmitterPayload,
  type ParticleBurst,
  type ParticleColorValue,
  type ParticleEmitterPayload,
  type ParticleEmitterShape,
  type ParticleScalarPropertyId,
  type ParticleScalarValue,
  type ParticleShapeDirection,
  type ParticleShapeKind,
  type ParticleValueMode,
  type ParticleVec3Tuple,
} from "@babylonslate/assets";
import {
  basicParticleStageRole,
  type BasicParticleStage,
} from "@babylonslate/ui/lib/data-types";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { isParticleMaterialForPicker } from "../lib/content-browser-helpers";
import {
  PARTICLE_BILLBOARD_LABELS,
  PARTICLE_BLEND_MODE_LABELS,
  PARTICLE_SHAPE_LABELS,
  particleFieldMergeKey,
  particleModuleSummary,
  particleValueDisplay,
  type ParticleModuleId,
} from "../lib/particle-value-modes";
import { PREVIEW_SYSTEM_GUID, emitterPreviewLibrary } from "../lib/play-particles";
import { ParticlePreviewCanvas } from "../components/particle-preview-canvas";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

type RegistryAsset = {
  header: {
    guid: string;
    name: string;
    type: string;
    payload?: Record<string, unknown>;
  };
  path: string;
};

type Commit = (next: ParticleEmitterPayload, path?: string) => void;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function vec3(value: Vector3Value): ParticleVec3Tuple {
  return [value[0], value[1], value[2]];
}

function findAsset(assets: readonly RegistryAsset[], guid: string | null) {
  return guid ? assets.find((entry) => entry.header.guid === guid) : undefined;
}

/** Reads a dotted payload path; scalar spec ids are such paths (`initialize.scale.x`). */
function valueAt(payload: ParticleEmitterPayload, path: string): unknown {
  let value: unknown = payload;
  for (const key of path.split(".")) value = (value as Record<string, unknown>)[key];
  return value;
}

function withValueAt(
  payload: ParticleEmitterPayload,
  path: string,
  value: unknown,
): ParticleEmitterPayload {
  const next = structuredClone(payload);
  const keys = path.split(".");
  let target = next as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys[keys.length - 1]!] = value;
  return next;
}

/**
 * Particle-domain Materials only; an open Material tab's domain wins over its header.
 * Basic emitter and Particle Graph Details and Previews share it.
 */
export function ParticleMaterialPicker({
  open,
  onOpenChange,
  onPick,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (guid: string | null) => void;
  testId: string;
}) {
  const { assetRegistry, openDocuments } = useDocuments();
  const assets = (assetRegistry?.list() ?? [])
    .filter((asset) => isParticleMaterialForPicker(asset, openDocuments ?? []))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  return (
    <AssetPicker
      open={open}
      onOpenChange={onOpenChange}
      assets={assets}
      allowedTypes={["Material"]}
      title="Pick Particle Material"
      allowNone
      onPick={(guid) => {
        onPick(guid);
        onOpenChange(false);
      }}
      data-testid={testId}
    />
  );
}

function useEmitterDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const onChange = (next: Record<string, unknown>, mergeKey?: string) => {
    void applyAssetDocumentChange(documentId, next, mergeKey);
  };
  return { documentId, payload: asRecord(doc?.content), onChange };
}

export function ParticleEmitterPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, onChange } = useEmitterDocument();
  return (
    <PanelFrame data-testid="particle-emitter-preview-panel">
      <ParticleEmitterPreview payload={payload} onChange={onChange} />
    </PanelFrame>
  );
}

export function ParticleEmitterDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId, payload, onChange } = useEmitterDocument();
  return (
    <PanelFrame data-testid="particle-emitter-details-panel">
      <ParticleEmitterEditor
        documentKey={documentId}
        payload={payload}
        onChange={onChange}
      />
    </PanelFrame>
  );
}

/** Basic emitter Preview; No Material offers the panel's own particle Material picker. */
export function ParticleEmitterPreview({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const emitter = normalizeParticleEmitterPayload(payload);
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="particle-emitter-preview">
      <ParticlePreviewCanvas
        library={emitterPreviewLibrary({ kind: "basic", payload: emitter })}
        systemGuid={PREVIEW_SYSTEM_GUID}
        testId="particle-emitter-preview-canvas"
        onPickMaterial={() => setPicking(true)}
      />
      <ParticleMaterialPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(materialGuid) =>
          onChange(
            normalizeParticleEmitterPayload({
              ...emitter,
              render: { ...emitter.render, materialGuid },
            }) as unknown as Record<string, unknown>,
          )
        }
        testId="particle-preview-material-picker"
      />
    </div>
  );
}

/** Card open state per document: UI only, kept across tab switches, never saved. */
const closedModulesByDocument = new Map<string, Set<ParticleModuleId>>();

/** Every module starts open; disabled modules render collapsed regardless. */
function useModuleOpenState(documentKey: string | undefined) {
  const [closed, setClosed] = useState<ReadonlySet<ParticleModuleId>>(
    () => (documentKey && closedModulesByDocument.get(documentKey)) || new Set(),
  );
  const setOpen = (id: ParticleModuleId, open: boolean) => {
    setClosed((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      if (documentKey) closedModulesByDocument.set(documentKey, next);
      return next;
    });
  };
  return { isOpen: (id: ParticleModuleId) => !closed.has(id), setOpen };
}

const SCALAR_MODE_OPTIONS = [VALUE_MODE_CONSTANT, VALUE_MODE_RANGE, VALUE_MODE_CURVE];
const COLOR_MODE_OPTIONS = [VALUE_MODE_CONSTANT, VALUE_MODE_RANGE, VALUE_MODE_GRADIENT];

function modeOptions<O extends { value: ParticleValueMode }>(
  options: readonly O[],
  modes: readonly ParticleValueMode[],
): O[] {
  return options.filter((option) => modes.includes(option.value));
}

type ScalarField = {
  id: string;
  label: string;
  /** Spec id, which is also the payload path that names the undo merge key. */
  spec: ParticleScalarPropertyId;
  value: ParticleScalarValue;
  /** Continuous edits merge per gesture; mode switches are their own undo entry. */
  onChange: (value: ParticleScalarValue, continuous?: boolean) => void;
};

/** One row per value mode; angles show degrees and store radians. */
function scalarRow(field: ScalarField): PropertyRow {
  const spec = PARTICLE_VALUE_SPECS[field.spec];
  const display = particleValueDisplay(spec.unit);
  const shown = (stored: number) => stored * display.scale;
  const stored = (value: number) => value / display.scale;
  const min = shown(spec.min);
  const max = shown(spec.max);
  const options = modeOptions(SCALAR_MODE_OPTIONS, spec.modes);
  const { value } = field;
  const change = (next: ParticleScalarValue) => field.onChange(next, true);
  const base = {
    id: field.id,
    label: field.label,
    unit: display.unit,
    labelAccessory:
      options.length > 1 ? (
        <ValueModeField
          label={field.label}
          value={value.mode}
          options={options}
          onChange={(mode) => field.onChange(convertScalarValueMode(value, mode, spec))}
          data-testid={`value-mode-${field.id}`}
        />
      ) : undefined,
  };
  const fallback = spec.fallback;
  if (value.mode === "range") {
    return {
      ...base,
      kind: "range",
      value: [shown(value.min), shown(value.max)],
      defaultValue:
        fallback.mode === "range" ? [shown(fallback.min), shown(fallback.max)] : undefined,
      min,
      max,
      onChange: ([low, high]) => change({ mode: "range", min: stored(low), max: stored(high) }),
    };
  }
  if (value.mode === "curve") {
    return {
      ...base,
      kind: "curve",
      value: value.keys.map((key) => ({ t: key.t, value: shown(key.value) })),
      // Finite bounds fix the plot's frame, so only tight ones are passed.
      valueMin: spec.min >= 0 ? min : undefined,
      valueMax: spec.unit === "fraction" ? max : undefined,
      axisLabels:
        spec.curveDomain === "emitterTime"
          ? { start: "Start", end: "End" }
          : { start: "Birth", end: "Death" },
      minKeys: PARTICLE_CURVE_MIN_KEYS,
      maxKeys: PARTICLE_CURVE_MAX_KEYS,
      onChange: (keys) =>
        change({
          mode: "curve",
          keys: keys.map((key) => ({ t: key.t, value: stored(key.value) })),
        }),
    };
  }
  return {
    ...base,
    kind: "number",
    value: shown(value.value),
    defaultValue: fallback.mode === "constant" ? shown(fallback.value) : undefined,
    min,
    max,
    onChange: (next) => change({ mode: "constant", value: stored(next) }),
  };
}

function colorRows(
  value: ParticleColorValue,
  onChange: (value: ParticleColorValue, continuous?: boolean) => void,
): PropertyRow[] {
  const accessory = (
    <ValueModeField
      label="Color"
      value={value.mode}
      options={modeOptions(COLOR_MODE_OPTIONS, PARTICLE_COLOR_SPEC.modes)}
      onChange={(mode) =>
        onChange(convertColorValueMode(value, mode, PARTICLE_COLOR_SPEC))
      }
      data-testid="value-mode-color"
    />
  );
  if (value.mode === "range") {
    return [
      {
        id: "color-min",
        kind: "color4",
        label: "Color A",
        labelAccessory: accessory,
        value: value.min,
        onChange: (min) => onChange({ ...value, min }, true),
      },
      {
        id: "color-max",
        kind: "color4",
        label: "Color B",
        description: "Each particle keeps one color between A and B.",
        value: value.max,
        onChange: (max) => onChange({ ...value, max }, true),
      },
    ];
  }
  if (value.mode === "curve") {
    return [
      {
        id: "color",
        kind: "gradient",
        label: "Color",
        labelAccessory: accessory,
        value: value.keys,
        minStops: PARTICLE_CURVE_MIN_KEYS,
        maxStops: PARTICLE_CURVE_MAX_KEYS,
        onChange: (keys) => onChange({ mode: "curve", keys }, true),
      },
    ];
  }
  return [
    {
      id: "color",
      kind: "color4",
      label: "Color",
      labelAccessory: accessory,
      value: value.color,
      onChange: (color) => onChange({ mode: "constant", color }, true),
    },
  ];
}

/** Keeps the fields both shapes share (radius, radius range, directions, randomizer). */
function switchParticleShape(
  current: ParticleEmitterShape,
  kind: ParticleShapeKind,
): ParticleEmitterShape {
  const next = createDefaultParticleShape(kind);
  if ("radius" in current && "radius" in next) {
    next.radius = current.radius;
    next.radiusRange = current.radiusRange;
  }
  let randomizer: number | null = null;
  let directions: [ParticleVec3Tuple, ParticleVec3Tuple] | null = null;
  let directed = false;
  if (current.kind === "point" || current.kind === "box") {
    directions = [current.direction1, current.direction2];
  } else if (current.kind === "hemisphere") {
    randomizer = current.randomizer;
  } else if (current.direction.mode === "radial") {
    randomizer = current.direction.randomizer;
  } else {
    directed = true;
    directions = [current.direction.direction1, current.direction.direction2];
  }
  if (next.kind === "point" || next.kind === "box") {
    if (directions) [next.direction1, next.direction2] = [[...directions[0]], [...directions[1]]];
  } else if (next.kind === "hemisphere") {
    if (randomizer !== null) next.randomizer = randomizer;
  } else if (directed && directions) {
    next.direction = {
      mode: "directed",
      direction1: [...directions[0]],
      direction2: [...directions[1]],
    };
  } else if (randomizer !== null) {
    next.direction = { mode: "radial", randomizer };
  }
  return next;
}

function directionRows(
  shape: Extract<ParticleEmitterShape, { direction: ParticleShapeDirection }>,
  set: SetShape,
): PropertyRow[] {
  const direction = shape.direction;
  const rows: PropertyRow[] = [
    {
      id: "direction",
      kind: "enum",
      label: "Direction",
      value: direction.mode,
      options: [
        { value: "radial", label: "Radial" },
        { value: "directed", label: "Directed" },
      ],
      onChange: (mode) => {
        if (mode === direction.mode) return;
        set({
          ...shape,
          direction:
            mode === "directed"
              ? { mode: "directed", direction1: [0, 1, 0], direction2: [0, 1, 0] }
              : { mode: "radial", randomizer: 0 },
        });
      },
    },
  ];
  if (direction.mode === "radial") {
    rows.push({
      id: "directionRandomizer",
      kind: "slider",
      label: "Direction Randomizer",
      value: direction.randomizer,
      defaultValue: 0,
      min: 0,
      max: 1,
      onChange: (randomizer) =>
        set({ ...shape, direction: { mode: "radial", randomizer } }, "shape.direction.randomizer"),
    });
    return rows;
  }
  rows.push(
    {
      id: "direction1",
      kind: "vector3",
      label: "Direction Min",
      value: direction.direction1,
      onChange: (value) =>
        set(
          { ...shape, direction: { ...direction, direction1: vec3(value) } },
          "shape.direction.direction1",
        ),
    },
    {
      id: "direction2",
      kind: "vector3",
      label: "Direction Max",
      value: direction.direction2,
      onChange: (value) =>
        set(
          { ...shape, direction: { ...direction, direction2: vec3(value) } },
          "shape.direction.direction2",
        ),
    },
  );
  return rows;
}

type SetShape = (shape: ParticleEmitterShape, path?: string) => void;

function shapeRows(shape: ParticleEmitterShape, set: SetShape): PropertyRow[] {
  const limits = PARTICLE_EMITTER_LIMITS;
  const rows: PropertyRow[] = [
    {
      id: "shape",
      kind: "enum",
      label: "Shape",
      value: shape.kind,
      options: PARTICLE_SHAPE_KINDS.map((kind) => ({
        value: kind,
        label: PARTICLE_SHAPE_LABELS[kind],
      })),
      onChange: (kind) => {
        if (kind !== shape.kind) set(switchParticleShape(shape, kind as ParticleShapeKind));
      },
    },
  ];
  const directionPair = (
    target: Extract<ParticleEmitterShape, { kind: "point" | "box" }>,
  ): PropertyRow[] => [
    {
      id: "direction1",
      kind: "vector3",
      label: "Direction Min",
      value: target.direction1,
      onChange: (value) => set({ ...target, direction1: vec3(value) }, "shape.direction1"),
    },
    {
      id: "direction2",
      kind: "vector3",
      label: "Direction Max",
      value: target.direction2,
      onChange: (value) => set({ ...target, direction2: vec3(value) }, "shape.direction2"),
    },
  ];
  if (shape.kind === "point") return [...rows, ...directionPair(shape)];
  if (shape.kind === "box") {
    return [
      ...rows,
      {
        id: "boxMin",
        kind: "vector3",
        label: "Box Min",
        value: shape.min,
        onChange: (value) => set({ ...shape, min: vec3(value) }, "shape.min"),
      },
      {
        id: "boxMax",
        kind: "vector3",
        label: "Box Max",
        value: shape.max,
        onChange: (value) => set({ ...shape, max: vec3(value) }, "shape.max"),
      },
      ...directionPair(shape),
    ];
  }
  const radius: PropertyRow = {
    id: "radius",
    kind: "number",
    label: "Radius",
    value: shape.radius,
    min: limits.radius.min,
    max: limits.radius.max,
    onChange: (value) => set({ ...shape, radius: value }, "shape.radius"),
  };
  const radiusRange: PropertyRow = {
    id: "radiusRange",
    kind: "slider",
    label: "Radius Range",
    description: "0 spawns on the surface; 1 fills the volume.",
    value: shape.radiusRange,
    defaultValue: 1,
    min: 0,
    max: 1,
    onChange: (value) => set({ ...shape, radiusRange: value }, "shape.radiusRange"),
  };
  if (shape.kind === "sphere") {
    return [...rows, radius, radiusRange, ...directionRows(shape, set)];
  }
  if (shape.kind === "hemisphere") {
    return [
      ...rows,
      radius,
      radiusRange,
      {
        id: "directionRandomizer",
        kind: "slider",
        label: "Direction Randomizer",
        value: shape.randomizer,
        defaultValue: 0,
        min: 0,
        max: 1,
        onChange: (randomizer) => set({ ...shape, randomizer }, "shape.randomizer"),
      },
    ];
  }
  if (shape.kind === "cylinder") {
    return [
      ...rows,
      radius,
      {
        id: "height",
        kind: "number",
        label: "Height",
        value: shape.height,
        min: limits.height.min,
        max: limits.height.max,
        onChange: (height) => set({ ...shape, height }, "shape.height"),
      },
      radiusRange,
      ...directionRows(shape, set),
    ];
  }
  return [
    ...rows,
    radius,
    {
      id: "angle",
      kind: "number",
      label: "Angle",
      unit: "deg",
      value: shape.angle * RAD_TO_DEG,
      min: limits.coneAngle.min * RAD_TO_DEG,
      max: limits.coneAngle.max * RAD_TO_DEG,
      onChange: (degrees) => set({ ...shape, angle: degrees * DEG_TO_RAD }, "shape.angle"),
    },
    radiusRange,
    {
      id: "heightRange",
      kind: "slider",
      label: "Height Range",
      value: shape.heightRange,
      defaultValue: 1,
      min: 0,
      max: 1,
      onChange: (heightRange) => set({ ...shape, heightRange }, "shape.heightRange"),
    },
    {
      id: "emitFromSpawnPointOnly",
      kind: "boolean",
      label: "Emit From Spawn Point Only",
      value: shape.emitFromSpawnPointOnly,
      onChange: (emitFromSpawnPointOnly) => set({ ...shape, emitFromSpawnPointOnly }),
    },
    ...directionRows(shape, set),
  ];
}

function burstRows(
  burst: ParticleBurst,
  index: number,
  capacity: number,
  set: (field: keyof ParticleBurst, value: number) => void,
): PropertyRow[] {
  const limits = PARTICLE_EMITTER_LIMITS;
  return [
    {
      id: `burst-${index}-time`,
      kind: "number",
      label: "Time",
      unit: "s",
      value: burst.time,
      min: limits.burstTime.min,
      max: limits.burstTime.max,
      onChange: (time) => set("time", time),
    },
    {
      id: `burst-${index}-count`,
      kind: "number",
      label: "Count",
      value: burst.count,
      min: limits.burstCount.min,
      max: capacity,
      onChange: (count) => set("count", count),
    },
    {
      id: `burst-${index}-cycles`,
      kind: "number",
      label: "Cycles",
      description: burst.cycles === 0 ? "Repeats every Interval until the loop ends." : undefined,
      value: burst.cycles,
      min: limits.burstCycles.min,
      max: limits.burstCycles.max,
      onChange: (cycles) => set("cycles", cycles),
    },
    {
      id: `burst-${index}-interval`,
      kind: "number",
      label: "Interval",
      unit: "s",
      disabled: burst.cycles === 1,
      value: burst.interval,
      min: limits.burstInterval.min,
      max: limits.burstInterval.max,
      onChange: (interval) => set("interval", interval),
    },
  ];
}

type ModuleCardSpec = {
  id: ParticleModuleId;
  title: string;
  /** Toggle modules keep their values while disabled. */
  enabled?: boolean;
  setEnabled?: (enabled: boolean) => void;
  body: ReactNode;
};

type StageSpec = { id: BasicParticleStage; title: string; modules: ModuleCardSpec[] };

/**
 * Basic Particle Emitter Details: a module stack in fixed stage order. Every read
 * normalizes the payload; every continuous edit passes a per-field undo merge key.
 */
export function ParticleEmitterEditor({
  payload,
  onChange,
  documentKey,
}: {
  payload: Record<string, unknown>;
  /** `mergeKey` groups one gesture's edits into one undo entry. */
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
  /** Keeps card open state per document across tab switches. */
  documentKey?: string;
}) {
  const emitter = normalizeParticleEmitterPayload(payload);
  const { assetRegistry } = useDocuments();
  const assets = (assetRegistry?.list() ?? []) as RegistryAsset[];
  const [picking, setPicking] = useState(false);
  const cards = useModuleOpenState(documentKey);
  /** `path` names the per-field undo merge key; discrete edits omit it. */
  const commit: Commit = (next, path) => {
    onChange(
      normalizeParticleEmitterPayload(next) as unknown as Record<string, unknown>,
      path ? particleFieldMergeKey(path) : undefined,
    );
  };
  const { emitter: settings, spawn, initialize, overLife, forces, render } = emitter;
  const material = findAsset(assets, render.materialGuid);
  const materialIdentity = assetRowIdentity(
    material ? { name: material.header.name, type: material.header.type } : undefined,
  );

  /** Continuous edit: `path` also names the per-field undo merge key. */
  const edit = (path: string, value: unknown) => commit(withValueAt(emitter, path, value), path);
  /** Discrete edit (mode switch, toggle, pick): always its own undo entry. */
  const set = (path: string, value: unknown) => commit(withValueAt(emitter, path, value));

  const scalar = (id: string, label: string, spec: ParticleScalarPropertyId) =>
    scalarRow({
      id,
      label,
      spec,
      value: valueAt(emitter, spec) as ParticleScalarValue,
      onChange: (next, continuous) => (continuous ? edit : set)(spec, next),
    });

  /** Toggle modules store `enabled` next to the values they keep while off. */
  const toggle = (path: string) => ({
    enabled: valueAt(emitter, `${path}.enabled`) === true,
    setEnabled: (enabled: boolean) => set(`${path}.enabled`, enabled),
  });

  const emitterRows: PropertyRow[] = [
    {
      id: "material",
      kind: "asset",
      label: "Material",
      value: render.materialGuid,
      placeholder: "No Material",
      description: render.materialGuid
        ? undefined
        : "Pick a Material with the Particle domain.",
      onPick: () => setPicking(true),
      onChange: (materialGuid) => set("render.materialGuid", materialGuid),
      ...materialIdentity,
    },
    {
      id: "capacity",
      kind: "number",
      label: "Capacity",
      value: settings.capacity,
      defaultValue: PARTICLE_CAPACITY_DEFAULT,
      min: PARTICLE_CAPACITY_MIN,
      max: PARTICLE_CAPACITY_MAX,
      onChange: (capacity) => edit("emitter.capacity", capacity),
    },
    {
      id: "loop",
      kind: "enum",
      label: "Loop",
      value: settings.loop,
      options: [
        { value: "infinite", label: "Infinite" },
        { value: "once", label: "Once" },
      ],
      onChange: (loop) => set("emitter.loop", loop),
    },
    {
      id: "duration",
      kind: "number",
      label: "Duration",
      unit: "s",
      description:
        settings.loop === "once"
          ? "How long the emitter spawns before it stops."
          : "One loop; curves over the emitter cycle and Bursts repeat each loop.",
      value: settings.duration,
      min: PARTICLE_EMITTER_LIMITS.duration.min,
      max: PARTICLE_EMITTER_LIMITS.duration.max,
      onChange: (duration) => edit("emitter.duration", duration),
    },
    {
      id: "prewarm",
      kind: "number",
      label: "Pre Warm",
      unit: "s",
      disabled: settings.loop === "once",
      description:
        settings.loop === "once" ? "Pre Warm applies to Infinite loops only." : undefined,
      value: settings.prewarm,
      defaultValue: 0,
      min: PARTICLE_EMITTER_LIMITS.prewarm.min,
      max: PARTICLE_EMITTER_LIMITS.prewarm.max,
      onChange: (prewarm) => edit("emitter.prewarm", prewarm),
    },
  ];

  const bursts = spawn.bursts.entries;

  const stages: StageSpec[] = [
    {
      id: "emitter",
      title: "Emitter",
      modules: [
        { id: "emitter", title: "Emitter", body: <PropertyGrid rows={emitterRows} /> },
      ],
    },
    {
      id: "spawn",
      title: "Spawn",
      modules: [
        {
          id: "spawnRate",
          title: "Spawn Rate",
          body: (
            <PropertyGrid
              rows={[scalar("rate", "Rate", "spawn.rate")]}
            />
          ),
        },
        {
          id: "bursts",
          title: "Bursts",
          ...toggle("spawn.bursts"),
          body: (
            <div className="p-2">
              <EntryListEditor<ParticleBurst>
                items={bursts}
                onChange={(entries) => set("spawn.bursts.entries", entries)}
                onCreate={() => ({ time: 0, count: 10, cycles: 1, interval: 0.5 })}
                maxItems={PARTICLE_BURST_MAX_ENTRIES}
                addLabel="Add Burst"
                countNoun={{ one: "burst", other: "bursts" }}
                renderItemHeader={({ index }) => (
                  <span className="px-1 text-xs font-medium text-muted-foreground">
                    {`Burst ${index + 1}`}
                  </span>
                )}
                renderItem={({ item, index }) => (
                  <PropertyGrid
                    density="compact"
                    rows={burstRows(item, index, settings.capacity, (field, value) =>
                      edit(`spawn.bursts.entries.${index}.${field}`, value),
                    )}
                  />
                )}
                data-testid="particle-emitter-bursts"
              />
            </div>
          ),
        },
      ],
    },
    {
      id: "shape",
      title: "Shape",
      modules: [
        {
          id: "shape",
          title: "Shape",
          body: (
            <PropertyGrid
              rows={shapeRows(emitter.shape, (shape, path) => commit({ ...emitter, shape }, path))}
            />
          ),
        },
      ],
    },
    {
      id: "initialize",
      title: "Initialize",
      modules: [
        {
          id: "initialize",
          title: "Initialize Particle",
          body: (
            <PropertyGrid
              rows={[
                scalar("lifetime", "Lifetime", "initialize.lifetime"),
                scalar("speed", "Speed", "initialize.speed"),
                scalar("size", "Size", "initialize.size"),
                ...colorRows(initialize.color, (color, continuous) =>
                  (continuous ? edit : set)("initialize.color", color),
                ),
              ]}
            />
          ),
        },
        {
          id: "scale",
          title: "Scale",
          ...toggle("initialize.scale"),
          body: (
            <PropertyGrid
              rows={[
                scalar("scaleX", "Scale X", "initialize.scale.x"),
                scalar("scaleY", "Scale Y", "initialize.scale.y"),
              ]}
            />
          ),
        },
        {
          id: "rotation",
          title: "Rotation",
          ...toggle("initialize.rotation"),
          body: (
            <PropertyGrid
              rows={[
                scalar("startRotation", "Start Rotation", "initialize.rotation.start"),
                scalar("rotationSpeed", "Rotation Speed", "initialize.rotation.speed"),
              ]}
            />
          ),
        },
      ],
    },
    {
      id: "overLife",
      title: "Over Life",
      modules: [
        {
          id: "speedOverLife",
          title: "Speed Over Life",
          ...toggle("overLife.velocity"),
          body: (
            <PropertyGrid
              rows={[scalar("speedMultiplier", "Multiplier", "overLife.velocity.multiplier")]}
            />
          ),
        },
        {
          id: "speedLimit",
          title: "Speed Limit",
          ...toggle("overLife.speedLimit"),
          body: (
            <PropertyGrid
              rows={[
                scalar("speedLimit", "Limit", "overLife.speedLimit.limit"),
                {
                  id: "damping",
                  kind: "slider",
                  label: "Damping",
                  description: "Share of the excess speed removed each step.",
                  value: overLife.speedLimit.damping,
                  defaultValue: 0.4,
                  min: 0,
                  max: 1,
                  onChange: (damping) => edit("overLife.speedLimit.damping", damping),
                },
              ]}
            />
          ),
        },
        {
          id: "drag",
          title: "Drag",
          ...toggle("overLife.drag"),
          body: (
            <PropertyGrid
              rows={[scalar("drag", "Drag", "overLife.drag.amount")]}
            />
          ),
        },
      ],
    },
    {
      id: "forces",
      title: "Forces",
      modules: [
        {
          id: "gravity",
          title: "Gravity",
          ...toggle("forces.gravity"),
          body: (
            <PropertyGrid
              rows={[
                {
                  id: "gravity",
                  kind: "vector3",
                  label: "Acceleration",
                  unit: "m/s²",
                  value: forces.gravity.acceleration,
                  defaultValue: [0, -9.81, 0],
                  onChange: (value) => edit("forces.gravity.acceleration", vec3(value)),
                },
              ]}
            />
          ),
        },
      ],
    },
    {
      id: "render",
      title: "Render",
      modules: [
        {
          id: "render",
          title: "Render",
          body: (
            <PropertyGrid
              rows={[
                {
                  id: "blendMode",
                  kind: "enum",
                  label: "Blend Mode",
                  value: render.blendMode,
                  defaultValue: "additive",
                  options: PARTICLE_BLEND_MODE_IDS.map((mode) => ({
                    value: mode,
                    label: PARTICLE_BLEND_MODE_LABELS[mode],
                  })),
                  onChange: (blendMode) => set("render.blendMode", blendMode),
                },
                {
                  id: "billboard",
                  kind: "enum",
                  label: "Billboard",
                  value: render.billboard,
                  defaultValue: "all",
                  options: PARTICLE_BILLBOARD_MODE_IDS.map((mode) => ({
                    value: mode,
                    label: PARTICLE_BILLBOARD_LABELS[mode],
                  })),
                  onChange: (billboard) => set("render.billboard", billboard),
                },
              ]}
            />
          ),
        },
      ],
    },
  ];

  return (
    <>
      <ModuleStack data-testid="particle-emitter-modules">
        {stages.map((stage) => (
          <ModuleStage
            key={stage.id}
            id={stage.id}
            title={stage.title}
            accentRole={basicParticleStageRole(stage.id)}
          >
            {stage.modules.map((module) => {
              const summary = particleModuleSummary(
                module.id,
                emitter,
                materialIdentity.displayLabel ?? null,
              );
              return (
                <ModuleCard
                  key={module.id}
                  id={module.id}
                  title={module.title}
                  open={cards.isOpen(module.id)}
                  onOpenChange={(open) => cards.setOpen(module.id, open)}
                  enabled={module.enabled}
                  onEnabledChange={
                    module.setEnabled
                      ? (enabled) => {
                          module.setEnabled!(enabled);
                          if (enabled) cards.setOpen(module.id, true);
                        }
                      : undefined
                  }
                  summary={summary.text}
                  summaryTone={summary.tone}
                >
                  {module.body}
                </ModuleCard>
              );
            })}
          </ModuleStage>
        ))}
      </ModuleStack>
      <ParticleMaterialPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(materialGuid) => set("render.materialGuid", materialGuid)}
        testId="particle-emitter-material-picker"
      />
    </>
  );
}
