import {
  arrayOf, assetRef, BOOL, EXEC, pin, STRING, structRef,
  type CodegenContext, type NodeDefinition,
} from "@babylonslate/scripting";
import { structGuidOf } from "./struct";

const OBJECT = assetRef("DataObject");
const SHEET = assetRef("DataSheet");
const OBJECTS = arrayOf(OBJECT);
const resultPins = () => [
  pin("execIn", "Exec", "in", EXEC),
  pin("execOut", "Then", "out", EXEC),
  pin("success", "Success", "out", BOOL),
  pin("error", "Error", "out", STRING),
];

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
  ...(["Objects", "Sheets"] as const).map((kind): NodeDefinition => ({
    ...common,
    id: `editorData.list${kind}`,
    title: `List Data ${kind}`,
    description: "Lists asset references from mounted content. Select a Structure to filter the result; an empty selection includes every Structure.",
    pins: () => [...resultPins(), pin("value", kind, "out", arrayOf(kind === "Objects" ? OBJECT : SHEET))],
    codegen: (ctx) => emitResult(ctx, `list${kind}(${JSON.stringify(structGuidOf(ctx.node.properties))})`, "[]"),
  })),
  {
    ...common,
    id: "editorData.readObject",
    title: "Read Editable Data Object",
    description: "Reads current values including unsaved editor changes. Check Success before using the Structure output.",
    pins: (properties) => [...resultPins(), pin("object", "Data Object", "in", OBJECT), pin("value", "Value", "out", structRef(structGuidOf(properties)))],
    codegen: (ctx) => emitResult(ctx, `readObject(${ctx.input("object")}, ${JSON.stringify(structGuidOf(ctx.node.properties))})`, "{}"),
  },
  {
    ...common,
    id: "editorData.readSheet",
    title: "Read Editable Data Sheet",
    description: "Reads ordered membership including unsaved editor changes. Objects remain shared standalone assets.",
    pins: () => [...resultPins(), pin("sheet", "Data Sheet", "in", SHEET), pin("value", "Objects", "out", OBJECTS)],
    codegen: (ctx) => emitResult(ctx, `readSheet(${ctx.input("sheet")}, ${JSON.stringify(structGuidOf(ctx.node.properties))})`, "[]"),
  },
  {
    ...common,
    id: "editorData.createObject",
    title: "Create Data Object",
    description: "Creates a standalone Data Object in project content using the selected Structure. Folder is relative to project content; existing assets are never overwritten.",
    pins: (properties) => [...resultPins(), pin("name", "Name", "in", STRING), pin("folder", "Folder", "in", STRING, "data", true, ""), pin("values", "Values", "in", structRef(structGuidOf(properties))), pin("value", "Data Object", "out", OBJECT)],
    codegen: (ctx) => emitResult(ctx, `createObject(${ctx.input("name")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}, ${ctx.input("values")}, ${ctx.input("folder")})`, '""'),
  },
  {
    ...common,
    id: "editorData.updateObject",
    title: "Update Data Object",
    description: "Updates the shared object's current values as one undoable edit. Use Save All to persist edits; every sheet sees the same object.",
    pins: (properties) => [...resultPins(), pin("object", "Data Object", "in", OBJECT), pin("values", "Values", "in", structRef(structGuidOf(properties))), pin("value", "Data Object", "out", OBJECT)],
    codegen: (ctx) => emitResult(ctx, `updateObject(${ctx.input("object")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}, ${ctx.input("values")})`, '""'),
  },
  {
    ...common,
    id: "editorData.createSheet",
    title: "Create Data Sheet",
    description: "Creates a sheet of references to existing Data Objects of the selected Structure. Empty membership is allowed.",
    pins: () => [...resultPins(), pin("name", "Name", "in", STRING), pin("folder", "Folder", "in", STRING, "data", true, ""), pin("objects", "Objects", "in", OBJECTS, "data", true, []), pin("value", "Data Sheet", "out", SHEET)],
    codegen: (ctx) => emitResult(ctx, `createSheet(${ctx.input("name")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}, ${ctx.input("objects")}, ${ctx.input("folder")})`, '""'),
  },
  {
    ...common,
    id: "editorData.setSheetObjects",
    title: "Set Data Sheet Objects",
    description: "Replaces ordered membership as one undoable edit. Deduplicates references and rejects missing objects or mismatched Structures before changing the sheet.",
    pins: () => [...resultPins(), pin("sheet", "Data Sheet", "in", SHEET), pin("objects", "Objects", "in", OBJECTS, "data", true, []), pin("value", "Data Sheet", "out", SHEET)],
    codegen: (ctx) => emitResult(ctx, `setSheetObjects(${ctx.input("sheet")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}, ${ctx.input("objects")})`, '""'),
  },
];
