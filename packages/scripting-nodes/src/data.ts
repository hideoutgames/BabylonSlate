import { arrayOf, assetRef, BOOL, EXEC, pin, STRING, structRef, type NodeDefinition } from "@babylonslate/scripting";

export function dataDefinitionGuidOf(properties: Record<string, unknown>): string {
  return typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
}

/** Data Definitions supply typed values; trees are navigated by exact name paths. */
export const dataNodes: NodeDefinition[] = [
  {
    id: "data.readEntryAsync", title: "Read Data Entry Async", category: "data", latent: true,
    description: "Loads a dynamically selected Data Tree and its schema, then reads an independent entry copy. Ownership follows this runtime object.",
    searchAliases: ["data tree", "load data", "record", "configuration"],
    pins: properties => [
      pin("execIn", "Exec", "in", EXEC), pin("completed", "Completed", "out", EXEC), pin("failed", "Failed", "out", EXEC),
      pin("tree", "Tree", "in", assetRef("DataTree")), pin("entryPath", "Entry Path", "in", STRING),
      pin("value", "Value", "out", structRef(dataDefinitionGuidOf(properties))), pin("found", "Found", "out", BOOL), pin("error", "Error", "out", STRING),
    ],
    codegen: ctx => {
      const result = ctx.output("value");
      const error = ctx.output("error");
      ctx.emit(`${error} = "";`);
      ctx.emit(`try { ${result} = await ctx.readDataEntryAsync(${ctx.input("tree")}, ${ctx.input("entryPath")}, ${JSON.stringify(dataDefinitionGuidOf(ctx.node.properties))}); } catch (error) { if (error?.name === "AbortError") throw error; ${result} = null; ${error} = error instanceof Error ? error.message : String(error); }`);
      ctx.emit(`${ctx.output("found")} = ${result} !== null;`);
      ctx.branch?.(`${error} === ""`, "Completed", "Failed");
    },
  },
  {
    id: "data.readEntry",
    title: "Read Data Entry",
    category: "data",
    description: "Read an already prepared entry copy by its exact path, such as Weapons/Swords/Iron Sword. Found requires valid values matching the selected Data Definition.",
    searchAliases: ["data tree", "record", "configuration"],
    pure: true,
    pins: (properties) => [
      pin("tree", "Tree", "in", assetRef("DataTree")),
      pin("entryPath", "Entry Path", "in", STRING),
      pin("value", "Value", "out", structRef(dataDefinitionGuidOf(properties))),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("tree")}, ${ctx.input("entryPath")}, ${JSON.stringify(dataDefinitionGuidOf(ctx.node.properties))}`;
      return { value: `ctx.data.readEntry(${args})`, found: `ctx.data.canReadEntry(${args})` };
    },
  },
  ...(["getChildren", "getDescendants"] as const).map((operation): NodeDefinition => ({
    id: `data.${operation}`,
    title: operation === "getChildren" ? "Get Data Children" : "Get Data Descendants",
    category: "data",
    description: operation === "getChildren"
      ? "Get immediate child entry paths in sibling order. An empty Entry Path selects the tree root. Found includes untyped grouping entries."
      : "Get all descendant entry paths in preorder, excluding the selected entry. An empty Entry Path selects the tree root. Found includes untyped grouping entries.",
    searchAliases: ["data tree", "entries", "hierarchy"],
    pure: true,
    pins: () => [
      pin("tree", "Tree", "in", assetRef("DataTree")),
      pin("entryPath", "Entry Path", "in", STRING),
      pin("paths", "Entry Paths", "out", arrayOf(STRING)),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const tree = ctx.input("tree");
      const path = ctx.input("entryPath");
      return {
        paths: `ctx.data.${operation}(${tree}, ${path})`,
        found: `(${path} === "" ? ctx.data.hasTree(${tree}) : ctx.data.hasEntry(${tree}, ${path}))`,
      };
    },
  })),
  {
    id: "data.getParent",
    title: "Get Data Parent",
    category: "data",
    description: "Get an entry's parent path. Top-level entries return an empty path for the tree root. Found is false for the virtual root or a missing entry.",
    searchAliases: ["data tree", "entries", "hierarchy"],
    pure: true,
    pins: () => [
      pin("tree", "Tree", "in", assetRef("DataTree")),
      pin("entryPath", "Entry Path", "in", STRING),
      pin("parentPath", "Parent Path", "out", STRING),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("tree")}, ${ctx.input("entryPath")}`;
      return { parentPath: `(ctx.data.getParent(${args}) ?? "")`, found: `ctx.data.hasEntry(${args})` };
    },
  },
];
