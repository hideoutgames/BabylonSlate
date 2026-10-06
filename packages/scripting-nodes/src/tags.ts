import {
  BOOL, EXEC, INT, RESOLVING_WILDCARD, STRING, TAG, TAG_CONTAINER,
  arrayOf, pin, tagCasePinId, tagCasesOf, tagOptionPinId,
  type NodeDefinition, type PinType,
} from "@babylonslate/scripting";

export { tagCasePinId, tagCasesOf, tagOptionPinId } from "@babylonslate/scripting";

function caseName(properties: Record<string, unknown>, tag: number): string {
  const names = properties.caseNames as Record<string, unknown> | undefined;
  const name = names?.[String(tag)];
  return typeof name === "string" && name ? name : "Unresolved Tag";
}

function input(id: string, name: string, type: PinType, defaultValue?: unknown) {
  return pin(id, name, "in", type, "data", true, defaultValue);
}

const exactPin = (value = false) => input("exact", "Exact Match", BOOL, value);

function compare(id: string, title: string, operator: string): NodeDefinition {
  return {
    id, title, category: "tags", pure: true,
    searchAliases: [operator],
    pins: () => [input("a", "A", TAG), input("b", "B", TAG), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `(${ctx.input("a")} ${operator} ${ctx.input("b")})` }),
  };
}

function binaryContainer(id: string, title: string, operation: string, type = TAG_CONTAINER): NodeDefinition {
  return {
    id, title, category: "tags", pure: true,
    pins: () => [input("a", "A", TAG_CONTAINER), input("b", "B", TAG_CONTAINER), pin("out", "Result", "out", type)],
    codegen: (ctx) => ({ out: `__tags.${operation}(${ctx.input("a")}, ${ctx.input("b")})` }),
  };
}

function assign(id: string, title: string, type: PinType, normalize: string): NodeDefinition {
  return {
    id, title, category: "tags",
    description: "Connect a writable Get Variable to Target. Assigns Value and returns the assigned value.",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
      { ...pin("target", "Target", "in", type), reference: "required" },
      input("value", "Value", type), pin("out", "Value", "out", type),
    ],
    codegen: (ctx) => {
      if (!ctx.reference) throw new Error("Tag assignment requires writable variable references");
      const value = ctx.output("out");
      ctx.emit(`${value} = __tags.${normalize}(${ctx.input("value")});`);
      ctx.emit(`(${ctx.reference("target")})?.set(${value});`);
    },
  };
}

