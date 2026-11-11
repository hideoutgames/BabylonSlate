import {
  normalizeGlobalParameterCatalog,
  resizeGlobalParameterValue,
  type GlobalParameterCatalog,
  type GlobalParameterType,
} from "@haptic/core";

/**
 * What Materials and Particle Graphs read for Global Parameter nodes. `revision` changes with
 * every value a reader could see, so a reader refreshes only after a change.
 */
export interface GlobalParameterValueSource {
  readonly revision: number;
  /** The parameter's current value, or null when the collection or parameter is unknown. */
  value(collectionGuid: string, parameterId: string): readonly number[] | null;
  /** Called after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const valueKey = (collectionGuid: string, parameterId: string) => `${collectionGuid}\n${parameterId}`;

class Listeners {
  private readonly listeners = new Set<() => void>();
  add(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Every collection's defaults: the editor keeps it current as collections are edited. */
class GlobalParameterDefaults implements GlobalParameterValueSource {
  revision = 0;
  catalog: Readonly<GlobalParameterCatalog> = {};
  private identity = "{}";
  private defaults = new Map<string, readonly number[]>();
  private readonly listeners = new Listeners();

  replace(catalog: unknown): void {
    const normalized = normalizeGlobalParameterCatalog(catalog);
    const identity = JSON.stringify(normalized);
    if (identity === this.identity) return;
    const next = new Map<string, readonly number[]>();
    for (const [guid, parameters] of Object.entries(normalized)) {
      for (const parameter of parameters) next.set(valueKey(guid, parameter.id), parameter.defaultValue);
    }
    this.catalog = normalized;
    this.identity = identity;
    this.defaults = next;
    this.revision += 1;
    this.listeners.notify();
  }

  value(collectionGuid: string, parameterId: string): readonly number[] | null {
    return this.defaults.get(valueKey(collectionGuid, parameterId)) ?? null;
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }
}

const defaults = new GlobalParameterDefaults();

/** The defaults every editor preview, editor viewport and Play session starts from. */
export const globalParameterDefaults: GlobalParameterValueSource = defaults;

/**
 * Replace the defaults with `catalog`'s (`GlobalParameterCatalog`): the editor on every
 * collection edit, the player at boot. Readers update on their next frame.
 */
export function setGlobalParameterCatalog(catalog: Readonly<GlobalParameterCatalog> | unknown): void {
  defaults.replace(catalog);
}

/** The catalog `setGlobalParameterCatalog` last set; `globalParameterDefaults.subscribe` reports changes. */
export function currentGlobalParameterCatalog(): Readonly<GlobalParameterCatalog> {
  return defaults.catalog;
}

/**
 * One Play session's values: what its Class graphs set (`setGlobalParameter`), else the
 * defaults. Values are never saved and end with the session.
 */
export class GlobalParameterSession implements GlobalParameterValueSource {
  private ownRevision = 0;
  private readonly values = new Map<string, number[]>();
  private readonly listeners = new Listeners();
  private readonly base: GlobalParameterValueSource;
  private readonly unsubscribe: () => void;

  constructor(base: GlobalParameterValueSource = globalParameterDefaults) {
    this.base = base;
    this.unsubscribe = base.subscribe(() => this.listeners.notify());
  }

  get revision(): number {
    return this.ownRevision + this.base.revision;
  }

  /**
   * A value the runtime set, already sized to its parameter's type (a non-finite component
   * reads 0); null drops it, so the default applies again.
   */
  set(collectionGuid: string, parameterId: string, value: readonly number[] | null): void {
    const key = valueKey(collectionGuid, parameterId);
    if (value) this.values.set(key, value.map((component) => (Number.isFinite(component) ? component : 0)));
    else if (!this.values.delete(key)) return;
    this.ownRevision += 1;
    this.listeners.notify();
  }

  value(collectionGuid: string, parameterId: string): readonly number[] | null {
    return this.values.get(valueKey(collectionGuid, parameterId)) ?? this.base.value(collectionGuid, parameterId);
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/**
 * The value a Global Parameter node of `valueType` draws: the source's, fitted to the type
 * (an unknown parameter reads 0, or opaque black for a Color).
 */
export function globalParameterComponents(
  source: GlobalParameterValueSource,
  collectionGuid: string,
  parameterId: string,
  valueType: GlobalParameterType,
): number[] {
  const value = source.value(collectionGuid, parameterId);
  return resizeGlobalParameterValue(value ? [...value] : valueType === "color" ? [0, 0, 0, 1] : [0], valueType);
}
