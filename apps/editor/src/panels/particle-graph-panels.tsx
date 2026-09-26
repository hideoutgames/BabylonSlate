import { useCallback, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  EntryListEditor,
  ModuleStack,
  ModuleStage,
  PanelFrame,
  PropertyGrid,
  SelectableText,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { GraphEditor, type GraphDiagnostic } from "@babylonslate/graph-ui";
import { particleLibraryEmitterKey, type ParticleLibrary } from "@babylonslate/assets";
import {
  PARTICLE_BILLBOARD_MODE_IDS,
  PARTICLE_BLEND_MODE_IDS,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CPU_CAPACITY_BUDGET,
  PARTICLE_CURVE_MAX_KEYS,
  PARTICLE_CURVE_MIN_KEYS,
} from "@babylonslate/core";
import {
  PARTICLE_CONDITION_TESTS,
  PARTICLE_GRAPH_LIMITS,
  PARTICLE_OUTPUT_NODE_TYPE,
  PARTICLE_RANDOM_LOCKS,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  PARTICLE_VALUE_TYPE_OPTIONS,
  clampParticlePinValue,
  createDefaultParticleGraphSettings,
  hydrateParticleGraphForEditor,
  listUnconnectedParticlePinDefaults,
  normalizeParticleGraphSettings,
  particleConnectionIsAllowed,
  particleGradientStops,
  particleGraphToSerialized,
  particleNodeDefinitionFor,
  particleNodeValueType,
  particlePaletteNodes,
  particlePinDefaultPropertyKey,
  particlePinsAreCompatible,
  resizeParticleValue,
  serializedToParticleGraph,
  setParticleNodeValueType,
  type ParticleGradientStop,
  type ParticleGraphDiagnostic,
  type ParticleGraphDocument,
  type ParticleGraphNode,
  type ParticleNumericType,
} from "@babylonslate/particle-graph";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { PARTICLE_STAGE_ROLE } from "@babylonslate/ui/lib/data-types";
import { useDocuments } from "../context/document-context";
import {
  useParticleGraphEditing,
  type ParticleGraphBuildDiagnostic,
} from "../context/particle-graph-editing-context";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import {
  PARTICLE_BILLBOARD_LABELS,
  PARTICLE_BLEND_MODE_LABELS,
} from "../lib/particle-value-modes";
import {
  PREVIEW_EMITTER_GUID,
  PREVIEW_SYSTEM_GUID,
  emitterPreviewLibrary,
} from "../lib/play-particles";
import { MessageDetails } from "../components/message-details";
import { ParticlePreviewCanvas } from "../components/particle-preview-canvas";
import { ParticlePreviewSurface } from "../components/particle-preview-surface";
import { ParticleMaterialPicker } from "./particle-emitter-panels";

type Commit = (next: ParticleGraphDocument, mergeKey?: string) => void;

/** One undo entry per gesture on a Details field of one node. */
function particleGraphFieldMergeKey(nodeId: string, field: string): string {
  return `particle-graph-field:${nodeId}:${field}`;
}

function withNode(
  document: ParticleGraphDocument,
  node: ParticleGraphNode,
): ParticleGraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((entry) => (entry.id === node.id ? node : entry)),
  };
}

