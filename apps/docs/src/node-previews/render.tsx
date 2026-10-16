/**
 * Renders every catalog node with the editor's own graph components, for the
 * node reference pages. `scripts/node-previews.mjs` bundles this file and runs
 * it at docs build time; nothing here ships to the browser.
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
} from "@babylonslate/graph-ui";
import { humanizePropertyLabel, PinShapeGlyph } from "@babylonslate/editor-kit";
import { allNodeDefinitions } from "@babylonslate/scripting-nodes";
import {
  MATERIAL_CATALOG,
  materialPaletteNodes,
  pinsForMaterialNode,
  type MaterialDomain,
} from "@babylonslate/shader-graph";
import {
  newParticleNodeProperties,
  PARTICLE_CATALOG,
  pinsForParticleNode,
} from "@babylonslate/particle-graph";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_NODE_TYPE,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
  defaultPropertiesForClassId,
  kindForCatalogClassId,
  pinsForBtKind,
} from "@babylonslate/behaviour-tree";
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
const nodeComponents = { ...graphNodeTypes, ...treeNodeTypes } as unknown as Record<string, NodeComponent>;

function renderNode(id: string, type: string, data: Record<string, unknown>, selectedAttachmentId?: string): string {
  const Node = nodeComponents[type];
  if (!Node) throw new Error(`No editor node component for ${type}`);
  const markup = renderToStaticMarkup(
    <ReactFlowProvider>
      <GraphEditorProvider value={{ ...context, selectedAttachmentId }}>
        <Node id={id} data={data} type={type} selected={false} />
      </GraphEditorProvider>
    </ReactFlowProvider>,
  );
  return `<div class="${GRAPH_SCOPE} haptic-node-preview" inert aria-hidden="true">${markup}</div>`;
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
    previews[`${scriptGraphFolder(def.id)}/${def.id}`] = {
      html: renderNode(def.id, resolveNodeType(def.id, data), data),
      inputs: docsPins(pins, "in", scriptPinLabel),
      outputs: docsPins(pins, "out", scriptPinLabel),
    };
  }
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
    const properties = newParticleNodeProperties(def.type);
    const data = {
      ...properties,
      __particleRole: def.role,
      title: def.title,
      __nodeType: def.type,
      __category: def.category,
      __pins: pinsForParticleNode(def.type, properties),
    };
    const pins = [
      ...(def.inputs ?? []).map((pin) => ({ ...pin, direction: "in" })),
      ...(def.outputs ?? []).map((pin) => ({ ...pin, direction: "out" })),
    ] as CatalogPin[];
    previews[`particle/${def.type}`] = {
      html: renderNode(def.type, "pinNode", data),
      inputs: docsPins(pins, "in", (pin) => pin.name),
      outputs: docsPins(pins, "out", (pin) => pin.name),
    };
  }
}

/** Decorators and services draw as rows on the node they are attached to, shown here on a Sequence. */
const ATTACHMENT_HOST = BT_COMPOSITE_CATALOG.find((entry) => entry.title === "Sequence") ?? BT_COMPOSITE_CATALOG[0]!;

function behaviourTreePreviews(previews: NodePreviews): void {
  const nodeData = (classId: string, title: string) => {
    const kind = kindForCatalogClassId(classId);
    return { title, classId, kind, properties: defaultPropertiesForClassId(classId), __pins: pinsForBtKind(kind) };
  };
  for (const entry of [...BT_COMPOSITE_CATALOG, ...BT_TASK_CATALOG]) {
    previews[`behaviour-tree/${entry.classId}`] = {
      html: renderNode(entry.classId, BT_NODE_TYPE, nodeData(entry.classId, entry.title)),
      inputs: [],
      outputs: [],
    };
  }
  for (const [rows, entries] of [["decorators", BT_DECORATOR_CATALOG], ["services", BT_SERVICE_CATALOG]] as const) {
    for (const entry of entries) {
      const attachment = { id: "attachment", classId: entry.classId, title: entry.title };
      const data = { ...nodeData(ATTACHMENT_HOST.classId, ATTACHMENT_HOST.title), [rows]: [attachment] };
      previews[`behaviour-tree/${entry.classId}`] = {
        html: renderNode(entry.classId, BT_NODE_TYPE, data, attachment.id),
        inputs: [],
        outputs: [],
      };
    }
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
