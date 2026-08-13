import { err, ok, type Result } from "@babylonslate/core";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_COMPONENT_CLASS_IDS,
} from "./ids";

export type VariableDef = {
  name: string;
  type: string;
  defaultValue?: unknown;
};

export type ClassKind =
  | "object"
  | "actor"
  | "component"
  | "gameInstance"
  | "other";

export interface ClassDef {
  id: string;
  parentClassId: string | null;
  kind: ClassKind;
  variables: VariableDef[];
  /** ScriptInterface guids this class declares. */
  implementedInterfaces: string[];
}

export interface ReparentResult {
  classId: string;
  previousParentId: string | null;
  newParentId: string;
  /** Inherited member names that are no longer valid under the new parent. */
  invalidatedMembers: string[];
}

export class ClassRegistry {
  private readonly classes = new Map<string, ClassDef>();

  constructor() {
    this.registerEngineDefaults();
  }

  private registerEngineDefaults(): void {
    this.register({
      id: "BObject",
      parentClassId: null,
      kind: "object",
      variables: [],
      implementedInterfaces: [],
    });
    this.register({
      id: "Actor",
      parentClassId: "BObject",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    this.register({
      id: "ActorComponent",
      parentClassId: "BObject",
      kind: "component",
      variables: [],
      implementedInterfaces: [],
    });
    this.register({
      id: "GameInstance",
      parentClassId: "BObject",
      kind: "gameInstance",
      variables: [],
      implementedInterfaces: [],
    });
    this.register({
      id: "FunctionLibrary",
      parentClassId: "BObject",
      kind: "other",
      variables: [],
      implementedInterfaces: [],
    });
    this.register({
      id: "BDebugCommand",
      parentClassId: "BObject",
      kind: "other",
      variables: [],
      implementedInterfaces: [],
    });
    for (const id of ENGINE_COMPONENT_CLASS_IDS) {
      this.register({
        id,
        parentClassId: "ActorComponent",
        kind: "component",
        variables: [],
        implementedInterfaces: [],
      });
    }
  }

  register(def: ClassDef): Result<void, string> {
    if (this.classes.has(def.id)) {
      return err(`class already registered: ${def.id}`);
    }
    if (def.parentClassId && !this.classes.has(def.parentClassId)) {
      return err(`unknown parent class: ${def.parentClassId}`);
    }
    this.classes.set(def.id, {
      ...def,
      variables: [...def.variables],
      implementedInterfaces: [...def.implementedInterfaces],
    });
    return ok(undefined);
  }

  get(classId: string): ClassDef | undefined {
    const def = this.classes.get(classId);
    if (!def) return undefined;
    return {
      ...def,
      variables: [...def.variables],
      implementedInterfaces: [...def.implementedInterfaces],
    };
  }

  has(classId: string): boolean {
    return this.classes.has(classId);
  }

  /** Ancestry from classId up to root (inclusive), root last. */
  ancestry(classId: string): string[] {
    const chain: string[] = [];
    let current: string | null | undefined = classId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      chain.push(current);
      const def = this.classes.get(current);
      current = def?.parentClassId ?? null;
    }
    return chain;
  }

  isA(classId: string, ancestorId: string): boolean {
    return this.ancestry(classId).includes(ancestorId);
  }

  /** All variable defs from ancestors then self (self overrides by name). */
  inheritedVariables(classId: string): VariableDef[] {
    const chain = this.ancestry(classId).reverse();
    const byName = new Map<string, VariableDef>();
    for (const id of chain) {
      const def = this.classes.get(id);
      if (!def) continue;
      for (const v of def.variables) {
        byName.set(v.name, { ...v });
      }
    }
    return [...byName.values()];
  }

  reparent(
    classId: string,
    newParentId: string,
  ): Result<ReparentResult, string> {
    const def = this.classes.get(classId);
    if (!def) return err(`unknown class: ${classId}`);
    if (ENGINE_BASE_CLASS_IDS.includes(classId as never)) {
      return err(`cannot reparent engine base class: ${classId}`);
    }
    if (!this.classes.has(newParentId)) {
      return err(`unknown parent class: ${newParentId}`);
    }
    if (classId === newParentId || this.isA(newParentId, classId)) {
      return err(`reparent would create a cycle: ${classId} -> ${newParentId}`);
    }

    const before = new Set(this.inheritedVariables(classId).map((v) => v.name));
    const previousParentId = def.parentClassId;
    def.parentClassId = newParentId;
    const after = new Set(this.inheritedVariables(classId).map((v) => v.name));
    const invalidatedMembers = [...before].filter((name) => !after.has(name));
    invalidatedMembers.sort();

    return ok({
      classId,
      previousParentId,
      newParentId,
      invalidatedMembers,
    });
  }

  listClassIds(): string[] {
    return [...this.classes.keys()].sort();
  }
}
