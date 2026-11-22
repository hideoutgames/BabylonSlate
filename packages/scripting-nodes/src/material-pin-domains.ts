import {
  diagnostic,
  listValidationRules,
  readPinDefault,
  registerValidationRule,
  type LogicGraph,
  type TypeContext,
} from "@haptic/scripting";

/** A Material domain a node's Material pin can take. */
export type MaterialPinDomain = "surface" | "postProcess" | "decal";

/**
 * Nodes whose Material pin takes only one Material domain, by node type: the pin and its domain. Pickers list only
 * Materials of that domain and validation rejects a pin default of another. Any other node's Material pin takes any
 * Material.
 */
export const MATERIAL_PIN_DOMAINS: ReadonlyMap<string, { pinId: string; domain: MaterialPinDomain }> = new Map([
  ["scene.registerPostProcess", { pinId: "material", domain: "postProcess" }],
  ["scene.unregisterPostProcess", { pinId: "material", domain: "postProcess" }],
  ["scene-layer.registerPostProcess", { pinId: "material", domain: "postProcess" }],
  ["scene-layer.unregisterPostProcess", { pinId: "material", domain: "postProcess" }],
  ["decals.spawn", { pinId: "material", domain: "decal" }],
  ["material.setMaterialInstance", { pinId: "instance", domain: "surface" }],
] as const);

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  surface: "Surface",
  landscape: "Landscape",
  postProcess: "Post Process",
  particle: "Particle",
  text: "Text",
  decal: "Decal",
};

const label = (domain: string) => DOMAIN_LABELS[domain] ?? domain;

function validateMaterialPinDomains(graphs: readonly LogicGraph[], ctx: TypeContext) {
  const domains = ctx.materialDomains;
  if (!domains) return [];
  const out = [];
  for (const graph of graphs) {
    const wired = new Set(graph.edges.map((edge) => `${edge.targetNodeId}\t${edge.targetPinId}`));
    for (const node of graph.nodes) {
      const slot = MATERIAL_PIN_DOMAINS.get(node.typeId);
      if (!slot || wired.has(`${node.id}\t${slot.pinId}`)) continue;
      const raw = readPinDefault(node.properties, slot.pinId);
      const guid = typeof raw === "string" ? raw.trim() : "";
      const domain = guid ? domains[guid] : undefined;
      if (!domain || domain === slot.domain) continue;
      out.push(
        diagnostic({
          code: "material.pinDomain",
          message: `Needs a ${label(slot.domain)} Material; this is a ${label(domain)} Material.`,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
          pinId: slot.pinId,
        }),
      );
    }
  }
  return out;
}

export function registerMaterialPinDomainValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "material.pinDomain")) return;
  registerValidationRule({ id: "material.pinDomain", run: validateMaterialPinDomains });
}
