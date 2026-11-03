import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  EntryListEditor,
  ModuleStack,
  ModuleStage,
  PanelFrame,
  PropertyGrid,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  assetRowIdentity,
  type NestedMenuItem,
  type PropertyRow,
} from "@haptic/editor-kit";
import { GraphEditor, type GraphDiagnostic } from "@haptic/graph-ui";
import { particleLibraryEmitterKey, type ParticleLibrary } from "@haptic/assets";
import {
  PARTICLE_BILLBOARD_MODE_IDS,
  PARTICLE_BLEND_MODE_IDS,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CURVE_MAX_KEYS,
  PARTICLE_CURVE_MIN_KEYS,
} from "@haptic/core";
import {
  PARTICLE_ANGLE_UNIT_OPTIONS,
  PARTICLE_PARAMETER_NAME_MAX,
  PARTICLE_PARAMETER_NODE_TYPE,
  PARTICLE_CONDITION_TESTS,
  PARTICLE_LOCAL_VARIABLE_SCOPES,
  PARTICLE_MESH_SHAPE_SOURCES,
  PARTICLE_GRAPH_LIMITS,
  PARTICLE_OUTPUT_NODE_TYPE,
  PARTICLE_RANDOM_LOCKS,
  PARTICLE_SPAWN_LIMITS,
  PARTICLE_SPAWN_PRESETS,
  PARTICLE_SPRITE_SHEET_LIMITS,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  PARTICLE_VALUE_TYPE_OPTIONS,
  clampParticlePinValue,
  convertParticleConstantToParameter,
  convertParticleParameterToConstant,
  createDefaultParticleGraphSettings,
  hydrateParticleGraphForEditor,
  listUnconnectedParticlePinDefaults,
  normalizeParticleGraphSettings,
  normalizeParticleParameterName,
  particleConnectionIsAllowed,
  particleConstantValueType,
  particleGradientStops,
  particleGraphToSerialized,
  particleNodeAngleUnit,
  particleNodeDefinitionFor,
  particleNodeValueType,
  particlePaletteNodes,
  particleParameterSnapshots,
  particlePinDefaultPropertyKey,
  particlePinsAreCompatible,
  particleSpawnSettings,
  particleSpriteSheetSettings,
  reconcileParticleParameters,
  resizeParticleValue,
  serializedToParticleGraph,
  setParticleNodeAngleUnit,
  setParticleNodeValueType,
  withParticleParameter,
  withParticleSpawnPreset,
  type ParticleAngleUnit,
  type ParticleGradientStop,
  type ParticleGraphDiagnostic,
  type ParticleGraphDocument,
  type ParticleGraphNode,
  type ParticleNumericType,
} from "@haptic/particle-graph";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import { Button } from "@haptic/ui/components/button";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { PARTICLE_STAGE_ROLE } from "@haptic/ui/lib/data-types";
import { useRegistryState } from "../context/document-context";
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
import { DiagnosticResultRow } from "../components/diagnostic-result-row";
import { ParticlePreviewCanvas } from "../components/particle-preview-canvas";
import { useSpawnPreviewEmitters } from "../lib/use-spawn-preview-emitters";
import { ParticlePreviewSurface } from "../components/particle-preview-surface";
import { ParticleMaterialPicker } from "../components/particle-material-picker";
import { newParticleParameterId, particleParameterValueRow } from "../lib/particle-parameter-rows";

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
      // The unit follows the value, never the label: "Angle (Degrees)" reads "Angle … °".
      label: entry.name.replace(/ \((Radians|Degrees)\)$/, ""),
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
  // A Parameter node takes its parameter's type; Details picks the parameter instead.
  if (valueType && node.type !== "input.parameter") {
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
  const angleUnit = particleNodeAngleUnit(node.type, node.properties);
  if (angleUnit) {
    rows.push({
      id: "angleUnit",
      kind: "enum",
      label: "Angle Unit",
      value: angleUnit,
      description: "The unit of the Angle input. Switching converts its value.",
      options: PARTICLE_ANGLE_UNIT_OPTIONS.map((option) => ({
        value: option.id,
        label: option.label,
      })),
      onChange: (next) => replaceNode(setParticleNodeAngleUnit(node, next as ParticleAngleUnit)),
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
    case "trigger.spawn": {
      const spawn = particleSpawnSettings(node.properties);
      rows.push(
        {
          id: "limit",
          kind: "number",
          label: "Limit",
          value: spawn.limit,
          min: PARTICLE_SPAWN_LIMITS.limit.min,
          max: PARTICLE_SPAWN_LIMITS.limit.max,
          precision: 0,
          description: "Spawned emitters of this node playing at once; spawns beyond it are skipped.",
          onChange: (limit) => setProperties({ limit }, field("limit")),
        },
        {
          id: "minInterval",
          kind: "number",
          label: "Min Interval",
          unit: "s",
          value: spawn.minInterval,
          min: PARTICLE_SPAWN_LIMITS.minInterval.min,
          max: PARTICLE_SPAWN_LIMITS.minInterval.max,
          description: "Simulated seconds between two spawns of this node.",
          onChange: (minInterval) => setProperties({ minInterval }, field("minInterval")),
        },
        {
          id: "inheritVelocity",
          kind: "boolean",
          label: "Inherit Velocity",
          value: spawn.inheritVelocity,
          description: "A spawned emitter keeps moving at the particle's velocity when it fired.",
          onChange: (inheritVelocity) => setProperties({ inheritVelocity }),
        },
      );
      break;
    }
    case "sprite.setup": {
      const sheet = particleSpriteSheetSettings(node.properties);
      const last = sheet.columns * sheet.rows - 1;
      // Each edit stores the normalized sheet, so the cells stay within a resized grid.
      const setSheet = (patch: Record<string, unknown>, name: string) =>
        setProperties({ ...particleSpriteSheetSettings({ ...sheet, ...patch }) }, field(name));
      rows.push(
        {
          id: "columns",
          kind: "number",
          label: "Columns",
          value: sheet.columns,
          min: PARTICLE_SPRITE_SHEET_LIMITS.columns.min,
          max: PARTICLE_SPRITE_SHEET_LIMITS.columns.max,
          precision: 0,
          onChange: (columns) => setSheet({ columns }, "columns"),
        },
        {
          id: "rows",
          kind: "number",
          label: "Rows",
          value: sheet.rows,
          min: PARTICLE_SPRITE_SHEET_LIMITS.rows.min,
          max: PARTICLE_SPRITE_SHEET_LIMITS.rows.max,
          precision: 0,
          onChange: (rows) => setSheet({ rows }, "rows"),
        },
        {
          id: "startCell",
          kind: "number",
          label: "Start Cell",
          value: sheet.startCell,
          min: 0,
          max: last,
          precision: 0,
          description: "Cells are numbered from 0 at the top left, left to right, then row by row downwards.",
          onChange: (startCell) => setSheet({ startCell }, "startCell"),
        },
        {
          id: "endCell",
          kind: "number",
          label: "End Cell",
          value: sheet.endCell,
          min: sheet.startCell,
          max: last,
          precision: 0,
          onChange: (endCell) => setSheet({ endCell }, "endCell"),
        },
        {
          id: "framesPerSecond",
          kind: "number",
          label: "Frames Per Second",
          value: sheet.framesPerSecond,
          min: PARTICLE_SPRITE_SHEET_LIMITS.framesPerSecond.min,
          max: PARTICLE_SPRITE_SHEET_LIMITS.framesPerSecond.max,
          description: "How fast Animate Sprite Sheet steps through the cells, over each particle's age. 0 holds the first cell.",
          onChange: (framesPerSecond) => setSheet({ framesPerSecond }, "framesPerSecond"),
        },
        {
          id: "loop",
          kind: "boolean",
          label: "Loop",
          value: sheet.loop,
          description: "After End Cell, Animate Sprite Sheet starts again at Start Cell. Off, it stays on End Cell.",
          onChange: (loop) => setSheet({ loop }, "loop"),
        },
        {
          id: "randomStartCell",
          kind: "boolean",
          label: "Random Start Cell",
          value: sheet.randomStartCell,
          description: "Each particle is born on a random cell from Start Cell to End Cell.",
          onChange: (randomStartCell) => setSheet({ randomStartCell }, "randomStartCell"),
        },
      );
      break;
    }
    case "shape.mesh":
      rows.push(
        {
          id: "source",
          kind: "enum",
          label: "Source",
          value: node.properties.source === "model" ? "model" : "ownerMesh",
          description: node.properties.source === "model"
            ? undefined
            : "The actor's first mesh, in its rest pose. Previews show a sphere.",
          options: PARTICLE_MESH_SHAPE_SOURCES.map((option) => ({ value: option.id, label: option.label })),
          onChange: (source) => setProperties({ source }),
        },
        {
          id: "useMeshNormals",
          kind: "boolean",
          label: "Use Mesh Normals",
          value: node.properties.useMeshNormals !== false,
          description: "Particles move along the surface normal instead of between Direction 1 and Direction 2.",
          onChange: (useMeshNormals) => setProperties({ useMeshNormals }),
        },
        {
          id: "useMeshColor",
          kind: "boolean",
          label: "Use Mesh Color",
          value: node.properties.useMeshColor === true,
          description: "Particles take the mesh's vertex colour, where it has one.",
          onChange: (useMeshColor) => setProperties({ useMeshColor }),
        },
      );
      break;
    case "utility.localVariable": {
      const scope = node.properties.scope === "loop" ? "loop" : "particle";
      rows.push({
        id: "scope",
        kind: "enum",
        label: "Scope",
        value: scope,
        description: scope === "loop"
          ? "One value per frame, shared by every particle."
          : "One value per particle, read the first time and kept for its whole life.",
        options: PARTICLE_LOCAL_VARIABLE_SCOPES.map((option) => ({ value: option.id, label: option.label })),
        onChange: (next) => setProperties({ scope: next }),
      });
      break;
    }
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

/**
 * A Parameter node's rows: its own parameter's **Name**, **Type** and **Default** (each
 * parameter has one node). A taken name gets a `_N` suffix; retyping resizes the default and
 * retypes the node. None while the parameter is missing.
 */
function particleParameterNodeRows(
  document: ParticleGraphDocument,
  node: ParticleGraphNode,
  onChange: Commit,
): PropertyRow[] {
  const parameter = (document.parameters ?? []).find((entry) => entry.id === node.properties.parameterId);
  if (!parameter) return [];
  const update = (next: typeof parameter, mergeKey?: string) =>
    onChange(withParticleParameter(document, next), mergeKey);
  return [
    {
      id: "parameterName",
      kind: "text",
      label: "Name",
      value: parameter.name,
      description: `Gameplay sets it by this name. Unique in the graph, up to ${PARTICLE_PARAMETER_NAME_MAX} characters; a taken name gets _1, _2 and so on.`,
      onChange: () => undefined,
      onCommit: (text) => {
        const name = normalizeParticleParameterName(text);
        if (name && name !== parameter.name) update({ ...parameter, name });
      },
    },
    {
      id: "parameterType",
      kind: "enum",
      label: "Type",
      value: parameter.type,
      options: PARTICLE_VALUE_TYPE_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
      onChange: (type) => update({ ...parameter, type: type as ParticleNumericType }),
    },
    particleParameterValueRow({
      id: "parameterDefault",
      label: "Default",
      type: parameter.type,
      value: parameter.defaultValue,
      onChange: (defaultValue) =>
        update({ ...parameter, defaultValue }, particleGraphFieldMergeKey(node.id, "parameterDefault")),
    }),
  ];
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
  const assets = useParticleNodeAssetPicker(node, setProperties);
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
  const parameterRows = node.type === PARTICLE_PARAMETER_NODE_TYPE
    ? particleParameterNodeRows(document, node, onChange)
    : [];
  const rows = [
    ...parameterRows,
    ...nodePropertyRows(node, setProperties, replaceNode),
    ...pinDefaultRows(document, node, setProperties),
  ];
  if (node.type === "trigger.spawn") {
    rows.unshift(assets.row({ property: "emitterGuid", label: "Emitter", assetTypes: ["ParticleEmitter", "ParticleGraph"], placeholder: "No Emitter",
      description: "The Particle Emitter or Particle Graph played at the particle. It runs one Duration, then its particles fade out." }));
  }
  if (node.type === "update.noise") {
    rows.unshift(assets.row({ property: "textureGuid", label: "Texture", assetTypes: ["Texture"], placeholder: "Built-In Noise",
      description: typeof node.properties.textureGuid === "string"
        ? "Its red channel sets the push; each particle reads it at its own random point."
        : "Without a Texture the built-in noise is used." }));
  }
  if (node.type === "shape.mesh" && node.properties.source === "model") {
    rows.splice(rows.findIndex((row) => row.id === "source") + 1, 0, assets.row({ property: "modelGuid", label: "Model",
      assetTypes: ["Model"], placeholder: "No Model",
      description: "Particles spawn on the Model's triangles, placed at the emitter." }));
  }
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
        {node.type === PARTICLE_PARAMETER_NODE_TYPE && parameterRows.length === 0 ? (
          <p className="px-2 py-1 text-xs text-destructive" data-testid="particle-parameter-missing">
            Its parameter is missing. Convert the node to a Constant or delete it.
          </p>
        ) : null}
        {rows.length > 0 ? <PropertyGrid rows={rows} /> : null}
        {assets.picker}
        {node.type === "trigger.spawn" ? (
          <div className="flex flex-wrap items-center gap-1 px-2 py-1" data-testid="particle-spawn-presets">
            <span className="text-xs text-muted-foreground">Condition</span>
            {PARTICLE_SPAWN_PRESETS.map((preset) => (
              <Button key={preset.id} type="button" variant="outline" size="xs" title={preset.description}
                data-testid={`particle-spawn-preset-${preset.id}`}
                onClick={() => onChange(withParticleSpawnPreset(document, node.id, preset.id))}>
                {preset.label}
              </Button>
            ))}
          </div>
        ) : null}
        {node.type === "gradient.sample" ? (
          <GradientStopsEditor node={node} setProperties={setProperties} />
        ) : null}
      </ModuleStage>
    </ModuleStack>
  );
}

type ParticleNodeAssetType = "Texture" | "Model" | "ParticleEmitter" | "ParticleGraph";

/** Rows for a node's asset properties (Noise **Texture**, Mesh Shape **Model**) and their shared picker; None clears one. */
function useParticleNodeAssetPicker(
  node: ParticleGraphNode,
  setProperties: (patch: Record<string, unknown>) => void,
): {
  row: (spec: { property: string; label: string; assetTypes: readonly ParticleNodeAssetType[]; placeholder: string; description: string }) => PropertyRow;
  picker: ReactNode;
} {
  const { assetRegistry } = useRegistryState();
  const [picking, setPicking] = useState<{ property: string; assetTypes: readonly ParticleNodeAssetType[] } | null>(null);
  const assetsOf = (assetTypes: readonly ParticleNodeAssetType[]) => (assetRegistry?.list() ?? [])
    .filter((asset) => (assetTypes as readonly string[]).includes(asset.header.type))
    .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  return {
    row: ({ property, label, assetTypes, placeholder, description }) => {
      const guid = typeof node.properties[property] === "string" ? (node.properties[property] as string) : null;
      const selected = guid ? assetsOf(assetTypes).find((asset) => asset.guid === guid) : undefined;
      return {
        id: property,
        kind: "asset",
        label,
        value: guid,
        placeholder,
        description,
        onPick: () => setPicking({ property, assetTypes }),
        onChange: (next) => setProperties({ [property]: next }),
        ...assetRowIdentity(selected ? { name: selected.name, type: selected.type } : undefined),
      };
    },
    picker: picking ? (
      <AssetPicker
        open
        onOpenChange={(open) => { if (!open) setPicking(null); }}
        assets={assetsOf(picking.assetTypes)}
        allowedTypes={[...picking.assetTypes]}
        allowNone
        onPick={(next) => {
          setProperties({ [picking.property]: next });
          setPicking(null);
        }}
        data-testid={`particle-node-${picking.property}-picker`}
      />
    ) : null,
  };
}

/** Material and emitter settings; the Emitter Output shows the same rows. */
function ParticleGraphSettingsDetails({
  document,
  onChange,
}: {
  document: ParticleGraphDocument;
  onChange: Commit;
}) {
  const { assetRegistry } = useRegistryState();
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
    // Keyed so field drafts and list focus never carry over to another node, or across a conversion.
    return (
      <ParticleNodeDetails key={`${node.id}:${node.type}`} document={document} node={node} onChange={onChange} />
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
  const spawned = useSpawnPreviewEmitters(previewDocument);
  const library = useMemo(
    () =>
      previewDocument
        ? emitterPreviewLibrary({ kind: "graph", document: previewDocument }, spawned)
        : null,
    [previewDocument, spawned],
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
        <ScrollArea className="min-h-0 flex-1 py-1">
          <WindowedList itemCount={rows.length} rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}>
            {(index) => {
              const row = rows[index]!;
              return (
                <DiagnosticResultRow
                  severity={row.severity}
                  message={row.message}
                  code={row.code}
                  selected={selected !== null && sameDiagnostic(row, selected)}
                  onSelect={() => {
                    setSelectedRow(row);
                    if (row.nodeId) onFocusNode(row.nodeId);
                  }}
                  testId={`particle-graph-diagnostic-${row.code}`}
                />
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
    () => hydrateParticleGraphForEditor(particleGraphToSerialized(document), document.parameters),
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
  // Menu actions read the document as it is when picked.
  const documentRef = useRef(document);
  documentRef.current = document;
  const contextMenuItemsForNode = useCallback(
    (nodeId: string): NestedMenuItem[] => {
      const node = documentRef.current.nodes.find((entry) => entry.id === nodeId);
      if (node && particleConstantValueType(node.type)) {
        return [{
          id: "convert-to-parameter",
          label: "Convert to Parameter",
          testId: "particle-graph-convert-to-parameter",
          onSelect: () => {
            const next = convertParticleConstantToParameter(documentRef.current, nodeId, newParticleParameterId);
            if (next) commit(next);
          },
        }];
      }
      if (node?.type === PARTICLE_PARAMETER_NODE_TYPE) {
        return [{
          id: "convert-to-constant",
          label: "Convert to Constant",
          testId: "particle-graph-convert-to-constant",
          onSelect: () => {
            const next = convertParticleParameterToConstant(documentRef.current, nodeId);
            if (next) commit(next);
          },
        }];
      }
      return [];
    },
    [commit],
  );
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
        addNodeHistoryScope="particle"
        canConnect={canConnect}
        sessionViewport={sessionViewport}
        onSessionViewportChange={onSessionViewportChange}
        onSelectionChange={(ids) => setSelectedNodeId(ids[0] ?? null)}
        focusedNodeId={editing.focusedNodeId ?? undefined}
        commitPositionsOnDragEnd
        contextMenuItemsForNode={contextMenuItemsForNode}
        onChange={(next, meta) =>
          commit(
            // New Parameter entries declare their parameter; pasted nodes bring theirs back.
            reconcileParticleParameters(document, serializedToParticleGraph(next, document), {
              newId: newParticleParameterId,
              snapshots: particleParameterSnapshots(next),
            }),
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
