import {
  arrayOf, assetRef, BOOL, EXEC, INT, pin, STRING, structRef,
  type CodegenContext, type NodeDefinition,
} from "@babylonslate/scripting";

const TREE = assetRef("DataTree");
const PATHS = arrayOf(STRING);
const resultPins = () => [
  pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
  pin("success", "Success", "out", BOOL), pin("error", "Error", "out", STRING),
];
const treePin = () => pin("tree", "Data Tree", "in", TREE);
const pathPin = (id = "entryPath", label = "Entry Path", root = false) => pin(id, label, "in", STRING, "data", root, root ? "" : undefined);
const definitionGuid = (properties: Record<string, unknown>): string =>
  typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
const definitionLiteral = (ctx: CodegenContext) => JSON.stringify(definitionGuid(ctx.node.properties));
const hasValues = (properties: Record<string, unknown>) => !!definitionGuid(properties) && properties.definitionMode !== "none";

function emitResult(ctx: CodegenContext, call: string, fallback: string): void {
  const result = `${ctx.output("value")}_result`;
  ctx.emit("{");
  ctx.emit(`const ${result} = await ctx.editorData.${call};`);
  ctx.emit(`${ctx.output("success")} = ${result}.success;`);
  ctx.emit(`${ctx.output("error")} = ${result}.error;`);
  ctx.emit(`${ctx.output("value")} = ${result}.value ?? ${fallback};`);
  ctx.emit("}");
}
const common = { category: "editor", editorOnly: true, latent: true } as const;