/** Rows for a node's unconnected inputs, written back as `default:<pinId>`. */
function pinDefaultRows(
  document: ParticleGraphDocument,
  node: ParticleGraphNode,
  setProperties: (patch: Record<string, unknown>, mergeKey?: string) => void,
): PropertyRow[] {
  const definition = particleNodeDefinitionFor(node);
  return listUnconnectedParticlePinDefaults(document, node.id).map((entry): PropertyRow => {
    const pin = definition?.inputs.find((input) => input.id === entry.pinId);
    const fallback = pin?.defaultValue
      ? resizeParticleValue(pin.defaultValue, entry.type)
      : undefined;
    const write = (value: number[]) =>
      setProperties(
        { [particlePinDefaultPropertyKey(entry.pinId)]: clampParticlePinValue(value, entry) },
        particleGraphFieldMergeKey(node.id, entry.pinId),
      );
    const [x = 0, y = 0, z = 0, w = 1] = entry.value;
    const base = {
      id: entry.pinId,
      label: entry.name,
      unit: entry.unit,
      description: entry.description,
    };
    switch (entry.type) {
      case "float":
        return {
          ...base,
          kind: "number",
          value: x,
          defaultValue: fallback?.[0],
          min: entry.min,
          max: entry.max,
          onChange: (value) => write([value]),
        };
      case "vec2":
        return {
          ...base,
          kind: "vector3",
          axes: ["X", "Y"],
          value: [x, y, 0],
          defaultValue: fallback ? [fallback[0]!, fallback[1]!, 0] : undefined,
          onChange: (value) => write([value[0], value[1]]),
        };
      case "vec3":
        return {
          ...base,
          kind: "vector3",
          value: [x, y, z],
          defaultValue: fallback ? [fallback[0]!, fallback[1]!, fallback[2]!] : undefined,
          onChange: (value) => write([value[0], value[1], value[2]]),
        };
      case "color":
        return {
          ...base,
          kind: "color4",
          value: [x, y, z, w],
          defaultValue: fallback
            ? [fallback[0]!, fallback[1]!, fallback[2]!, fallback[3]!]
            : undefined,
          onChange: (value) => write([...value]),
        };
    }
  });
}

function numbersOf(value: unknown, type: ParticleNumericType): number[] {
  return resizeParticleValue(Array.isArray(value) ? value : undefined, type);
}

/** Value, Random, Condition, Shape and Align Angle properties that are not pins. */
function nodePropertyRows(
  node: ParticleGraphNode,
  setProperties: (patch: Record<string, unknown>, mergeKey?: string) => void,
  replaceNode: (node: ParticleGraphNode) => void,
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  const field = (name: string) => particleGraphFieldMergeKey(node.id, name);
  const valueType = particleNodeValueType(node.type, node.properties);
  if (valueType) {
    rows.push({
      id: "valueType",
      kind: "enum",
      label: "Value Type",
      value: valueType,
      options: PARTICLE_VALUE_TYPE_OPTIONS.map((option) => ({
        value: option.id,
        label: option.label,
      })),
      onChange: (next) =>
        replaceNode(setParticleNodeValueType(node, next as ParticleNumericType)),
    });
  }
  switch (node.type) {
    case "random.range": {
      const lock = node.properties.lock === "everyRead" ? "everyRead" : "perParticle";
      rows.push({
        id: "lock",
        kind: "enum",
        label: "Lock Mode",
        value: lock,
        description:
          lock === "everyRead"
            ? "Rolls a new value every time the value is read."
            : "One roll per particle: fixed in Create Particle inputs, re-rolled every frame in Update inputs.",
        options: PARTICLE_RANDOM_LOCKS.map((option) => ({
          value: option.id,
          label: option.label,
        })),
        onChange: (next) => setProperties({ lock: next }),
      });
      break;
    }
    case "logic.condition":
      rows.push(
        {
          id: "test",
          kind: "enum",
          label: "Test",
          value: String(node.properties.test ?? "lessThan"),
          options: PARTICLE_CONDITION_TESTS.map((option) => ({
            value: option.id,
            label: option.label,
          })),
          onChange: (test) => setProperties({ test }),
        },
        {
          id: "epsilon",
          kind: "number",
          label: "Epsilon",
          value: Number(node.properties.epsilon ?? 0),
          min: 0,
          onChange: (epsilon) => setProperties({ epsilon }, field("epsilon")),
        },
      );
      break;
    case "shape.sphere":
      rows.push({
        id: "hemisphere",
        kind: "boolean",
        label: "Hemispheric",
        value: node.properties.hemisphere === true,
        onChange: (hemisphere) => setProperties({ hemisphere }),
      });
      break;
    case "shape.cone":
      rows.push({
        id: "emitFromSpawnPointOnly",
        kind: "boolean",
        label: "Emit From Spawn Point Only",
        value: node.properties.emitFromSpawnPointOnly === true,
        onChange: (emitFromSpawnPointOnly) => setProperties({ emitFromSpawnPointOnly }),
      });
      break;
    case "update.alignAngle":
      rows.push({
        id: "alignment",
        kind: "number",
        label: "Alignment",
        unit: "rad",
        value: Number(node.properties.alignment ?? Math.PI / 2),
        onChange: (alignment) => setProperties({ alignment }, field("alignment")),
      });
      break;
    case "const.float":
      rows.push({
        id: "value",
        kind: "number",
        label: "Value",
        value: numbersOf(node.properties.value, "float")[0]!,
        onChange: (value) => setProperties({ value: [value] }, field("value")),
      });
      break;
    case "const.vec2": {
      const [x, y] = numbersOf(node.properties.value, "vec2");
      rows.push({
        id: "value",
        kind: "vector3",
        label: "Value",
        axes: ["X", "Y"],
        value: [x!, y!, 0],
        onChange: (value) => setProperties({ value: [value[0], value[1]] }, field("value")),
      });
      break;
    }
    case "const.vec3": {
      const [x, y, z] = numbersOf(node.properties.value, "vec3");
      rows.push({
        id: "value",
        kind: "vector3",
        label: "Value",
        value: [x!, y!, z!],
        onChange: (value) =>
          setProperties({ value: [value[0], value[1], value[2]] }, field("value")),
      });
      break;
    }
    case "const.color": {
      const [r, g, b, a] = numbersOf(node.properties.value, "color");
      rows.push({
        id: "value",
        kind: "color4",
        label: "Value",
        value: [r!, g!, b!, a!],
        onChange: (value) => setProperties({ value: [...value] }, field("value")),
      });
      break;
    }
  }
  return rows;
}

