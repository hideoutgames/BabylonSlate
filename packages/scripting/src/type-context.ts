import type { LogicGraph } from "./ir";
import type { Diagnostic } from "./diagnostics";
import type { ClassHierarchy, PinType } from "./types";

export type ClassMemberSymbol = {
  id: string;
  name: string;
  kind: "variable" | "function" | "event";
  classId: string;
  functionId?: string;
  typeId?: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  pins?: Array<{
    name: string;
    typeId: string;
    direction: "in" | "out";
    typeClassId?: string;
  }>;
  implementsInterface?: { assetGuid: string; methodName: string };
  overrides?: { classId: string; name: string };
};

export type InterfaceMethodContext = {
  guid: string;
  name: string;
  methods: Array<{
    name: string;
    pins: Array<{
      name: string;
      typeId: string;
      direction: "in" | "out";
      typeClassId?: string;
    }>;
  }>;
};

export type ParentFunctionSignature = {
  classId: string;
  name: string;
  pins: Array<{
    name: string;
    typeId: string;
    direction: "in" | "out";
    typeClassId?: string;
  }>;
};

/** True when a class should use actorRef rather than objectRef. */
export function isActorClassId(
  classId: string,
  hierarchy?: ClassHierarchy,
): boolean {
  if (classId === "Actor") return true;
  return hierarchy?.isSubclassOf(classId, "Actor") ?? false;
}

export function resultKindForClassId(
  classId: string,
  hierarchy?: ClassHierarchy,
): "actorRef" | "objectRef" {
  return isActorClassId(classId, hierarchy) ? "actorRef" : "objectRef";
}

export type TypeContext = {
  assetGuid: string;
  hierarchy?: ClassHierarchy;
  /** Optional known enum/struct/interface guids (project + engine). */
  knownGuids?: ReadonlySet<string>;
  /** Optional Enum schemas keyed by guid (`engine:…` or asset guid). */
  enums?: Readonly<Record<string, { name: string; members: Array<{ name: string; value: number }> }>>;
  /** Optional Structure schemas keyed by guid. */
  structs?: Readonly<
    Record<
      string,
      {
        name: string;
        fields: Array<{
          name: string;
          typeId: string;
          typeClassId?: string;
          defaultValue?: unknown;
        }>;
      }
    >
  >;
  /** Optional known class ids. */
  knownClassIds?: ReadonlySet<string>;
  /** Optional BehaviourTree document payload for `bt.structural` rules. */
  behaviourTree?: unknown;
  classId?: string;
  activeFunctionId?: string | null;
  members?: readonly ClassMemberSymbol[];
  implementedInterfaces?: readonly InterfaceMethodContext[];
  parentFunctionSignatures?: readonly ParentFunctionSignature[];
  /** True when the graph being validated is an interface method implementation. */
  interfaceImplementation?: boolean;
};

export type ValidationRule = {
  id: string;
  run(graphs: readonly LogicGraph[], ctx: TypeContext): Diagnostic[];
};

const rules: ValidationRule[] = [];

export function registerValidationRule(rule: ValidationRule): void {
  if (rules.some((r) => r.id === rule.id)) {
    throw new Error(`Validation rule already registered: ${rule.id}`);
  }
  rules.push(rule);
}

export function clearValidationRules(): void {
  rules.length = 0;
}

export function listValidationRules(): readonly ValidationRule[] {
  return rules;
}

export type NodeTypeLookup = {
  getPins?(
    typeId: string,
    properties: Record<string, unknown>,
  ): { id: string; type: PinType; direction: "in" | "out"; kind: "exec" | "data"; optional?: boolean }[] | undefined;
};

export type ValidateOptions = {
  extraRules?: readonly ValidationRule[];
  nodeLookup?: NodeTypeLookup;
  /** Optional registry so structured-flow rules can read node metadata. */
  registry?: import("./node-registry").NodeRegistry;
};
