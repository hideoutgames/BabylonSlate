/**
 * Pin glyphs for every node reference page, and the node itself drawn with the
 * editor's own graph components for Class and Material nodes.
 * `scripts/node-previews.mjs` bundles this file and runs it at docs build time;
 * nothing here ships to the browser.
 */
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import {
  GraphEditorProvider,
  graphNodeTypes,
  pinCssVar,
  pinVisualShape,
  resolveNodeType,
  type PinTypeRef,
} from "@haptic/graph-ui";
import { humanizePropertyLabel, PinShapeGlyph } from "@haptic/editor-kit";
import { allNodeDefinitions } from "@haptic/scripting-nodes";
import {
  MATERIAL_CATALOG,
  materialPaletteNodes,
  pinsForMaterialNode,
  type MaterialDomain,
} from "@haptic/shader-graph";
import { PARTICLE_CATALOG } from "@haptic/particle-graph";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
} from "@haptic/behaviour-tree";
import { scriptGraphFolder } from "./catalog";
import type { DocsPin, NodePreviews } from "./types";

/** The class that scopes the editor tokens and utilities in the generated CSS. */
export const GRAPH_SCOPE = "haptic-graph";

type CatalogPin = { name: string; kind?: string; direction?: string; type: PinTypeRef };

type GraphEditorContextValue = Parameters<typeof GraphEditorProvider>[0]["value"];

const context: GraphEditorContextValue = {
  pendingPin: null,
  onPinTap: () => {},
  nodeErrorCount: () => 0,
  pinHasError: () => false,
  pinDisplayType: () => undefined,
  connectEndMode: "default",
};

type NodeComponent = ComponentType<Record<string, unknown>>;
const nodeComponents = graphNodeTypes as unknown as Record<string, NodeComponent>;

function renderNode(id: string, type: string, data: Record<string, unknown>): string {
  const Node = nodeComponents[type];
  if (!Node) throw new Error(`No editor node component for ${type}`);
  const markup = renderToStaticMarkup(
    <ReactFlowProvider>
      <GraphEditorProvider value={context}>
        <Node id={id} data={data} type={type} selected={false} />
      </GraphEditorProvider>
    </ReactFlowProvider>,
  );
  // Graph canvases stay dark in every theme, as GraphEditor's colorMode="dark" does in the editor.
  return `<div class="dark ${GRAPH_SCOPE} haptic-node-preview" inert aria-hidden="true">${markup}</div>`;
}

function glyph(type: PinTypeRef): string {
  const mark = renderToStaticMarkup(
    <PinShapeGlyph shape={pinVisualShape(type)} color={pinCssVar(type)} connected outlined={false} size="1em" />,
  );
  return `<span class="${GRAPH_SCOPE} haptic-pin-type" aria-hidden="true">${mark}</span>`;
}

/** Class graph table labels: the editor's name for each pin, with the flow pins called In and Out. */
function scriptPinLabel(pin: CatalogPin): string {
  if (pin.kind === "exec" && /^(exec|then)$/.test(pin.name)) return pin.direction === "in" ? "In" : "Out";
  return humanizePropertyLabel(pin.name);
}

function docsPins(pins: readonly CatalogPin[], direction: "in" | "out", label: (pin: CatalogPin) => string): DocsPin[] {
  return pins.filter((pin) => pin.direction === direction).map((pin) => ({ label: label(pin), glyph: glyph(pin.type) }));
}

function scriptPreviews(previews: NodePreviews): void {
  for (const def of allNodeDefinitions()) {
    const pins = def.pins({});
    const graph = scriptGraphFolder(def.id);
    previews[`${graph}/${def.id}`] = {
      // Animation Graph pages list pins without a node preview.
      html: graph === "class" ? renderScriptNode(def, pins) : undefined,
      inputs: docsPins(pins, "in", scriptPinLabel),
      outputs: docsPins(pins, "out", scriptPinLabel),
    };
  }
}

type ScriptNodeDefinition = ReturnType<typeof allNodeDefinitions>[number];

function renderScriptNode(def: ScriptNodeDefinition, pins: ReturnType<ScriptNodeDefinition["pins"]>): string {
  const data: Record<string, unknown> = {
    title: def.title,
    __nodeType: def.id,
    __category: def.category,
    __pure: def.pure ?? false,
    __latent: def.latent ?? false,
    __pins: pins,
  };
  if (def.developmentOnlyByDefault) data.developmentOnly = true;
  if (def.editorOnly) data.__editorOnly = true;
  return renderNode(def.id, resolveNodeType(def.id, data), data);
}

const MATERIAL_DOMAINS: MaterialDomain[] = ["surface", "landscape", "postProcess", "particle", "text"];

function materialPreviews(previews: NodePreviews): void {
  const palette = new Map(MATERIAL_DOMAINS.flatMap((domain) => materialPaletteNodes(domain)).map((node) => [node.id, node]));
  for (const def of MATERIAL_CATALOG) {
    const entry = palette.get(def.type);
    const defaults = entry?.defaultData ?? { __material: true };
    const properties = Object.fromEntries(Object.entries(defaults).filter(([key]) => !key.startsWith("__")));
    const data = {
      ...defaults,
      title: def.title,
      __nodeType: def.type,
      __category: def.category,
      __pins: entry?.pins ?? pinsForMaterialNode(def.type, { properties }),
    };
    const pins = [
      ...def.inputs.map((pin) => ({ ...pin, direction: "in" })),
      ...def.outputs.map((pin) => ({ ...pin, direction: "out" })),
    ] as CatalogPin[];
    previews[`material/${def.type}`] = {
      html: renderNode(def.type, "pinNode", data),
      inputs: docsPins(pins, "in", (pin) => pin.name),
      outputs: docsPins(pins, "out", (pin) => pin.name),
    };
  }
}

function particlePreviews(previews: NodePreviews): void {
  for (const def of PARTICLE_CATALOG) {
    const pins = [
      ...(def.inputs ?? []).map((pin) => ({ ...pin, direction: "in" })),
      ...(def.outputs ?? []).map((pin) => ({ ...pin, direction: "out" })),
    ] as CatalogPin[];
    previews[`particle/${def.type}`] = {
      inputs: docsPins(pins, "in", (pin) => pin.name),
      outputs: docsPins(pins, "out", (pin) => pin.name),
    };
  }
}

/** Behaviour Tree pages have no pin tables; the entries let the build check their `node:`. */
function behaviourTreePreviews(previews: NodePreviews): void {
  for (const entry of [...BT_COMPOSITE_CATALOG, ...BT_TASK_CATALOG, ...BT_DECORATOR_CATALOG, ...BT_SERVICE_CATALOG]) {
    previews[`behaviour-tree/${entry.classId}`] = { inputs: [], outputs: [] };
  }
}

export function renderNodePreviews(): NodePreviews {
  const previews: NodePreviews = {};
  scriptPreviews(previews);
  materialPreviews(previews);
  particlePreviews(previews);
  behaviourTreePreviews(previews);
  return previews;
}
