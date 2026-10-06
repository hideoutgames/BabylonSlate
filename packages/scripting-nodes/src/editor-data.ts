import {
  arrayOf, assetRef, BOOL, EXEC, pin, STRING, structRef,
  type CodegenContext, type NodeDefinition,
} from "@babylonslate/scripting";

const SHEET = assetRef("DataSheet");
const ROWS = arrayOf(STRING);
const resultPins = () => [
  pin("execIn", "Exec", "in", EXEC),
  pin("execOut", "Then", "out", EXEC),
  pin("success", "Success", "out", BOOL),
  pin("error", "Error", "out", STRING),
];
const sheetPin = () => pin("sheet", "Data Sheet", "in", SHEET);
const rowPin = () => pin("rowId", "Row ID", "in", STRING);
const definitionGuid = (properties: Record<string, unknown>): string =>
  typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
const definitionLiteral = (ctx: CodegenContext) => JSON.stringify(definitionGuid(ctx.node.properties));

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
    ...common,
    id: "editorData.listSheets",
    title: "List Data Sheets",
    description: "Lists Data Sheet references from mounted content. Select a Data Definition to filter the result; an empty selection includes every definition.",
    pins: () => [...resultPins(), pin("value", "Data Sheets", "out", arrayOf(SHEET))],
    codegen: (ctx) => emitResult(ctx, `listSheets(${definitionLiteral(ctx)})`, "[]"),
  },
  {
    ...common,
    id: "editorData.readSheet",
    title: "Read Editable Data Sheet",
    description: "Reads ordered row IDs including unsaved sheet edits. Row IDs belong to this sheet and stay stable when rows are renamed or reordered.",
    pins: () => [...resultPins(), sheetPin(), pin("value", "Rows", "out", ROWS)],
    codegen: (ctx) => emitResult(ctx, `readSheet(${ctx.input("sheet")}, ${definitionLiteral(ctx)})`, "[]"),
  },
  {
    ...common,
    id: "editorData.readRow",
    title: "Read Editable Data Row",
    description: "Reads one row's current values including unsaved sheet changes. Check Success before using the typed output.",
    pins: (properties) => [...resultPins(), sheetPin(), rowPin(), pin("value", "Value", "out", structRef(definitionGuid(properties)))],
    codegen: (ctx) => emitResult(ctx, `readRow(${ctx.input("sheet")}, ${ctx.input("rowId")}, ${definitionLiteral(ctx)})`, "{}"),
  },
  {
    ...common,
    id: "editorData.createSheet",
    title: "Create Data Sheet",
    description: "Creates an empty sheet using the selected Data Definition. Folder is relative to project content; existing assets are never overwritten.",
    pins: () => [...resultPins(), pin("name", "Name", "in", STRING), pin("folder", "Folder", "in", STRING, "data", true, ""), pin("value", "Data Sheet", "out", SHEET)],
    codegen: (ctx) => emitResult(ctx, `createSheet(${ctx.input("name")}, ${definitionLiteral(ctx)}, ${ctx.input("folder")})`, '""'),
  },
  {
    ...common,
    id: "editorData.addRow",
    title: "Add Data Row",
    description: "Appends a row owned by this sheet using the selected Data Definition. The name must be unique within the sheet. Save All persists the undoable edit.",
    pins: (properties) => [...resultPins(), sheetPin(), pin("name", "Name", "in", STRING), pin("values", "Values", "in", structRef(definitionGuid(properties))), pin("value", "Row ID", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `addRow(${ctx.input("sheet")}, ${definitionLiteral(ctx)}, ${ctx.input("name")}, ${ctx.input("values")})`, '""'),
  },
  {
    ...common,
    id: "editorData.updateRow",
    title: "Update Data Row",
    description: "Updates a row as one undoable sheet edit. Scalar nested fields merge; supplied arrays and maps replace their contents.",
    pins: (properties) => [...resultPins(), sheetPin(), rowPin(), pin("values", "Values", "in", structRef(definitionGuid(properties))), pin("value", "Row ID", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `updateRow(${ctx.input("sheet")}, ${ctx.input("rowId")}, ${definitionLiteral(ctx)}, ${ctx.input("values")})`, '""'),
  },
  {
    ...common,
    id: "editorData.removeRow",
    title: "Remove Data Row",
    description: "Removes one row from its owning sheet. Undo on the sheet restores it.",
    pins: () => [...resultPins(), sheetPin(), rowPin(), pin("value", "Row ID", "out", STRING)],
    codegen: (ctx) => emitResult(ctx, `removeRow(${ctx.input("sheet")}, ${ctx.input("rowId")}, ${definitionLiteral(ctx)})`, '""'),
  },
  {
    ...common,
    id: "editorData.reorderRows",
    title: "Reorder Data Rows",
    description: "Sets row order as one undoable sheet edit. Include every existing row ID exactly once; this operation never inserts or drops rows.",
    pins: () => [...resultPins(), sheetPin(), pin("rowIds", "Rows", "in", ROWS, "data", true, []), pin("value", "Data Sheet", "out", SHEET)],
    codegen: (ctx) => emitResult(ctx, `reorderRows(${ctx.input("sheet")}, ${definitionLiteral(ctx)}, ${ctx.input("rowIds")})`, '""'),
  },
];
