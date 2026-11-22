/**
 * Material asset type and domain predicates, the Material header meta, and the
 * picker filters that prefer an open document's domain over the saved header.
 * `content-browser-helpers.ts` re-exports the names its importers use.
 */
import { isMaterialTextureAssetType } from "@haptic/core";
import { isEnvironmentTexturePayload } from "@haptic/assets";
import {
  MATERIAL_INSTANCE_MAX_DEPTH,
  normalizeMaterialInstanceDocument,
  parseMaterialDomain,
  type MaterialDomain,
} from "@haptic/shader-graph";
import { MATERIAL_PIN_DOMAINS } from "@haptic/scripting-nodes";

/** Header payload fields Content Browser / pickers can read without loading the document. */
export function materialHeaderMeta(
  assetType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (assetType === "MaterialInstance") {
    const instance = normalizeMaterialInstanceDocument(payload);
    return { domain: instance.domain, parentGuid: instance.parentGuid };
  }
  if (assetType !== "Material") return undefined;
  return {
    domain: parseMaterialDomain(payload.domain),
  };
}

export function isMaterialSamplerTextureAsset(header: { type: string; payload?: unknown }): boolean {
  return isMaterialTextureAssetType(header.type) &&
    (header.type !== "Texture" || !isEnvironmentTexturePayload(header.payload));
}

/** Assets a Material slot accepts: authored Materials and their instances. */
export function isMaterialAssetType(type: string): boolean {
  return type === "Material" || type === "MaterialInstance";
}

/** Domain names as the Material editor's Domain row shows them. */
export const MATERIAL_DOMAIN_LABELS: Readonly<Record<MaterialDomain, string>> = {
  surface: "Surface",
  landscape: "Landscape",
  postProcess: "Post Process",
  particle: "Particle",
  text: "Text",
  decal: "Decal",
};

type IndexedMaterialAsset = {
  path: string;
  header: { guid: string; type: string; name?: string; payload?: Record<string, unknown> };
};

type OpenMaterialDocuments = ReadonlyArray<{
  ref: { kind: string; path: string };
  content: unknown;
}>;

function openMaterialDocumentFor(
  asset: { path: string; header: { type: string } },
  openDocuments: OpenMaterialDocuments,
) {
  const kind = asset.header.type === "MaterialInstance" ? "material-instance" : "material";
  return openDocuments.find((entry) => entry.ref.kind === kind && entry.ref.path === asset.path);
}

/** The Material domain a scripting node's Material pin takes (`MATERIAL_PIN_DOMAINS`); null when it takes any Material. */
export function graphPinMaterialDomain(nodeType: string): MaterialDomain | null {
  return MATERIAL_PIN_DOMAINS.get(nodeType)?.domain ?? null;
}

/** A domain recorded on a header or document, or undefined when none is (a header written without the editor's meta). */
function recordedDomain(value: unknown): MaterialDomain | undefined {
  return typeof value === "string" && value.length > 0 ? parseMaterialDomain(value) : undefined;
}

/**
 * Every Material's and Material Instance's domain by guid, from an open document first, else the saved header. A
 * Material whose header records no domain is left out: its domain is unknown until it loads, so validation does not
 * flag it and Surface slots take it (`materialDomainMatches`). An Instance takes its root's domain, followed through
 * its parents, so a root whose domain changed since the Instance was saved still decides; only a chain that reaches no
 * known Material (a missing parent, an unrecorded root or a cycle) falls back to the domain the Instance cached.
 */
export function materialDomainsFromAssets(
  assets: ReadonlyArray<IndexedMaterialAsset>,
  openDocuments: OpenMaterialDocuments = [],
): Record<string, MaterialDomain> {
  const roots = new Map<string, MaterialDomain>();
  const instances = new Map<string, { parentGuid: string | null; cached: MaterialDomain | undefined }>();
  for (const asset of assets) {
    if (!isMaterialAssetType(asset.header.type)) continue;
    const open = openMaterialDocumentFor(asset, openDocuments);
    const opened = open && open.content && typeof open.content === "object";
    const source = opened ? (open.content as Record<string, unknown>) : (asset.header.payload ?? {});
    if (asset.header.type === "Material") {
      // An open document always has a domain: it parses as it loads.
      const domain = opened ? parseMaterialDomain(source.domain) : recordedDomain(source.domain);
      if (domain) roots.set(asset.header.guid, domain);
      continue;
    }
    const parent = typeof source.parentGuid === "string" ? source.parentGuid.trim() : "";
    instances.set(asset.header.guid, { parentGuid: parent || null, cached: recordedDomain(source.domain) });
  }
  const domains: Record<string, MaterialDomain> = Object.fromEntries(roots);
  for (const [guid, instance] of instances) {
    let current = instance.parentGuid;
    let resolved: MaterialDomain | undefined;
    for (let depth = 0; current && depth <= MATERIAL_INSTANCE_MAX_DEPTH; depth++) {
      resolved = roots.get(current);
      if (resolved) break;
      current = current === guid ? null : (instances.get(current)?.parentGuid ?? null);
    }
    const domain = resolved ?? instance.cached;
    if (domain) domains[guid] = domain;
  }
  return domains;
}

