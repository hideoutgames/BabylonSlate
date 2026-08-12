import type { LogicGraph } from "./ir";
import type { Diagnostic } from "./diagnostics";
import type { ClassHierarchy, PinType } from "./types";

export type TypeContext = {
  assetGuid: string;
  hierarchy?: ClassHierarchy;
  /** Optional known enum/struct/interface guids. */
  knownGuids?: ReadonlySet<string>;
  /** Optional known class ids. */
  knownClassIds?: ReadonlySet<string>;
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
};