export const editorDataNodes: NodeDefinition[] = [
  {
    ...common, id: "editorData.listTrees", title: "List Data Trees",
    description: "Lists Data Trees. An optional Definition filters tree defaults and effective entry Definitions.",
    pins: () => [...resultPins(), pin("value", "Data Trees", "out", arrayOf(TREE))],
    codegen: (ctx) => emitResult(ctx, `listTrees(${definitionLiteral(ctx)})`, "[]"),
  },
  {
    ...common, id: "editorData.readTree", title: "Read Editable Data Tree",
    description: "Reads every entry path in preorder, including unsaved tree edits. Paths change when entries are renamed or moved.",
    pins: () => [...resultPins(), treePin(), pin("value", "Entry Paths", "out", PATHS)],
    codegen: (ctx) => emitResult(ctx, `readTree(${ctx.input("tree")})`, "[]"),
  },
  {
    ...common, id: "editorData.readEntry", title: "Read Editable Data Entry",
    description: "Reads owned values at an exact path using the selected Definition. Check Success before using Value.",
    pins: (properties) => [...resultPins(), treePin(), pathPin(), pin("value", "Value", "out", structRef(definitionGuid(properties)))],
    codegen: (ctx) => emitResult(ctx, `readEntry(${ctx.input("tree")}, ${ctx.input("entryPath")}, ${definitionLiteral(ctx)})`, "{}"),
  },
  ...(["getChildren", "getDescendants"] as const).map((method): NodeDefinition => ({
    ...common, id: `editorData.${method}`, title: method === "getChildren" ? "Get Editable Data Children" : "Get Editable Data Descendants",
    description: "Reads ordered entry paths including unsaved edits. Empty Entry Path selects the tree root.",
    pins: () => [...resultPins(), treePin(), pathPin("entryPath", "Entry Path", true), pin("value", "Entry Paths", "out", PATHS)],
    codegen: (ctx) => emitResult(ctx, `${method}(${ctx.input("tree")}, ${ctx.input("entryPath")})`, "[]"),
  })),
  {
    ...common, id: "editorData.getParent", title: "Get Editable Data Parent",
    description: "Reads the parent path. Top-level entries return an empty path; missing entries fail.",
    pins: () => [...resultPins(), treePin(), pathPin(), pin("value", "Parent Path", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `getParent(${ctx.input("tree")}, ${ctx.input("entryPath")})`, '""'),
  },
  {
    ...common, id: "editorData.createTree", title: "Create Data Tree",
    description: "Creates an empty tree with an optional default Definition. Folder is relative to project content; existing assets are never overwritten.",
    pins: () => [...resultPins(), pin("name", "Name", "in", STRING), pin("folder", "Folder", "in", STRING, "data", true, ""), pin("value", "Data Tree", "out", TREE)],
    codegen: (ctx) => emitResult(ctx, `createTree(${ctx.input("name")}, ${definitionGuid(ctx.node.properties) ? definitionLiteral(ctx) : "null"}, ${ctx.input("folder")})`, '""'),
  },
  {
    ...common, id: "editorData.addEntry", title: "Add Data Entry",
    description: "Adds an owned entry under Parent Path. Definition can inherit, override, or be None for grouping. Defaults copy once; values never inherit.",
    pins: (properties) => [...resultPins(), treePin(), pathPin("parentPath", "Parent Path", true), pin("name", "Name", "in", STRING),
      ...(hasValues(properties) ? [pin("values", "Values", "in", structRef(definitionGuid(properties)))] : []), pin("value", "Entry Path", "out", STRING)],
    codegen: (ctx) => {
      const properties = ctx.node.properties;
      const definition = properties.definitionMode === "none" ? "null" : properties.definitionMode === "inherit" || (!definitionGuid(properties) && properties.definitionMode !== "override") ? "undefined" : definitionLiteral(ctx);
      emitResult(ctx, `addEntry(${ctx.input("tree")}, ${ctx.input("parentPath")}, ${ctx.input("name")}, ${definition}, ${hasValues(properties) ? ctx.input("values") : "undefined"})`, '""');
    },
  },
  {
    ...common, id: "editorData.updateEntry", title: "Update Data Entry",
    description: "Updates owned values in one undoable tree edit. Nested scalar fields merge; supplied arrays and maps replace their contents.",
    pins: (properties) => [...resultPins(), treePin(), pathPin(), pin("values", "Values", "in", structRef(definitionGuid(properties))), pin("value", "Entry Path", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `updateEntry(${ctx.input("tree")}, ${ctx.input("entryPath")}, ${definitionLiteral(ctx)}, ${ctx.input("values")})`, '""'),
  },
  {
    ...common, id: "editorData.removeEntry", title: "Remove Data Subtree",
    description: "Removes an entry and all descendants in one edit. Undo on the tree restores the entire subtree.",
    pins: () => [...resultPins(), treePin(), pathPin(), pin("value", "Entry Path", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `removeEntry(${ctx.input("tree")}, ${ctx.input("entryPath")})`, '""'),
  },
  {
    ...common, id: "editorData.moveEntry", title: "Move Data Subtree",
    description: "Moves an entry under New Parent Path, preserving owned values and child order. Index -1 appends; other indexes are zero-based.",
    pins: () => [...resultPins(), treePin(), pathPin(), pathPin("newParentPath", "New Parent Path", true), pin("index", "Index", "in", INT, "data", true, -1), pin("value", "Entry Path", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `moveEntry(${ctx.input("tree")}, ${ctx.input("entryPath")}, ${ctx.input("newParentPath")}, ${ctx.input("index")} === -1 ? undefined : ${ctx.input("index")})`, '""'),
  },
  {
    ...common, id: "editorData.reorderChildren", title: "Reorder Data Children",
    description: "Sets sibling order in one undoable tree edit. Include every immediate child path exactly once.",
    pins: () => [...resultPins(), treePin(), pathPin("parentPath", "Parent Path", true), pin("entryPaths", "Entry Paths", "in", PATHS, "data", true, []), pin("value", "Data Tree", "out", TREE)],
    codegen: (ctx) => emitResult(ctx, `reorderChildren(${ctx.input("tree")}, ${ctx.input("parentPath")}, ${ctx.input("entryPaths")})`, '""'),
  },
];
