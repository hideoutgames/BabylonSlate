import { normalizeRenderTargetTexturePayload } from "@babylonslate/core";

/** Header dependencies keep live sampler outputs reachable in Play and export. */
export function renderTargetAssetDependencies(assetType: string, payload: unknown): string[] {
  if (assetType !== "RenderTargetTexture") return [];
  const guid = normalizeRenderTargetTexturePayload(payload).renderTargetGuid;
  return guid ? [guid] : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Remap declared capture references without rewriting ordinary authored strings. */
export function remapRenderTargetPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const guid = (value: unknown): unknown => typeof value === "string" ? remap.get(value) ?? value : value;
  if (assetType === "RenderTargetTexture") {
    const target = normalizeRenderTargetTexturePayload(payload).renderTargetGuid;
    return { ...payload, renderTargetGuid: target ? remap.get(target) ?? target : null };
  }
  const graphAsset = assetType === "Class" || assetType === "Graph";
  const materialAsset = ["Material", "MaterialFunction", "Shader", "ShaderGraph"].includes(assetType);
  if (!graphAsset && !materialAsset && assetType !== "Scene" && assetType !== "SceneLayer") return payload;
  const assetDefault = (spec: Record<string, unknown>, value: unknown): unknown => {
    const accepts = (type: unknown): boolean => type === "RenderTarget" || type === "RenderTargetTexture" || type === "Texture";
    const valueRef = spec.typeId === "asset" && accepts(spec.typeClassId);
    if (spec.container === "map" && Array.isArray(value)) {
      const keyRef = spec.keyTypeId === "asset" && accepts(spec.keyTypeClassId);
      return value.map((entry) => {
        const pair = asRecord(entry);
        return pair ? { ...pair, key: keyRef ? guid(pair.key) : pair.key, value: valueRef ? guid(pair.value) : pair.value } : entry;
      });
    }
    if (!valueRef) return value;
    if (spec.container === "array") return Array.isArray(value) ? value.map(guid) : value;
    return guid(value);
  };
  const nodeDefaults = (type: unknown, props: Record<string, unknown>): Record<string, unknown> => {
    const names = type === "render-target.getMode" ? ["target", "Render Target"]
      : type === "render-target.getTextureTarget" ? ["texture", "Texture"]
        : type === "render-target.setRenderTarget" ? ["value", "Render Target"]
          : type === "material.setTextureParameter" ? ["value", "Value"]
            : type === "variables.set" ? ["value", typeof props.variableName === "string" ? props.variableName : "Value"] : [];
    const result = { ...props };
    for (const key of names.flatMap((name) => [`default:${name}`, name])) {
      if (Object.hasOwn(props, key)) result[key] = type === "variables.set" ? assetDefault(props, props[key]) : guid(props[key]);
    }
    return result;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    const row = asRecord(value);
    if (!row) return value;
    const next = Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, walk(entry)]));
    if (row.classId === "RenderTargetCaptureComponent") {
      const properties = asRecord(next.properties);
      if (properties && Object.hasOwn(properties, "renderTargetGuid")) next.properties = { ...properties, renderTargetGuid: guid(properties.renderTargetGuid) };
    }
    if (materialAsset && Object.hasOwn(row, "textureGuid")) next.textureGuid = guid(row.textureGuid);
    if (graphAsset && row.kind === "variable" && Object.hasOwn(row, "defaultValue")) next.defaultValue = assetDefault(row, row.defaultValue);
    if (graphAsset && (typeof row.type === "string" || typeof row.typeId === "string")) {
      const type = row.type ?? row.typeId;
      const data = asRecord(next.data);
      const properties = asRecord(data?.properties);
      if (properties) next.data = { ...data, properties: nodeDefaults(type, properties) };
      else if (data) next.data = nodeDefaults(type, data);
      else {
        const directProperties = asRecord(next.properties);
        if (directProperties) next.properties = nodeDefaults(type, directProperties);
      }
    }
    return next;
  };
  return walk(payload) as Record<string, unknown>;
}
