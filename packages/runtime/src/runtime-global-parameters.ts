import type { CommandMessage } from "@haptic/bridge";
import {
  normalizeGlobalParameterCatalog,
  resizeGlobalParameterValue,
  type GlobalParameter,
  type GlobalParameterCatalog,
  type GlobalParameterType,
} from "@haptic/core";

/** The renderer command a value change sends (`setGlobalParameter`). */
export type GlobalParameterCommand = Extract<CommandMessage, { type: "setGlobalParameter" }>;

const valueKey = (collectionGuid: string, parameterId: string) => `${collectionGuid}\n${parameterId}`;

/**
 * The session's Global Parameter Collection values. They start at each collection's defaults
 * when Play starts, keep across Scene changes (a new catalog keeps every value whose parameter
 * still exists with the same type) and are never saved. Class graphs set and read them by
 * collection guid and parameter name; Materials and Particle Graphs read them by id.
 */
export class RuntimeGlobalParameters {
  private catalog: GlobalParameterCatalog = {};
  private readonly values = new Map<string, number[]>();
  private readonly warned = new Set<string>();

  private readonly warn: (message: string) => void;
  private readonly emit: (command: GlobalParameterCommand) => void;

  /** `emit` tells the renderer about every value change, so Materials and Particle Graphs follow. */
  constructor(warn: (message: string) => void = () => undefined, emit: (command: GlobalParameterCommand) => void = () => undefined) {
    this.warn = warn;
    this.emit = emit;
  }

  /** The session's collections (`load`). */
  replaceCatalog(catalog: unknown): void {
    this.catalog = normalizeGlobalParameterCatalog(catalog);
    this.dropStaleValues();
  }

  /**
   * Collections a streamed Scene's content brings (`loadSceneContent`): each replaces its own
   * entry; collections it does not list stay, so a Scene change never loses a value.
   */
  mergeCatalog(catalog: unknown): void {
    this.catalog = { ...this.catalog, ...normalizeGlobalParameterCatalog(catalog) };
    this.dropStaleValues();
  }

  /** Drop values whose parameter is gone or changed width. */
  private dropStaleValues(): void {
    for (const key of [...this.values.keys()]) {
      const [collectionGuid = "", parameterId = ""] = key.split("\n");
      const parameter = this.catalog[collectionGuid]?.find((entry) => entry.id === parameterId);
      const value = this.values.get(key)!;
      if (parameter && resizeGlobalParameterValue(value, parameter.type).length === value.length) continue;
      this.values.delete(key);
      this.emit({ type: "setGlobalParameter", collectionGuid, parameterId, value: null });
    }
  }

  /**
   * The parameter `name` of `collection` when its type is one of `types`. An unknown collection,
   * name or type warns once per collection and name.
   */
  resolve(collection: unknown, name: unknown, types: readonly GlobalParameterType[]): { guid: string; parameter: GlobalParameter } | null {
    const guid = typeof collection === "string" ? collection.trim() : "";
    const trimmed = typeof name === "string" ? name.trim() : "";
    const parameter = this.catalog[guid]?.find((entry) => entry.name === trimmed);
    if (parameter && types.includes(parameter.type)) return { guid, parameter };
    const key = valueKey(guid, trimmed);
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.warn(!guid
        ? `Global parameter "${trimmed}" has no Global Parameter Collection; it is ignored.`
        : !this.catalog[guid]
          ? `Global Parameter Collection ${guid} is not part of this game; "${trimmed}" is ignored.`
          : parameter
            ? `Global parameter "${trimmed}" is a ${parameter.type} parameter; this node cannot set or read it.`
            : `Global parameter "${trimmed}" is not in its collection; it is ignored.`);
    }
    return null;
  }

  /** Set `name` of `collection`, sized to its type; false when it cannot be resolved. */
  set(collection: unknown, name: unknown, value: readonly unknown[], types: readonly GlobalParameterType[]): GlobalParameter | null {
    const resolved = this.resolve(collection, name, types);
    if (!resolved) return null;
    const fitted = resizeGlobalParameterValue(value, resolved.parameter.type);
    // A graph that sets the value it already has, as one driven from Event Tick does, sends nothing:
    // the renderer would otherwise re-evaluate every Material that reads the collection.
    const current = this.valueOf(resolved.guid, resolved.parameter);
    if (current.length === fitted.length && fitted.every((entry, index) => entry === current[index])) return resolved.parameter;
    this.values.set(valueKey(resolved.guid, resolved.parameter.id), fitted);
    this.emit({ type: "setGlobalParameter", collectionGuid: resolved.guid, parameterId: resolved.parameter.id, value: [...fitted] });
    return resolved.parameter;
  }

  /** The value set this session, else the default. */
  get(collection: unknown, name: unknown, types: readonly GlobalParameterType[]): { found: boolean; value: number[] } {
    const resolved = this.resolve(collection, name, types);
    if (!resolved) return { found: false, value: [] };
    return { found: true, value: [...this.valueOf(resolved.guid, resolved.parameter)] };
  }

  private valueOf(collectionGuid: string, parameter: GlobalParameter): readonly number[] {
    return this.values.get(valueKey(collectionGuid, parameter.id)) ?? parameter.defaultValue;
  }
}
