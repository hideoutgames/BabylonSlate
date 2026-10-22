import { describe, expect, it, vi } from "vitest";
import { ActorComponent } from "@haptic/object-model";
import { ParsedComponentProperties } from "./parsed-component-properties";

/** A component whose variables are a plain Map, so they carry no revision. */
class UnversionedComponent extends ActorComponent {
  protected override createVariables(entries: Array<[string, unknown]>): Map<string, unknown> {
    return new Map(entries);
  }
}

function setup(variables: Record<string, unknown> = { level: 1 }) {
  const parse = vi.fn((input: Record<string, unknown>) => ({ level: input.level }));
  return {
    parse,
    cache: new ParsedComponentProperties(parse),
    component: new ActorComponent({ classId: "Probe", variables }),
  };
}

describe("ParsedComponentProperties", () => {
  it("parses once until a variable changes, and rewriting a primitive with itself is no change", () => {
    const { cache, component, parse } = setup();
    const first = cache.get(component);
    expect(first).toEqual({ level: 1 });
    expect(cache.get(component)).toBe(first);
    component.setVariable("level", 1);
    expect(cache.get(component)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);

    component.setVariable("level", 2);
    expect(cache.get(component)).toEqual({ level: 2 });
    component.variables.delete("level");
    expect(cache.get(component)).toEqual({ level: undefined });
    component.variables.set("level", 3);
    expect(cache.get(component)).toEqual({ level: 3 });
  });

  it("keeps each component's own parse", () => {
    const { cache, component } = setup({ level: 1 });
    const other = new ActorComponent({ classId: "Probe", variables: { level: 9 } });
    expect(cache.get(component)).toEqual({ level: 1 });
    expect(cache.get(other)).toEqual({ level: 9 });
    component.setVariable("level", 2);
    expect(cache.get(other)).toEqual({ level: 9 });
  });

  it("stays current across writes the parser never reads, but not across a foreign write", () => {
    const { cache, component, parse } = setup();
    const first = cache.get(component);
    cache.writeUnparsed(component, () => component.setVariable("output", { x: 1 }));
    expect(cache.get(component)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);

    // A write made before them leaves the entry stale: the unparsed writes must not revive it.
    component.setVariable("level", 2);
    cache.writeUnparsed(component, () => component.setVariable("output", { x: 2 }));
    expect(cache.get(component)).toEqual({ level: 2 });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("parses every call for variables without a revision", () => {
    const { cache, parse } = setup();
    const component = new UnversionedComponent({ classId: "Probe", variables: { level: 1 } });
    expect(Number.isNaN(component.variablesRevision)).toBe(true);
    expect(cache.get(component)).toEqual({ level: 1 });
    component.variables.set("level", 2);
    expect(cache.get(component)).toEqual({ level: 2 });
    cache.writeUnparsed(component, () => component.variables.set("level", 3));
    expect(cache.get(component)).toEqual({ level: 3 });
    expect(parse).toHaveBeenCalledTimes(3);
  });
});
