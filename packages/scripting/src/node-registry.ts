import type { TrustGateKind } from "@haptic/core";
import type { PinType } from "./types";
import type { GraphNode, GraphPin, LogicGraph } from "./ir";
import { registerDevelopmentOnlyByDefaultTypeId } from "./development-only";
import type { StructuredFlowMeta } from "./structured-flow";

/** 1-based line in a hoist chunk mapped to an ExecuteJavaScript body line. */
export type HoistBodyAnchor = {
  relativeLine: number;
  bodyLine: number;
};

export type CodegenContext = {
  graph: LogicGraph;
  node: GraphNode;
  /** Resolved expression text for an input data pin (or default). */
  input(pinName: string): string;
  /** Resolve a writable variable input without evaluating its current value. */
  reference?(pinName: string): string;
  /** Run this node's outgoing execution chain only when this expression is true. */
  continueIf?(expression: string): void;
  /** Choose exactly one outgoing execution pin after this node completes. */
  branch?(expression: string, truePin: string, falsePin: string): void;
  /**
   * A latent node whose outputs run at different times: run output pin `pinId`'s execution chain here, between the
   * node's own statements, when `expression` is true. Once a node runs an output this way, nothing runs after it.
   */
  runOutputIf?(expression: string, pinId: string): void;
  /**
   * Static type of the source pin wired into an input data pin (resolved in
   * compileGraph; declared in transition-rule graphs). Undefined when the
   * input is disconnected or its source is stripped from this build.
   */
  inputType?(pinName: string): PinType | undefined;
  /**
   * True when any edge targets the input pin with this id, whatever its
   * source (a stripped or dangling source still counts as wired).
   */
  isWired(pinId: string): boolean;
  /** Temp var name for an output data pin. */
  output(pinName: string): string;
  /** Emit a statement with an optional anchor override. */
  emit(statement: string, anchorNodeId?: string): void;
  /**
   * Hoist a module-scope function (ExecuteJavaScript).
   * `bodyAnchors` are 1-based lines within this chunk that map to the user body.
   */
  hoist(
    source: string,
    bodyAnchors?: readonly HoistBodyAnchor[],
  ): void;
  /**
   * Mark the entry point latent: it compiles to a generator, and a statement waits with
   * `(yield <thenable>)`, never `await`. Latent definitions are marked automatically.
   */
  requestAsync(): void;
  /**
   * True when Call Function should `await` the target (Delay or other latent
   * work inside that Function).
   */
  isLatentFunction?(classId: string, functionName: string): boolean;
  /**
   * Pure codegen: an expression reading `expression` evaluated at most once
   * per executing statement, so several outputs can share one evaluation.
   * Returns `expression` unchanged when the node has fewer than two wired
   * outputs. Missing where the host compiles without statements (callers fall
   * back to `expression`).
   */
  shared?(expression: string): string;
  indent: string;
};

export type NodeDefinition = {
  id: string;
  title: string;
  category: string;
  /** Author-facing contract shown in the node catalog. */
  description?: string;
  /** Add Node search metadata; never part of an authored graph. */
  searchAliases?: readonly string[];
  pins: (properties: Record<string, unknown>) => GraphPin[];
  /** Pure expression nodes return a map of output pin name → expression. */
  codegen: (ctx: CodegenContext) => void | Record<string, string>;
  pure?: boolean;
  /**
   * Purity set by the node's properties: a Call of a Pure function. The node
   * is pure when `pure` is set or this returns true (`isPureNode`).
   */
  pureWhen?: (properties: Record<string, unknown>) => boolean;
  /** No observable reads/effects beyond inputs. Allows caching immutable outputs
   * only when every dependency is also referentially transparent. */
  referentiallyTransparent?: boolean;
  latent?: boolean;
  /**
   * Render pins in their declared order instead of lifting exec pins to the
   * top. Function Input, Output, and Call nodes follow the signature order
   * the author arranged in the Inspector.
   */
  declaredPinOrder?: boolean;
  /** Hidden from runtime graph palettes unless the host is an editor graph. */
  editorOnly?: boolean;
  /** A compile root for tools and tests: no Add Node list offers it and it has no reference page. */
  internal?: boolean;
  /**
   * Class ids whose graphs (and their subclasses') offer this node in Add Node;
   * absent or empty means every Class that allows it otherwise.
   */
  hosts?: readonly string[];
  /**
   * When the Inspector flag is omitted, export compiles strip this node.
   * Print, Print String, and Draw Debug opt in so shipping games stay clean
   * unless the author unchecks Development Only.
   */
  developmentOnlyByDefault?: boolean;
  /**
   * Workspace Trust: in a project this computer does not trust, Play, Simulate, Preview Build and
   * packaging refuse a script whose compiled code holds this node. The compiler records every such
   * node it emits (`CompileResult.trustGatedNodes`); a node opts in with this one field.
   */
  trustGate?: TrustGateKind;
  /** Narrows `trustGate` by the node's properties: the node is gated only when this holds. */
  trustGateWhen?: (properties: Record<string, unknown>) => boolean;
  /**
   * Structured control-flow discriminator. Preferred over scattered typeId
   * checks for Switch On Int / String, loops / Break, and stateful flow.
   */
  structuredFlow?: StructuredFlowMeta;
};

/** Whether `node` compiles as a pure expression: its definition is `pure`, or `pureWhen` holds for its properties. */
export function isPureNode(
  def: Pick<NodeDefinition, "pure" | "pureWhen"> | undefined,
  node: { properties: Record<string, unknown> },
): boolean {
  return def?.pure === true || def?.pureWhen?.(node.properties) === true;
}

/** The trust kind `node` needs, or undefined when its definition is not gated or `trustGateWhen` excludes it. */
export function trustGateOf(
  def: Pick<NodeDefinition, "trustGate" | "trustGateWhen"> | undefined,
  node: { properties: Record<string, unknown> },
): TrustGateKind | undefined {
  if (!def?.trustGate) return undefined;
  return def.trustGateWhen && !def.trustGateWhen(node.properties) ? undefined : def.trustGate;
}

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition): void {
    if (this.defs.has(def.id)) {
      throw new Error(`Node already registered: ${def.id}`);
    }
    this.defs.set(def.id, def);
    if (def.developmentOnlyByDefault) {
      registerDevelopmentOnlyByDefaultTypeId(def.id);
    }
  }

  registerAll(defs: readonly NodeDefinition[]): void {
    for (const def of defs) this.register(def);
  }

  /** Removes a definition; graphs holding the node keep it and report it as missing. */
  unregister(id: string): boolean {
    return this.defs.delete(id);
  }

  get(id: string): NodeDefinition | undefined {
    return this.defs.get(id);
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }
}

export function pin(
  id: string,
  name: string,
  direction: "in" | "out",
  type: PinType,
  kind: "exec" | "data" = type.kind === "exec" ? "exec" : "data",
  optional = false,
  defaultValue?: unknown,
): GraphPin {
  return {
    id,
    name,
    direction,
    type,
    kind,
    optional,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}
