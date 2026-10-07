import {
  normalizeMaterialParameterCatalog,
  normalizeMaterialParameterOverrides,
  type MaterialParameterCatalog,
  type MaterialParameterValue,
} from "@babylonslate/core";
import {
  MaterialObject,
  PostProcessMaterialObject,
  type MaterialInstanceObject,
} from "@babylonslate/object-model";

type State = {
  revision: number;
  authoredNames?: Set<string>;
  defaults: ReadonlyMap<string, MaterialParameterValue>;
  values: Map<string, MaterialParameterValue>;
};
const copy = (value: MaterialParameterValue): MaterialParameterValue =>
  value.kind === "color"
    ? { kind: "color", value: [...value.value] }
    : { ...value };

const equal = (left: MaterialParameterValue, right: MaterialParameterValue | undefined): boolean =>
  right?.kind === left.kind && (left.kind === "float" ? left.value === (right as typeof left).value
    : left.kind === "texture" ? left.textureAssetGuid === (right as typeof left).textureAssetGuid
      : left.value.every((channel, index) => channel === (right as typeof left).value[index]));

/** Session-owned values for synchronous worker reads; assets and entry overrides remain immutable. */
export class RuntimeMaterialParameters {
  private catalog: MaterialParameterCatalog;
  private textures: ReadonlySet<string>;
  private readonly states = new WeakMap<MaterialInstanceObject, State>();
  constructor(
    catalog: MaterialParameterCatalog | undefined,
    textures: readonly string[] | undefined,
  ) {
    this.catalog = normalizeMaterialParameterCatalog(catalog);
    this.textures = new Set(textures);
  }

  /** Loaded catalog admission for a surface assignment; never accepts made-up assets. */
  acceptsAssignment(assetGuid: string): boolean {
    return Object.hasOwn(this.catalog, assetGuid) && this.catalog[assetGuid]!.domain === "surface";
  }

  revision(material: MaterialInstanceObject): number { return this.state(material)?.revision ?? -1; }

  describe(material: MaterialInstanceObject): Record<string, MaterialParameterValue> | null {
    const state = this.state(material);
    return state ? Object.fromEntries([...state.values].map(([name, value]) => [name, copy(value)])) : null;
  }

  replaceCatalog(catalog: MaterialParameterCatalog | undefined, textures: readonly string[] | undefined): void {
    this.catalog = normalizeMaterialParameterCatalog(catalog);
    this.textures = new Set(textures);
  }

  accepts(
    material: MaterialInstanceObject,
    name: string,
    value: MaterialParameterValue,
  ): boolean {
    const state = this.state(material);
    const expected = state?.defaults.get(name);
    return !!expected && this.valid(value) && expected.kind === value.kind;
  }

  get(
    material: MaterialInstanceObject,
    name: string,
    kind: MaterialParameterValue["kind"],
  ): MaterialParameterValue | null {
    const value = this.state(material)?.values.get(name);
    return value?.kind === kind ? copy(value) : null;
  }

  set(
    material: MaterialInstanceObject,
    name: string,
    value: MaterialParameterValue,
  ): boolean {
    if (!this.accepts(material, name, value)) return false;
    const state = this.state(material)!;
    state.values.set(name, copy(value)); state.revision++;
    return true;
  }

  /** Atomic reapply boundary; validates every value before changing any state. */
  seed(material: MaterialInstanceObject, overrides: Readonly<Record<string, MaterialParameterValue>>): boolean {
    const state = this.state(material);
    if (!state || Object.entries(overrides).some(([name, value]) => !this.accepts(material, name, value))) return false;
    const defaults = new Map(state.defaults);
    for (const [name, value] of Object.entries(overrides)) {
      defaults.set(name, copy(value));
      (state.authoredNames ??= new Set()).add(name);
      state.values.set(name, copy(value));
    }
    state.defaults = defaults;
    state.revision++;
    return true;
  }

  /** Copies authoring data only; never exposes WeakMap or MaterialObject references. */
  captureOverrides(material: MaterialInstanceObject): Record<string, MaterialParameterValue> | null {
    const state = this.state(material);
    if (!state) return null;
    const assetDefaults = this.catalog[material.materialAssetGuid]!.parameters;
    return Object.fromEntries([...state.values]
      .filter(([name, value]) => state.authoredNames?.has(name) || !equal(value, assetDefaults[name]))
      .map(([name, value]) => [name, copy(value)]));
  }

  resetValue(
    material: MaterialInstanceObject,
    name: string,
    kind: MaterialParameterValue["kind"],
  ): MaterialParameterValue | null {
    const value = this.state(material)?.defaults.get(name);
    return value?.kind === kind && this.valid(value) ? copy(value) : null;
  }

  hasPostProcessDefinition(material: PostProcessMaterialObject): boolean {
    return (
      Object.hasOwn(this.catalog, material.materialAssetGuid) &&
      this.catalog[material.materialAssetGuid]!.domain === "postProcess"
    );
  }

  private valid(value: MaterialParameterValue): boolean {
    if (!value || typeof value !== "object") return false;
    if (value.kind === "texture")
      return (
        value.textureAssetGuid === null ||
        this.textures.has(value.textureAssetGuid)
      );
    return value.kind === "float"
      ? typeof value.value === "number" && Number.isFinite(value.value)
      : value.kind === "color" && Array.isArray(value.value) && value.value.length === 4 && value.value.every(Number.isFinite);
  }

  private state(material: MaterialInstanceObject): State | undefined {
    if (
      material.destroyed ||
      (material instanceof PostProcessMaterialObject
        ? !material.isCurrent()
        : material.component.getVariable("materialObject") !== material)
    )
      return undefined;
    if (!Object.hasOwn(this.catalog, material.materialAssetGuid))
      return undefined;
    const definition = this.catalog[material.materialAssetGuid]!;
    if (
      definition.domain !==
      (material instanceof MaterialObject ? "surface" : "postProcess")
    )
      return undefined;
    const previous = this.states.get(material);
    if (previous) return previous;
    const authored =
      material instanceof PostProcessMaterialObject
        ? normalizeMaterialParameterOverrides(material.entry.parameters)
        : material.component.materialInstance?.materialGuid === material.materialAssetGuid
          ? normalizeMaterialParameterOverrides(material.component.materialInstance.parameters)
          : {};
    const defaults = new Map<string, MaterialParameterValue>();
    let authoredNames: Set<string> | undefined;
    for (const [name, fallback] of Object.entries(definition.parameters)) {
      const override = Object.hasOwn(authored, name)
        ? authored[name]
        : undefined;
      const value =
        override?.kind === fallback.kind && this.valid(override)
          ? override
          : fallback;
      if (override?.kind === fallback.kind && this.valid(override)) (authoredNames ??= new Set()).add(name);
      // An unavailable default must not remove the declared parameter: a later
      // valid texture assignment can recover it, while reset remains rejected.
      defaults.set(name, copy(value));
    }
    const state = {
      revision: 0,
      authoredNames,
      defaults,
      values: new Map(
        [...defaults]
          .filter(([, value]) => this.valid(value))
          .map(([name, value]) => [name, copy(value)]),
      ),
    };
    this.states.set(material, state);
    return state;
  }
}
