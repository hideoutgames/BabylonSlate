import { arrayOf, assetRef, BOOL, pin, STRING, structRef, type NodeDefinition } from "@babylonslate/scripting";

export function dataDefinitionGuidOf(properties: Record<string, unknown>): string {
  return typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
}

/** Data Definitions supply typed values; trees are navigated by exact name paths. */
export const dataNodes: NodeDefinition[] = [
  {
    id: "data.readEntry",
    title: "Read Data Entry",
    category: "data",
    description: "Read an independent copy of an entry by its exact path, such as Weapons/Swords/Iron Sword. Found requires valid values matching the selected Data Definition.",
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
