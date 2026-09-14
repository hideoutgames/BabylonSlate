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
  defaults: ReadonlyMap<string, MaterialParameterValue>;
  values: Map<string, MaterialParameterValue>;
};
const copy = (value: MaterialParameterValue): MaterialParameterValue =>
  value.kind === "color"
    ? { kind: "color", value: [...value.value] }
    : { ...value };

/** Session-owned values for synchronous worker reads; assets and entry overrides remain immutable. */
export class RuntimeMaterialParameters {
  private readonly catalog: MaterialParameterCatalog;
  private readonly textures: ReadonlySet<string>;
  private readonly states = new WeakMap<MaterialInstanceObject, State>();
  constructor(
    catalog: MaterialParameterCatalog | undefined,
    textures: readonly string[] | undefined,
  ) {
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
    return !!expected && expected.kind === value.kind && this.valid(value);
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
    this.state(material)!.values.set(name, copy(value));
    return true;
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
    if (value.kind === "texture")
      return (
        value.textureAssetGuid === null ||
        this.textures.has(value.textureAssetGuid)
      );
    return value.kind === "float"
      ? Number.isFinite(value.value)
      : value.value.length === 4 && value.value.every(Number.isFinite);
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
        : {};
    const defaults = new Map<string, MaterialParameterValue>();
    for (const [name, fallback] of Object.entries(definition.parameters)) {
      const override = Object.hasOwn(authored, name)
        ? authored[name]
        : undefined;
      const value =
        override?.kind === fallback.kind && this.valid(override)
          ? override
          : fallback;
      // An unavailable default must not remove the declared parameter: a later
      // valid texture assignment can recover it, while reset remains rejected.
      defaults.set(name, copy(value));
    }
    const state = {
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
