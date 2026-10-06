import { arrayOf, assetRef, BOOL, pin, STRING, structRef, type NodeDefinition } from "@babylonslate/scripting";

export function dataDefinitionGuidOf(properties: Record<string, unknown>): string {
  return typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
}

/** Data Definitions supply typed values; sheet-local row IDs survive renames. */
export const dataNodes: NodeDefinition[] = [
  {
    id: "data.readRow",
    title: "Read Data Row",
    category: "data",
    description: "Read an independent copy of a sheet row using its stable Row ID. Found is false for missing, invalid, or incompatible rows.",
    searchAliases: ["data table", "record", "configuration"],
    pure: true,
    pins: (properties) => [
      pin("sheet", "Sheet", "in", assetRef("DataSheet")),
      pin("rowId", "Row ID", "in", STRING),
      pin("value", "Value", "out", structRef(dataDefinitionGuidOf(properties))),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("sheet")}, ${ctx.input("rowId")}, ${JSON.stringify(dataDefinitionGuidOf(ctx.node.properties))}`;
      return { value: `ctx.data.readRow(${args})`, found: `ctx.data.hasRow(${args})` };
    },
  },
  {
    id: "data.getSheetRows",
    title: "Get Data Sheet Rows",
    category: "data",
    description: "Get a sheet's ordered stable row IDs. Use For Each and Read Data Row to read the values. An empty valid sheet is still Found.",
    searchAliases: ["data table", "rows", "records"],
    pure: true,
    pins: () => [
      pin("sheet", "Sheet", "in", assetRef("DataSheet")),
      pin("rows", "Rows", "out", arrayOf(STRING)),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("sheet")}, ${JSON.stringify(dataDefinitionGuidOf(ctx.node.properties))}`;
      return { rows: `ctx.data.getSheetRows(${args})`, found: `ctx.data.hasSheet(${args})` };
    },
  },
];