/** Kit curve and gradient editors keep their end keys at 0 and 1. */
function stopTime(stops: readonly ParticleGradientStop[], index: number): number {
  if (index === 0) return 0;
  if (index === stops.length - 1) return 1;
  return stops[index]!.position;
}

/** Gradient node stops: Color → GradientField, Float → CurveField, vectors → a stop list. */
function GradientStopsEditor({
  node,
  setProperties,
}: {
  node: ParticleGraphNode;
  setProperties: (patch: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const valueType = particleNodeValueType(node.type, node.properties) ?? "color";
  const stops = particleGradientStops(node.properties.stops, valueType);
  const commitStops = (next: ParticleGradientStop[], mergeKey?: string) =>
    setProperties({ stops: next }, mergeKey);
  const continuous = particleGraphFieldMergeKey(node.id, "stops");
  if (valueType === "color") {
    return (
      <PropertyGrid
        rows={[
          {
            id: "stops",
            kind: "gradient",
            label: "Stops",
            value: stops.map((stop, index) => {
              const [r = 1, g = 1, b = 1, a = 1] = stop.value;
              return { t: stopTime(stops, index), color: [r, g, b, a] };
            }),
            minStops: PARTICLE_CURVE_MIN_KEYS,
            maxStops: PARTICLE_CURVE_MAX_KEYS,
            defaultExpanded: true,
            onChange: (next) =>
              commitStops(
                next.map((stop) => ({ position: stop.t, value: [...stop.color] })),
                continuous,
              ),
          },
        ]}
      />
    );
  }
  if (valueType === "float") {
    return (
      <PropertyGrid
        rows={[
          {
            id: "stops",
            kind: "curve",
            label: "Stops",
            value: stops.map((stop, index) => ({
              t: stopTime(stops, index),
              value: stop.value[0] ?? 0,
            })),
            axisLabels: { start: "0", end: "1" },
            minKeys: PARTICLE_CURVE_MIN_KEYS,
            maxKeys: PARTICLE_CURVE_MAX_KEYS,
            defaultExpanded: true,
            onChange: (next) =>
              commitStops(
                next.map((key) => ({ position: key.t, value: [key.value] })),
                continuous,
              ),
          },
        ]}
      />
    );
  }
  const axes = valueType === "vec2" ? ["X", "Y"] : ["X", "Y", "Z"];
  return (
    <div className="p-2">
      <EntryListEditor<ParticleGradientStop>
        title="Stops"
        items={stops}
        minItems={PARTICLE_CURVE_MIN_KEYS}
        maxItems={PARTICLE_CURVE_MAX_KEYS}
        addLabel="Add Stop"
        countNoun={{ one: "stop", other: "stops" }}
        onCreate={() => ({ position: 0.5, value: resizeParticleValue([0], valueType) })}
        onChange={(next) => commitStops(next)}
        renderItemHeader={({ index }) => (
          <span className="px-1 text-xs font-medium text-muted-foreground">
            {`Stop ${index + 1}`}
          </span>
        )}
        renderItem={({ item, index }) => {
          const replace = (stop: ParticleGradientStop, name: string) =>
            commitStops(
              stops.map((entry, at) => (at === index ? stop : entry)),
              particleGraphFieldMergeKey(node.id, `stops.${index}.${name}`),
            );
          const [x = 0, y = 0, z = 0] = item.value;
          return (
            <PropertyGrid
              density="compact"
              rows={[
                {
                  id: `stop-${index}-position`,
                  kind: "number",
                  label: "Position",
                  value: item.position,
                  min: 0,
                  max: 1,
                  onChange: (position) => replace({ ...item, position }, "position"),
                },
                {
                  id: `stop-${index}-value`,
                  kind: "vector3",
                  label: "Value",
                  axes,
                  value: [x, y, z],
                  onChange: (value) =>
                    replace(
                      { ...item, value: resizeParticleValue(value, valueType) },
                      "value",
                    ),
                },
              ]}
            />
          );
        }}
        data-testid="particle-graph-gradient-stops"
      />
    </div>
  );
}

/** Header, pin defaults and properties of one selected node. */
function ParticleNodeDetails({
  document,
  node,
  onChange,
}: {
  document: ParticleGraphDocument;
  node: ParticleGraphNode;
  onChange: Commit;
}) {
  const definition = particleNodeDefinitionFor(node);
  const setProperties = (patch: Record<string, unknown>, mergeKey?: string) =>
    onChange(
      withNode(document, { ...node, properties: { ...node.properties, ...patch } }),
      mergeKey,
    );
  const replaceNode = (next: ParticleGraphNode) => onChange(withNode(document, next));
  if (!definition) {
    return (
      <ModuleStack data-testid="particle-graph-node-details">
        <ModuleStage
          id="node"
          title={PARTICLE_UNSUPPORTED_V1_TYPES[node.type] ?? node.type}
          accentRole={PARTICLE_STAGE_ROLE.value}
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">
            This node is not available in Particle Graphs. Remove it to build the graph.
          </p>
        </ModuleStage>
      </ModuleStack>
    );
  }
  const rows = [
    ...nodePropertyRows(node, setProperties, replaceNode),
    ...pinDefaultRows(document, node, setProperties),
  ];
  return (
    <ModuleStack data-testid="particle-graph-node-details">
      <ModuleStage
        id="node"
        title={definition.title}
        accentRole={PARTICLE_STAGE_ROLE[definition.role]}
      >
        {definition.description ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{definition.description}</p>
        ) : null}
        {rows.length > 0 ? <PropertyGrid rows={rows} /> : null}
        {node.type === "gradient.sample" ? (
          <GradientStopsEditor node={node} setProperties={setProperties} />
        ) : null}
      </ModuleStage>
    </ModuleStack>
  );
}

/** Material and emitter settings; the Emitter Output shows the same rows. */
function ParticleGraphSettingsDetails({
  document,
  onChange,
}: {
  document: ParticleGraphDocument;
  onChange: Commit;
}) {
  const { assetRegistry } = useDocuments();
  const [picking, setPicking] = useState(false);
  const { settings, materialGuid } = document;
  const output = document.nodes.find((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE);
  const anchor = output?.id ?? PARTICLE_OUTPUT_NODE_TYPE;
  const material = materialGuid
    ? (assetRegistry?.list() ?? []).find((asset) => asset.header.guid === materialGuid)
    : undefined;
  const defaults = createDefaultParticleGraphSettings();

  /** `field` names the undo merge key of a continuous edit; discrete edits omit it. */
  const edit = (patch: Record<string, unknown>, field?: string) =>
    onChange(
      { ...document, settings: normalizeParticleGraphSettings({ ...settings, ...patch }) },
      field ? particleGraphFieldMergeKey(anchor, field) : undefined,
    );
  const setOutputProperties = (patch: Record<string, unknown>, mergeKey?: string) => {
    if (!output) return;
    onChange(
      withNode(document, { ...output, properties: { ...output.properties, ...patch } }),
      mergeKey,
    );
  };

  const rows: PropertyRow[] = [
    {
      id: "material",
      kind: "asset",
      label: "Material",
      value: materialGuid,
      placeholder: "No Material",
      description: materialGuid ? undefined : "Pick a Material with the Particle domain.",
      onPick: () => setPicking(true),
      onChange: (guid) => onChange({ ...document, materialGuid: guid }),
      ...assetRowIdentity(
        material ? { name: material.header.name, type: material.header.type } : undefined,
      ),
    },
    {
      id: "capacity",
      kind: "number",
      label: "Capacity",
      description: `Particle Graphs simulate on the CPU; above ${PARTICLE_CPU_CAPACITY_BUDGET} particles costs more on iPad.`,
      value: settings.capacity,
      defaultValue: PARTICLE_CAPACITY_DEFAULT,
      min: PARTICLE_GRAPH_LIMITS.capacity.min,
      max: PARTICLE_GRAPH_LIMITS.capacity.max,
      onChange: (capacity) => edit({ capacity }, "capacity"),
    },
    {
      id: "loop",
      kind: "enum",
      label: "Loop",
      value: settings.loop,
      defaultValue: defaults.loop,
      options: [
        { value: "infinite", label: "Infinite" },
        { value: "once", label: "Once" },
      ],
      onChange: (loop) => edit({ loop }),
    },
    {
      id: "duration",
      kind: "number",
      label: "Duration",
      unit: "s",
      description:
        settings.loop === "once"
          ? "How long the emitter spawns before it stops."
          : "Length of one loop.",
      value: settings.duration,
      defaultValue: defaults.duration,
      min: PARTICLE_GRAPH_LIMITS.duration.min,
      max: PARTICLE_GRAPH_LIMITS.duration.max,
      onChange: (duration) => edit({ duration }, "duration"),
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
      defaultValue: defaults.prewarm,
      min: PARTICLE_GRAPH_LIMITS.prewarm.min,
      max: PARTICLE_GRAPH_LIMITS.prewarm.max,
      onChange: (prewarm) => edit({ prewarm }, "prewarm"),
    },
    {
      id: "blendMode",
      kind: "enum",
      label: "Blend Mode",
      value: settings.blendMode,
      defaultValue: defaults.blendMode,
      options: PARTICLE_BLEND_MODE_IDS.map((mode) => ({
        value: mode,
        label: PARTICLE_BLEND_MODE_LABELS[mode],
      })),
      onChange: (blendMode) => edit({ blendMode }),
    },
    {
      id: "billboard",
      kind: "enum",
      label: "Billboard",
      value: settings.billboard,
      defaultValue: defaults.billboard,
      options: PARTICLE_BILLBOARD_MODE_IDS.map((mode) => ({
        value: mode,
        label: PARTICLE_BILLBOARD_LABELS[mode],
      })),
      onChange: (billboard) => edit({ billboard }),
    },
    // Emit Rate while its pin is unconnected.
    ...(output ? pinDefaultRows(document, output, setOutputProperties) : []),
  ];

  return (
    <>
      <ModuleStack data-testid="particle-graph-settings">
        <ModuleStage
          id="emitter-output"
          title="Emitter Output"
          accentRole={PARTICLE_STAGE_ROLE.output}
        >
          <PropertyGrid rows={rows} />
        </ModuleStage>
      </ModuleStack>
      <ParticleMaterialPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(guid) => onChange({ ...document, materialGuid: guid })}
        testId="particle-graph-material-picker"
      />
    </>
  );
}

/**
 * Particle Graph Details: the emitter settings with nothing (or the Emitter
 * Output) selected, otherwise the selected node's header, pin defaults and
 * properties.
 */
export function ParticleGraphDetails({
  document,
  selectedNodeId,
  onChange,
}: {
  document: ParticleGraphDocument;
  selectedNodeId: string | null;
  /** `mergeKey` groups one gesture's edits into one undo entry. */
  onChange: Commit;
}) {
  const node = selectedNodeId
    ? document.nodes.find((entry) => entry.id === selectedNodeId)
    : undefined;
  if (node && node.type !== PARTICLE_OUTPUT_NODE_TYPE) {
    // Keyed so field drafts and list focus never carry over to another node.
    return (
      <ParticleNodeDetails key={node.id} document={document} node={node} onChange={onChange} />
    );
  }
  return <ParticleGraphSettingsDetails document={document} onChange={onChange} />;
}

/**
 * The last valid build keeps playing while the graph has errors; with no
 * earlier build the Preview explains why it is empty.
 */
export function ParticleGraphPreview({
  document,
  previewDocument,
  errorCount,
  onChange,
  onBuildDiagnostics,
}: {
  document: ParticleGraphDocument;
  previewDocument: ParticleGraphDocument | null;
  errorCount: number;
  onChange: Commit;
  /** The running build's service diagnostics and the library that build ran. */
  onBuildDiagnostics?: (
    diagnostics: readonly ParticleGraphBuildDiagnostic[],
    applied: ParticleLibrary,
  ) => void;
}) {
  const [picking, setPicking] = useState(false);
  const library = useMemo(
    () =>
      previewDocument
        ? emitterPreviewLibrary({ kind: "graph", document: previewDocument })
        : null,
    [previewDocument],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="particle-graph-preview">
      <div className="min-h-0 flex-1">
        {library ? (
          <ParticlePreviewCanvas
            library={library}
            systemGuid={PREVIEW_SYSTEM_GUID}
            testId="particle-graph-preview-canvas"
            onPickMaterial={() => setPicking(true)}
            onDiagnostics={onBuildDiagnostics}
          />
        ) : (
          <ParticlePreviewSurface
            state={{
              status: "empty",
              title: "Graph Has Errors",
              description: "Fix the errors in Compiler Results to preview.",
              testId: "particle-preview-graph-errors",
            }}
            paused={false}
            onPausedChange={() => undefined}
            onRestart={() => undefined}
            stats={null}
          />
        )}
      </div>
      {library && errorCount > 0 ? (
        <p
          role="status"
          className="shrink-0 px-2 py-1 text-xs text-destructive"
          data-testid="particle-graph-preview-stale"
        >
          {`Graph has ${errorCount} ${errorCount === 1 ? "error" : "errors"}. Preview shows the last valid build.`}
        </p>
      ) : null}
      <ParticleMaterialPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(materialGuid) => onChange({ ...document, materialGuid })}
        testId="particle-preview-material-picker"
      />
    </div>
  );
}

