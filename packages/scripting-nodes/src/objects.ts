import { EXEC, classRef, objectRef, pin, type NodeDefinition } from "@haptic/scripting";
import { castDefaultClassId } from "./casting";

export const CREATE_OBJECT_NODE_ID = "object.create";
export const COLLECT_GARBAGE_NODE_ID = "object.collectGarbage";

/** Create Object and Collect Garbage: objects that live while a reference reaches them. */
export const objectNodes: NodeDefinition[] = [
  {
    id: CREATE_OBJECT_NODE_ID,
    title: "Create Object",
    category: "object",
    description:
      "Creates an object of a Class whose parent is Object and runs its Event On Init. The object lives while a variable, array, map, structure or waiting node holds it, and is collected once nothing does. A Class with the Tickable Object interface also receives Event Tick.",
    // The Class picked on the node (`default:class`) types Object, or the Class wired in, as Cast does.
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("class", "Class", "in", classRef("Object")),
      pin("object", "Object", "out", objectRef(castDefaultClassId(properties))),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("object")} = ctx.createObject(${ctx.input("class")});`);
    },
  },
  {
    id: COLLECT_GARBAGE_NODE_ID,
    title: "Collect Garbage",
    category: "object",
    description:
      "Collects objects made by Create Object that nothing references any more, at the end of the current tick. Haptic also does this on its own, about once a second.",
    pins: () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)],
    codegen: (ctx) => {
      ctx.emit("ctx.collectGarbage();");
    },
  },
];
