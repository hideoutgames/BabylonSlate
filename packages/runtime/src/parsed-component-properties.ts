import type { ActorComponent } from "@haptic/object-model";

type Entry<T> = { revision: number; value: T };

/**
 * A component's parsed properties, re-parsed only after one of its variables was
 * written. `variablesRevision` advances on every write that can change what a
 * reader sees (a primitive rewritten with itself is none), so an unchanged
 * revision proves the parser's input is unchanged. Variables with no revision
 * (NaN) are parsed on every call.
 *
 * Parsers cached here must read their input through primitive checks only, so a
 * variable mutated in place cannot change their output without a write to it.
 * The cached value is shared by every caller and must be treated as read-only.
 */
export class ParsedComponentProperties<T> {
  private readonly entries = new WeakMap<ActorComponent, Entry<T>>();
  private readonly parse: (variables: Record<string, unknown>) => T;

  constructor(parse: (variables: Record<string, unknown>) => T) {
    this.parse = parse;
  }

  get(component: ActorComponent): T {
    const revision = component.variablesRevision;
    const entry = this.entries.get(component);
    if (entry !== undefined && entry.revision === revision) return entry.value;
    const value = this.parse(Object.fromEntries(component.variables));
    if (!Number.isNaN(revision)) this.entries.set(component, { revision, value });
    return value;
  }

  /**
   * Runs writes to variables the parser never reads. They advance the revision,
   * but an entry that was current beforehand stays current, so a component that
   * publishes its own outputs every tick does not reparse its settings. An entry
   * already stale before the writes stays stale.
   */
  writeUnparsed(component: ActorComponent, write: () => void): void {
    const entry = this.entries.get(component);
    const current = entry !== undefined && entry.revision === component.variablesRevision;
    write();
    if (current) entry.revision = component.variablesRevision;
  }
}
