import { arrayOf, assetRef, BOOL, pin, structRef, type NodeDefinition } from "@babylonslate/scripting";
import { structGuidOf } from "./struct";

/** Data is read by stable asset identity; a Structure makes its output typed. */
export const dataNodes: NodeDefinition[] = [
  {
    id: "data.readObject",
    title: "Read Data Object",
    category: "data",
    description: "Read an independent copy of a Data Object as its Structure. Found is false for missing, invalid, or incompatible objects.",
    searchAliases: ["data asset", "record", "configuration"],
    pure: true,
    pins: (properties) => [
      pin("object", "Object", "in", assetRef("DataObject")),
      pin("value", "Value", "out", structRef(structGuidOf(properties))),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("object")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}`;
      return { value: `ctx.data.readObject(${args})`, found: `ctx.data.hasObject(${args})` };
    },
  },
  {
    id: "data.getSheetObjects",
    title: "Get Data Sheet Objects",
    category: "data",
    description: "Get a sheet's ordered Data Object references. Read each object with Read Data Object. An empty valid sheet is still Found.",
    searchAliases: ["data table", "rows", "records"],
    pure: true,
    pins: () => [
      pin("sheet", "Sheet", "in", assetRef("DataSheet")),
      pin("objects", "Objects", "out", arrayOf(assetRef("DataObject"))),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const args = `${ctx.input("sheet")}, ${JSON.stringify(structGuidOf(ctx.node.properties))}`;
      return { objects: `ctx.data.getSheetObjects(${args})`, found: `ctx.data.hasSheet(${args})` };
    },
  },
];
