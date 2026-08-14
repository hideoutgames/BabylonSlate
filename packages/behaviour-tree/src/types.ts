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

export interface BehaviourTreeDocument {
  name: string;
  rootId: string;
  nodes: BtNode[];
  blackboardGuid: string | null;
}

export interface BlackboardKey {
  name: string;
  type: PinType;
  defaultValue?: unknown;
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

export type EvaluateBehaviourTreeOptions = {
  host?: BtTaskHost;
  serviceHost?: BtServiceHost;
  blackboard?: BlackboardValues;
  seed?: number;
};
