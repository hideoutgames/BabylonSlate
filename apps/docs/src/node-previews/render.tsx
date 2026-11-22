/**
 * Pin glyphs for every node reference page, and the node itself drawn with the
 * editor's own graph components for Class, Animation Graph, Material and Particle
 * Graph nodes and Behaviour Tree composites and tasks. Behaviour Tree decorators and
 * services are rows on another node in the editor, not nodes, so their pages have none.
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
  treeNodeTypes,
  type PinTypeRef,
} from "@haptic/graph-ui";
import { humanizePropertyLabel, PinShapeGlyph } from "@haptic/editor-kit";
import { allNodeDefinitions } from "@haptic/scripting-nodes";
import {
  MATERIAL_CATALOG,
  defaultNamedRerouteColor,
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  materialPaletteNodes,
  namedRerouteColorCss,
  pinsForMaterialNode,
  type MaterialDomain,
} from "@haptic/shader-graph";
import { hydrateParticleGraphForEditor, newParticleNodeProperties, PARTICLE_CATALOG } from "@haptic/particle-graph";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_NODE_TYPE,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
  kindForCatalogClassId,
  pinsForBtKind,
} from "@haptic/behaviour-tree";
import { scriptGraphFolder } from "./catalog";
import type { DocsPin, NodePreviews } from "./types";

/** The class that scopes the editor tokens and utilities in the generated CSS. */
export const GRAPH_SCOPE = "haptic-graph";

type CatalogPin = { name: string; kind?: string; direction?: string; type: PinTypeRef };

type GraphEditorContextValue = Parameters<typeof GraphEditorProvider>[0]["value"];

const context: GraphEditorContextValue = {
  onPinTap: () => {},
  pinDisplayType: () => undefined,
  connectEndMode: "default",
};

type NodeComponent = ComponentType<Record<string, unknown>>;
const nodeComponents = { ...graphNodeTypes, ...treeNodeTypes } as unknown as Record<string, NodeComponent>;

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
      // Animation Graph event and rule graphs draw these nodes with the Class graph's components.
      html: renderScriptNode(def, pins),
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
  // The Class graph Reroute draws as the editor's knot, which hosts mark as they hydrate it.
  if (def.id === "flow.reroute") data.__reroute = true;
  return renderNode(def.id, resolveNodeType(def.id, data), data);
}

const MATERIAL_DOMAINS: MaterialDomain[] = ["surface", "landscape", "postProcess", "particle", "text", "decal", "ui"];

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
      // A Named Reroute's header takes its colour; a new one starts with the first default colour.
      ...(isNamedRerouteDeclarationType(def.type) || isNamedRerouteUsageType(def.type)
        ? { __headerColor: namedRerouteColorCss(defaultNamedRerouteColor(0)) }
        : {}),
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

/** A new node of `type` as the Particle Graph canvas draws it: its default properties, hydrated like an opened graph. */
function renderParticleNode(type: string): string {
  const [node] = hydrateParticleGraphForEditor({
    nodes: [{ id: type, type, position: { x: 0, y: 0 }, data: newParticleNodeProperties(type) }],
    edges: [],
  }).nodes;
  const data = node!.data as Record<string, unknown>;
  return renderNode(type, resolveNodeType(type, data), data);
}

function particlePreviews(previews: NodePreviews): void {
  for (const def of PARTICLE_CATALOG) {
    const pins = [
      ...(def.inputs ?? []).map((pin) => ({ ...pin, direction: "in" })),
      ...(def.outputs ?? []).map((pin) => ({ ...pin, direction: "out" })),
    ] as CatalogPin[];
    previews[`particle/${def.type}`] = {
      html: renderParticleNode(def.type),
      inputs: docsPins(pins, "in", (pin) => pin.name),
      outputs: docsPins(pins, "out", (pin) => pin.name),
    };
  }
}

/**
 * Behaviour Tree pages have no pin tables; the entries let the build check their `node:`. Composites and tasks are
 * drawn as a node under a parent, as the tree editor shows them, with no decorators or services attached.
 */
function behaviourTreePreviews(previews: NodePreviews): void {
  for (const entry of [...BT_COMPOSITE_CATALOG, ...BT_TASK_CATALOG]) {
    const kind = kindForCatalogClassId(entry.classId);
    const data = {
      title: entry.title,
      kind,
      classId: entry.classId,
      sortIndex: 0,
      decorators: [],
      services: [],
      properties: {},
      __pins: pinsForBtKind(kind),
    };
    previews[`behaviour-tree/${entry.classId}`] = { html: renderNode(entry.classId, BT_NODE_TYPE, data), inputs: [], outputs: [] };
  }
  for (const entry of [...BT_DECORATOR_CATALOG, ...BT_SERVICE_CATALOG]) {
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