/** Whether a Material whose known domain is `held` (undefined: not recorded, which loads as Surface) draws in `domain`. */
export function materialDomainMatches(held: string | undefined, domain: string): boolean {
  return held === domain || (held === undefined && domain === "surface");
}

/** Picker entries for the Materials and Material Instances of `domain`. */
export function materialPickerEntries(
  assets: ReadonlyArray<IndexedMaterialAsset>,
  openDocuments: OpenMaterialDocuments,
  domain: MaterialDomain,
): Array<{ guid: string; name: string; type: string; path: string }> {
  const domains = materialDomainsFromAssets(assets, openDocuments);
  return assets
    .filter((asset) => isMaterialAssetType(asset.header.type) && materialDomainMatches(domains[asset.header.guid], domain))
    .map((asset) => ({ guid: asset.header.guid, name: asset.header.name ?? asset.header.guid, type: asset.header.type, path: asset.path }));
}

/** A guid's Material domain, or undefined when it names no Material or Material Instance. */
export type MaterialDomainLookup = (guid: string) => string | undefined;

/**
 * Whether a slot that draws `domain` takes `guid`: clearing it, a picker-only entry the slot offers itself (`also`,
 * such as a Mesh's Model Materials), or a Material of that domain. A slot with no domain takes anything.
 */
export function materialSlotTakes(
  domain: string | undefined,
  guid: string | null,
  domainOf: MaterialDomainLookup,
  also: readonly string[] = [],
): boolean {
  if (!domain || !guid || also.includes(guid)) return true;
  return materialDomainMatches(domainOf(guid), domain);
}

/** The assets a slot's picker lists: only Materials of the slot's domain when it has one, after any picker-only entry. */
export function materialSlotPickerAssets<T extends { guid: string }>(
  domain: string | undefined,
  assets: readonly T[],
  domainOf: MaterialDomainLookup,
  leading?: T,
): T[] {
  const offered = domain ? assets.filter((asset) => materialDomainMatches(domainOf(asset.guid), domain)) : [...assets];
  return leading ? [leading, ...offered] : offered;
}

function domainLabel(domain: string): string {
  return MATERIAL_DOMAIN_LABELS[domain as MaterialDomain] ?? domain;
}

/** The slot's invalid-reference text when it holds a Material of another domain; undefined otherwise. */
export function materialSlotError(
  domain: string | undefined,
  guid: string | null | undefined,
  domainOf: MaterialDomainLookup,
): string | undefined {
  const held = guid ? domainOf(guid) : undefined;
  if (!domain || !held || held === domain) return undefined;
  return `Needs a ${domainLabel(domain)} Material; this is a ${domainLabel(held)} Material.`;
}

/** An asset row's paste guard and invalid-reference state for a slot that draws `domain`. */
export function materialSlotRowState(
  domain: string | undefined,
  guid: string | null | undefined,
  domainOf: MaterialDomainLookup | undefined,
  also: readonly string[] = [],
): { acceptsAsset?: (guid: string) => boolean; error?: string } {
  if (!domain || !domainOf) return {};
  const error = materialSlotError(domain, guid, domainOf);
  return {
    acceptsAsset: (next) => materialSlotTakes(domain, next, domainOf, also),
    ...(error ? { error } : {}),
  };
}

export function filterInspectorPinPickerAssets<
  T extends { guid: string; type: string },
>(
  assets: readonly T[],
  indexed: ReadonlyArray<IndexedMaterialAsset>,
  openDocuments: OpenMaterialDocuments,
  options: { nodeType: string },
): T[] {
  const domain = graphPinMaterialDomain(options.nodeType);
  if (!domain) return [...assets];
  const domains = materialDomainsFromAssets(indexed, openDocuments);
  return assets.filter((entry) => materialDomainMatches(domains[entry.guid], domain));
}