function diagnosticDetails(
  row: ParticleGraphDiagnostic,
  document: ParticleGraphDocument,
): string {
  const node = row.nodeId
    ? document.nodes.find((entry) => entry.id === row.nodeId)
    : undefined;
  const definition = node ? particleNodeDefinitionFor(node) : undefined;
  const pin = row.pinId
    ? [...(definition?.inputs ?? []), ...(definition?.outputs ?? [])].find(
        (entry) => entry.id === row.pinId,
      )
    : undefined;
  const lines = [`${row.severity}: ${row.code}`, row.message];
  if (node) lines.push(`Node: ${definition?.title ?? node.type} (${node.id})`);
  if (row.pinId) lines.push(`Pin: ${pin?.name ?? row.pinId}`);
  return lines.join("\n");
}

function sameDiagnostic(a: ParticleGraphDiagnostic, b: ParticleGraphDiagnostic): boolean {
  return (
    a.code === b.code &&
    a.message === b.message &&
    a.nodeId === b.nodeId &&
    a.pinId === b.pinId
  );
}

/** Validation and build diagnostics; tapping a row focuses its node. */
export function ParticleGraphCompilerResults({
  document,
  rows,
  onFocusNode,
}: {
  document: ParticleGraphDocument;
  rows: readonly ParticleGraphDiagnostic[];
  onFocusNode: (nodeId: string) => void;
}) {
  const [selectedRow, setSelectedRow] = useState<ParticleGraphDiagnostic | null>(null);
  const selected =
    selectedRow && rows.some((row) => sameDiagnostic(row, selectedRow)) ? selectedRow : null;
  return (
    <>
      {rows.length === 0 ? (
        <Empty>
          <EmptyTitle>No Issues</EmptyTitle>
          <EmptyDescription>This Particle Graph builds cleanly.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 p-2">
          <WindowedList itemCount={rows.length} rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}>
            {(index) => {
              const row = rows[index]!;
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="h-full w-full min-h-0 justify-start gap-2 overflow-hidden text-left"
                  onClick={() => {
                    setSelectedRow(row);
                    if (row.nodeId) onFocusNode(row.nodeId);
                  }}
                  data-testid={`particle-graph-diagnostic-${row.code}`}
                  data-severity={row.severity}
                >
                  <Badge variant={row.severity === "error" ? "destructive" : "secondary"}>
                    {row.severity}
                  </Badge>
                  <SelectableText className="truncate">{row.message}</SelectableText>
                </Button>
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
      {selected ? (
        <MessageDetails
          title="Diagnostic Details"
          message={diagnosticDetails(selected, document)}
          onClose={() => setSelectedRow(null)}
        />
      ) : null}
    </>
  );
}

function ParticleGraphCanvas() {
  const editing = useParticleGraphEditing();
  const { document, commit, documentId, setSelectedNodeId } = editing;
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(documentId);
  const initialGraph = useMemo(
    () => hydrateParticleGraphForEditor(particleGraphToSerialized(document)),
    [document],
  );
  // Connection vetoes read the graph as it is when the wire is dropped.
  const graphRef = useRef(initialGraph);
  graphRef.current = initialGraph;
  const canConnect = useCallback(
    (connection: { source: string; target: string; sourceHandle: string; targetHandle: string }) =>
      particleConnectionIsAllowed(graphRef.current, connection),
    [],
  );
  const paletteNodes = useMemo(() => particlePaletteNodes(), []);
  // Pin ids stay on the rows so the canvas rings the offending pin.
  const diagnostics = useMemo<GraphDiagnostic[]>(
    () =>
      [...editing.diagnostics, ...editing.buildDiagnostics].map((row) => ({
        nodeId: row.nodeId,
        pinId: row.pinId,
        severity: row.severity,
        message: row.message,
      })),
    [editing.buildDiagnostics, editing.diagnostics],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="particle-graph-editor">
      <GraphEditor
        initialGraph={initialGraph}
        diagnostics={diagnostics}
        paletteNodes={paletteNodes}
        pinCompatibility={particlePinsAreCompatible}
        canConnect={canConnect}
        sessionViewport={sessionViewport}
        onSessionViewportChange={onSessionViewportChange}
        onSelectionChange={(ids) => setSelectedNodeId(ids[0] ?? null)}
        focusedNodeId={editing.focusedNodeId ?? undefined}
        commitPositionsOnDragEnd
        onChange={(next, meta) =>
          commit(
            serializedToParticleGraph(next, document),
            meta?.kind === "position" && meta.transactionId
              ? `particle-graph-node-move:${meta.transactionId}`
              : undefined,
          )
        }
      />
    </div>
  );
}

export function ParticleGraphCanvasPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame className="flex-1" data-testid="particle-graph-canvas-panel">
      <ParticleGraphCanvas />
    </PanelFrame>
  );
}

export function ParticleGraphPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const editing = useParticleGraphEditing();
  const { reportBuildDiagnostics } = editing;
  // Tag each report with the build that produced it, so a late report from the
  // previous build never lands on a pending edit.
  const onBuildDiagnostics = useCallback(
    (diagnostics: readonly ParticleGraphBuildDiagnostic[], applied: ParticleLibrary) => {
      const entry = applied.emitters.get(PREVIEW_EMITTER_GUID);
      if (entry) reportBuildDiagnostics(particleLibraryEmitterKey(entry), diagnostics);
    },
    [reportBuildDiagnostics],
  );
  return (
    <PanelFrame className="flex-1" data-testid="particle-graph-preview-panel">
      <ParticleGraphPreview
        document={editing.document}
        previewDocument={editing.previewDocument}
        errorCount={editing.errorCount}
        onChange={editing.commit}
        onBuildDiagnostics={onBuildDiagnostics}
      />
    </PanelFrame>
  );
}

export function ParticleGraphDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const editing = useParticleGraphEditing();
  return (
    <PanelFrame className="flex-1" data-testid="particle-graph-details-panel">
      <ParticleGraphDetails
        document={editing.document}
        selectedNodeId={editing.selectedNodeId}
        onChange={editing.commit}
      />
    </PanelFrame>
  );
}

export function ParticleGraphCompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  const editing = useParticleGraphEditing();
  const rows = useMemo(
    () => [...editing.diagnostics, ...editing.buildDiagnostics],
    [editing.buildDiagnostics, editing.diagnostics],
  );
  return (
    <PanelFrame className="flex-1" data-testid="particle-graph-compiler-results">
      <ParticleGraphCompilerResults
        document={editing.document}
        rows={rows}
        onFocusNode={editing.focusNode}
      />
    </PanelFrame>
  );
}