export const tagNodes: NodeDefinition[] = [
  assign("tags.assign", "Assign Tag", TAG, "normalize"),
  assign("tags.assignContainer", "Assign TagContainer", TAG_CONTAINER, "container"),
  {
    id: "tags.make", title: "Make Tag", category: "tags", pure: true,
    description: "A Tag selected from the project registry.",
    pins: () => [input("value", "Tag", TAG), pin("out", "Tag", "out", TAG)],
    codegen: (ctx) => ({ out: `__tags.normalize(${ctx.input("value")})` }),
  },
  {
    id: "tags.makeContainer", title: "Make TagContainer", category: "tags", pure: true,
    description: "A collection of explicitly selected Tags.",
    pins: () => [input("value", "Tags", TAG_CONTAINER), pin("out", "Tags", "out", TAG_CONTAINER)],
    codegen: (ctx) => ({ out: `__tags.container(${ctx.input("value")})` }),
  },
  {
    id: "tags.fromArray", title: "Make TagContainer From Array", category: "tags", pure: true,
    pins: () => [input("tags", "Tags", arrayOf(TAG)), pin("out", "Container", "out", TAG_CONTAINER)],
    codegen: (ctx) => ({ out: `__tags.container({ Tags: ${ctx.input("tags")} })` }),
  },
  {
    id: "tags.toArray", title: "Get Tags", category: "tags", pure: true,
    pins: () => [input("container", "Container", TAG_CONTAINER), pin("out", "Tags", "out", arrayOf(TAG))],
    codegen: (ctx) => ({ out: `__tags.container(${ctx.input("container")}).Tags` }),
  },
  compare("tags.equals", "Equal Tag", "==="),
  compare("tags.notEquals", "Not Equal Tag", "!=="),
  {
    id: "tags.matches", title: "Matches Tag", category: "tags", pure: true,
    description: "A child Tag matches its parent categories unless Exact Match is enabled.",
    pins: () => [input("value", "Tag", TAG), input("query", "Query", TAG), exactPin(), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `__tags.match(${ctx.input("value")}, ${ctx.input("query")}, ${ctx.input("exact")})` }),
  },
  {
    id: "tags.isValid", title: "Is Valid Tag", category: "tags", pure: true,
    pins: () => [input("value", "Tag", TAG), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `__tags.valid(${ctx.input("value")})` }),
  },
  {
    id: "tags.toString", title: "Tag To String", category: "tags", pure: true,
    pins: () => [input("value", "Tag", TAG), pin("out", "Name", "out", STRING)],
    codegen: (ctx) => ({ out: `__tags.name(${ctx.input("value")})` }),
  },
  {
    id: "tags.has", title: "Has Tag", category: "tags", pure: true,
    pins: () => [input("container", "Container", TAG_CONTAINER), input("tag", "Tag", TAG), exactPin(), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `__tags.has(${ctx.input("container")}, ${ctx.input("tag")}, ${ctx.input("exact")})` }),
  },
  ...(["Any", "All"] as const).map((quantifier): NodeDefinition => ({
    id: `tags.has${quantifier}`, title: `Has ${quantifier} Tags`, category: "tags", pure: true,
    description: quantifier === "Any" ? "True when at least one query Tag matches; empty queries return false." : "True when every query Tag matches; empty queries return true.",
    pins: () => [input("container", "Container", TAG_CONTAINER), input("queries", "Queries", TAG_CONTAINER), exactPin(), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `__tags.${quantifier.toLowerCase()}(${ctx.input("container")}, ${ctx.input("queries")}, ${ctx.input("exact")})` }),
  })),
  ...(["Add", "Remove"] as const).map((operation): NodeDefinition => ({
    id: `tags.${operation.toLowerCase()}`, title: `${operation} Tag`, category: "tags", pure: true,
    description: `${operation === "Add" ? "Adds a unique" : "Removes an explicit"} Tag in a new container. Assign the result to retain the change.`,
    pins: () => [input("container", "Container", TAG_CONTAINER), input("tag", "Tag", TAG), pin("out", "Container", "out", TAG_CONTAINER)],
    codegen: (ctx) => ({ out: `__tags.${operation.toLowerCase()}(${ctx.input("container")}, ${ctx.input("tag")})` }),
  })),
  {
    id: "tags.clear", title: "Clear TagContainer", category: "tags", pure: true,
    pins: () => [input("container", "Container", TAG_CONTAINER), pin("out", "Container", "out", TAG_CONTAINER)],
    codegen: () => ({ out: "({ Tags: [] })" }),
  },
  {
    id: "tags.count", title: "Tag Count", category: "tags", pure: true,
    pins: () => [input("container", "Container", TAG_CONTAINER), pin("out", "Count", "out", INT)],
    codegen: (ctx) => ({ out: `__tags.container(${ctx.input("container")}).Tags.length` }),
  },
  {
    id: "tags.isEmpty", title: "Is TagContainer Empty", category: "tags", pure: true,
    pins: () => [input("container", "Container", TAG_CONTAINER), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `(__tags.container(${ctx.input("container")}).Tags.length === 0)` }),
  },
  binaryContainer("tags.containerEquals", "Equal TagContainer", "equals", BOOL),
  binaryContainer("tags.union", "Union Tags", "union"),
  binaryContainer("tags.intersection", "Intersect Tags", "intersection"),
  binaryContainer("tags.difference", "Difference Tags", "difference"),
  {
    id: "tags.switch", title: "Switch On Tag", category: "tags",
    description: "Routes to the selected Tag case. With Exact Match off, the most specific matching category wins.",
    structuredFlow: { kind: "switchOnTag" },
    pins: (properties) => [
      pin("execIn", "Exec", "in", EXEC), input("value", "Tag", TAG), exactPin(true),
      ...tagCasesOf(properties).map((tag) => pin(tagCasePinId(tag), caseName(properties, tag), "out", EXEC)),
      pin("default", "Default", "out", EXEC),
    ],
    codegen: () => { /* Structured execution is emitted by the compiler. */ },
  },
  {
    id: "tags.select", title: "Select By Tag", category: "tags", pure: true,
    description: "Selects a case value or Default. With Exact Match off, the most specific matching category wins.",
    pins: (properties) => [
      input("index", "Tag", TAG), exactPin(true),
      ...tagCasesOf(properties).map((tag) => input(tagOptionPinId(tag), caseName(properties, tag), RESOLVING_WILDCARD)),
      input("default", "Default", RESOLVING_WILDCARD), pin("out", "Result", "out", RESOLVING_WILDCARD),
    ],
    codegen: (ctx) => {
      const cases = tagCasesOf(ctx.node.properties);
      let expression = ctx.input("default");
      for (const tag of [...cases].reverse()) {
        expression = `(__case === ${tag} ? (${ctx.input(tagOptionPinId(tag))}) : (${expression}))`;
      }
      return { out: `((__case) => ${expression})(__tags.select(${ctx.input("index")}, ${JSON.stringify(cases)}, ${ctx.input("exact")}))` };
    },
  },
];
