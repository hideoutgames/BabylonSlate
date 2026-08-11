import type { Guid } from "@babylonslate/core";

export type PinDefault = unknown;

export interface InterfaceMethodDef {
  name: string;
  /** Output pin defaults returned when the target has no handler. */
  outputs: Record<string, PinDefault>;
}

export interface ScriptInterfaceDef {
  guid: Guid;
  name: string;
  methods: InterfaceMethodDef[];
}

export type InterfaceHandler = (
  args: Record<string, unknown>,
) => Record<string, unknown>;

export interface InterfaceDispatchTarget {
  guid: Guid;
  classId: string;
  /** Interface guids this instance's class declares. */
  implementedInterfaces: readonly string[];
  /** Optional per-instance handlers keyed by `interfaceGuid:methodName`. */
  interfaceHandlers?: ReadonlyMap<string, InterfaceHandler>;
}

export class InterfaceRegistry {
  private readonly interfaces = new Map<string, ScriptInterfaceDef>();

  register(def: ScriptInterfaceDef): void {
    this.interfaces.set(def.guid, {
      ...def,
      methods: def.methods.map((m) => ({
        ...m,
        outputs: { ...m.outputs },
      })),
    });
  }

  get(guid: string): ScriptInterfaceDef | undefined {
    return this.interfaces.get(guid);
  }
}

function handlerKey(interfaceGuid: string, method: string): string {
  return `${interfaceGuid}:${method}`;
}

/**
 * Dispatch an interface call. Missing implementations return pin defaults
 * (no-op) so interface functions are callable on every Object/Actor.
 */
export function dispatchInterface(
  registry: InterfaceRegistry,
  target: InterfaceDispatchTarget,
  interfaceGuid: string,
  method: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const def = registry.get(interfaceGuid);
  const methodDef = def?.methods.find((m) => m.name === method);
  const defaults = methodDef ? { ...methodDef.outputs } : {};

  if (!target.implementedInterfaces.includes(interfaceGuid)) {
    return defaults;
  }

  const handler = target.interfaceHandlers?.get(
    handlerKey(interfaceGuid, method),
  );
  if (!handler) {
    return defaults;
  }
  return { ...defaults, ...handler(args) };
}

export { handlerKey as interfaceHandlerKey };
