import type { PinType } from "@babylonslate/scripting";

export type BtNodeKind = "selector" | "sequence" | "parallel" | "task";
export type BtAbortMode = "none" | "self" | "lowerPriority" | "both";
export type BtResult = "success" | "failure" | "running";

export interface BtDecorator {
  id: string;
  classId: string;
  abortMode: BtAbortMode;
  observedKeys: string[];
  properties: Record<string, unknown>;
}

export interface BtService {
  id: string;
  classId: string;
  intervalMs: number;
  randomDeviationMs: number;
  properties: Record<string, unknown>;
}

export interface BtNode {
  id: string;
  kind: BtNodeKind;
  classId: string;
  children: string[];
  decorators: BtDecorator[];
  services: BtService[];
  properties: Record<string, unknown>;
}

export type BtEditorPosition = { x: number; y: number };

export interface BehaviourTreeDocument {
  name: string;
  rootId: string;
  nodes: BtNode[];
  blackboardGuid: string | null;
  /** Editor-only canvas coordinates. Runtime ignores this field. */
  editorPositions?: Record<string, BtEditorPosition>;
}

export interface BlackboardKey {
  name: string;
  type: PinType;
  defaultValue?: unknown;
  /** Number and vector keys: display unit (`VALUE_UNITS`). Missing is none. */
  unit?: string;
}

export interface BlackboardDocument {
  name: string;
  keys: BlackboardKey[];
}

export type BlackboardValues = Record<string, unknown>;

export interface BtStackFrame {
  nodeId: string;
  childIndex: number;
  opened: boolean;
}

export interface BtEvalState {
  stack: BtStackFrame[];
  status: BtResult;
  lastResults: Record<string, BtResult>;
  btNodeId: string | null;
  blackboard: BlackboardValues;
  nodeMemory: Record<string, Record<string, unknown>>;
}

export type BtTaskHost = {
  tick(
    node: BtNode,
    blackboard: BlackboardValues,
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): BtResult;
  abort?(
    node: BtNode,
    blackboard: BlackboardValues,
    memory: Record<string, unknown>,
  ): void;
};

export type BtServiceHost = {
  tick(
    service: BtService,
    node: BtNode,
    blackboard: BlackboardValues,
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): void;
};

export type BtDecoratorHost = {
  evaluate(
    decorator: BtDecorator,
    node: BtNode,
    blackboard: BlackboardValues,
  ): boolean;
};

/**
 * What one evaluation touched, for an editor that debugs the tree. The evaluator calls it only
 * when a host passes one, so an unobserved tree pays an optional-call check per visit.
 */
export type BtEvalTrace = {
  /** The evaluation worked on this node: it entered or resumed it, ticked its task, or moved on from a child. */
  visit(nodeId: string): void;
  /** The evaluation went down from `parentId` into `childId`, a new execution or a resumed running one. */
  link(parentId: string, childId: string): void;
};

export type EvaluateBehaviourTreeOptions = {
  trace?: BtEvalTrace;
  host?: BtTaskHost;
  serviceHost?: BtServiceHost;
  decoratorHost?: BtDecoratorHost;
  blackboard?: BlackboardValues;
  seed?: number;
};
