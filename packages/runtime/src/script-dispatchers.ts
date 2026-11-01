import { EVENT_DELEGATE_BRAND } from "@haptic/core";
import { EngineObject } from "@haptic/object-model";

/**
 * A delegate value: runs the custom event or function export `name` on
 * `object`. `params` are the target's parameter names, in signature order: an
 * Event Dispatcher passes its values by position and the delegate keys them by
 * these names, so a dispatcher input called Damage can reach a parameter
 * called Amount.
 */
export class EventDelegate {
  readonly [EVENT_DELEGATE_BRAND] = true;
  readonly object: EngineObject;
  readonly name: string;
  readonly kind: "event" | "function";
  readonly params: readonly string[];

  constructor(object: EngineObject, name: string, kind: "event" | "function", params: readonly string[]) {
    this.object = object;
    this.name = name;
    this.kind = kind;
    this.params = params;
    Object.freeze(this);
  }

  /** Named arguments for one dispatcher Call. */
  argumentsFor(values: readonly unknown[]): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.params.forEach((param, index) => {
      args[param] = values[index];
    });
    return args;
  }
}

export function isEventDelegate(value: unknown): value is EventDelegate {
  return value instanceof EventDelegate;
}

/**
 * How deep a dispatcher's Call may nest inside its own listeners. Deeper Calls
 * are skipped with an error, so two listeners re-calling each other cannot
 * overflow the worker's stack.
 */
export const DISPATCHER_MAX_DEPTH = 64;

type Binding = { readonly delegate: EventDelegate; removed: boolean };
type DispatcherList = { bindings: Binding[]; depth: number };

function sameTarget(a: EventDelegate, b: EventDelegate): boolean {
  return a.object === b.object && a.name === b.name && a.kind === b.kind;
}

/**
 * Event Dispatcher bindings of one script session. Bindings are runtime state
 * only: never saved, held weakly by the dispatcher's owner, and dropped with
 * the host when Play stops.
 */
export class DispatcherBindings {
  private readonly lists = new WeakMap<EngineObject, Map<string, DispatcherList>>();
  /** One delegate per object and member, so Unbind finds the one Bind added. */
  private readonly delegates = new WeakMap<EngineObject, Map<string, EventDelegate>>();

  /** The delegate for `name` on `object`, or null when there is no object. */
  delegate(
    object: unknown,
    name: string,
    kind: "event" | "function",
    params: readonly string[],
  ): EventDelegate | null {
    if (!(object instanceof EngineObject) || typeof name !== "string" || !name) return null;
    let byMember = this.delegates.get(object);
    if (!byMember) {
      byMember = new Map();
      this.delegates.set(object, byMember);
    }
    const key = `${kind}:${name}`;
    const cached = byMember.get(key);
    if (cached) return cached;
    const created = new EventDelegate(object, name, kind, Array.isArray(params) ? [...params] : []);
    byMember.set(key, created);
    return created;
  }

  /** Adds `delegate` to `owner`'s dispatcher `name`; binding the same target twice keeps one binding. */
  bind(owner: unknown, name: string, delegate: unknown): void {
    if (!(owner instanceof EngineObject) || owner.destroyed || !isEventDelegate(delegate)) return;
    if (delegate.object.destroyed) return;
    const list = this.listFor(owner, name, true)!;
    if (list.bindings.some((binding) => !binding.removed && sameTarget(binding.delegate, delegate))) return;
    list.bindings.push({ delegate, removed: false });
  }

  unbind(owner: unknown, name: string, delegate: unknown): void {
    if (!(owner instanceof EngineObject) || !isEventDelegate(delegate)) return;
    const list = this.listFor(owner, name, false);
    if (!list) return;
    for (const binding of list.bindings) {
      if (!binding.removed && sameTarget(binding.delegate, delegate)) binding.removed = true;
    }
    list.bindings = list.bindings.filter((binding) => !binding.removed);
  }

  unbindAll(owner: unknown, name: string): void {
    if (!(owner instanceof EngineObject)) return;
    const list = this.listFor(owner, name, false);
    if (!list) return;
    for (const binding of list.bindings) binding.removed = true;
    list.bindings = [];
  }

  /** Live bindings of `owner`'s dispatcher `name`, in bind order. */
  bound(owner: EngineObject, name: string): EventDelegate[] {
    return (this.listFor(owner, name, false)?.bindings ?? [])
      .filter((binding) => !binding.removed && !binding.delegate.object.destroyed)
      .map((binding) => binding.delegate);
  }

  /**
   * Runs every binding of `owner`'s dispatcher `name` in bind order. The Call
   * iterates a snapshot: a binding added meanwhile runs on the next Call, one
   * removed meanwhile is skipped. A destroyed listener is skipped and removed.
   */
  call(
    owner: unknown,
    name: string,
    values: readonly unknown[],
    invoke: (delegate: EventDelegate, args: Record<string, unknown>) => void,
    tooDeep: () => void,
  ): void {
    if (!(owner instanceof EngineObject)) return;
    const list = this.listFor(owner, name, false);
    if (!list || list.bindings.length === 0) return;
    if (list.depth >= DISPATCHER_MAX_DEPTH) {
      tooDeep();
      return;
    }
    const snapshot = list.bindings.slice();
    list.depth += 1;
    try {
      for (const binding of snapshot) {
        if (binding.removed) continue;
        if (binding.delegate.object.destroyed) {
          binding.removed = true;
          list.bindings = list.bindings.filter((entry) => entry !== binding);
          continue;
        }
        invoke(binding.delegate, binding.delegate.argumentsFor(values));
      }
    } finally {
      list.depth -= 1;
    }
  }

  /** Drops every dispatcher binding `owner` holds (its own dispatchers, once it is destroyed). */
  forget(owner: EngineObject): void {
    const lists = this.lists.get(owner);
    if (!lists) return;
    for (const list of lists.values()) {
      for (const binding of list.bindings) binding.removed = true;
    }
    this.lists.delete(owner);
  }

  private listFor(owner: EngineObject, name: string, create: boolean): DispatcherList | undefined {
    let lists = this.lists.get(owner);
    if (!lists) {
      if (!create) return undefined;
      lists = new Map();
      this.lists.set(owner, lists);
    }
    let list = lists.get(name);
    if (!list && create) {
      list = { bindings: [], depth: 0 };
      lists.set(name, list);
    }
    return list;
  }
}
