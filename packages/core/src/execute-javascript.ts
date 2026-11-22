/** Catalog id of the Execute JavaScript node, whose authored `body` compiles into the game unsandboxed. */
export const EXECUTE_JAVASCRIPT_NODE_TYPE = "debug.executeJavaScript";

/**
 * The code an Execute JavaScript node compiles from its `body` property. Codegen and every scan read it
 * through this one function, so a stored value that is not a string (an array, a number) is judged as
 * the text it would compile to.
 */
export function executeJavaScriptBodyText(body: unknown): string {
  return body === undefined || body === null ? "" : String(body);
}

/** Whether a body holds code: any text that is not only whitespace, comments included. */
export function hasExecuteJavaScriptBody(body: unknown): boolean {
  return executeJavaScriptBodyText(body).trim() !== "";
}

/** One Execute JavaScript node with a body. */
export interface ExecuteJavaScriptNode {
  nodeId: string;
  /** The Class function the node is in, when it is in one; otherwise the document's own graph. */
  functionName?: string;
  body: string;
}

/** The assets of a set that hold Execute JavaScript with a body, with their nodes. */
export interface ExecuteJavaScriptAsset {
  guid: string;
  name: string;
  type: string;
  /** Where the asset is or will be stored, when known. */
  path?: string;
  nodes: ExecuteJavaScriptNode[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The body of `value` when it is an Execute JavaScript node in either stored shape: a saved node
 * (`{ id, type, data }`, whose `data.__nodeType` wins over `type` when hydrated) or a compiled graph
 * node (`{ id, typeId, properties }`). Null for anything else.
 */
function executeJavaScriptBodyOf(value: Record<string, unknown>): string | null {
  const data = record(value.data);
  const properties = record(value.properties);
  const types = [value.type, value.typeId, data?.__nodeType, properties?.__nodeType];
  if (!types.includes(EXECUTE_JAVASCRIPT_NODE_TYPE)) return null;
  for (const body of [data?.body, properties?.body]) {
    if (hasExecuteJavaScriptBody(body)) return executeJavaScriptBodyText(body);
  }
  return "";
}

/**
 * Every Execute JavaScript node with a body anywhere in a decoded document. The walk does not depend
 * on the asset type: Class event and function graphs, a Scene's or Scene Layer's embedded script, an
 * Animation Graph's Animation Object, rule and pose graphs, and any graph a future type nests are all
 * plain JSON objects in the document, so each is reached. Iterative, so a deeply nested document
 * cannot overflow the stack.
 */
export function findExecuteJavaScriptNodes(document: unknown): ExecuteJavaScriptNode[] {
  const found: ExecuteJavaScriptNode[] = [];
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; functionName?: string }> = [{ value: document }];
  while (stack.length > 0) {
    const { value, functionName } = stack.pop()!;
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push({ value: value[index], functionName });
      continue;
    }
    const object = value as Record<string, unknown>;
    const body = executeJavaScriptBodyOf(object);
    if (body) {
      found.push({ nodeId: typeof object.id === "string" ? object.id : "", ...(functionName ? { functionName } : {}), body });
    }
    const functionGraphs = record(object.functionGraphs);
    const members = Array.isArray(object.members) ? object.members : [];
    for (const child of Object.values(object).reverse()) {
      if (child === functionGraphs && functionGraphs) {
        for (const [memberId, graph] of Object.entries(functionGraphs).reverse()) {
          const member = members.map(record).find((entry) => entry?.id === memberId);
          stack.push({ value: graph, functionName: typeof member?.name === "string" && member.name ? member.name : memberId });
        }
        continue;
      }
      stack.push({ value: child, functionName });
    }
  }
  return found;
}
