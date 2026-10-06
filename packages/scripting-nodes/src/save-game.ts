import {
  arrayOf, actorRef, assetRef, BOXED_WILDCARD, BOOL, EXEC, INT, STRING,
  pin, pinTypeForMember, structRef, type NodeDefinition, type PinType,
} from "@babylonslate/scripting";

/** Stable field ids are authored in nodes; display names may change freely. */
export function saveFieldPinType(properties: Record<string, unknown>): PinType {
  if (typeof properties.typeId !== "string") return BOXED_WILDCARD;
  const type = String(properties.typeId ?? "string");
  const base = type === "actor" ? actorRef("Actor") : type === "asset" ? assetRef("Asset")
    : pinTypeForMember(type === "vector3" ? "vec3" : type);
  return properties.array === true ? arrayOf(base) : base;
}

const INFO = structRef("engine:SaveGameInfo");
const slotPins = () => [
  pin("slot", "Slot", "in", STRING, "data", true, ""),
  pin("profile", "Profile", "in", STRING, "data", true, ""),
];

function operation(method: string, title: string, valueType?: PinType): NodeDefinition {
  return {
    id: `saveGame.${method}`, title, category: "save-game", latent: true,
    description: "Waits for completion, then runs Completed or Failed. Empty Slot and Profile use project defaults. Failure preserves the last valid save.",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("completed", "Completed", "out", EXEC), pin("failed", "Failed", "out", EXEC),
      ...(method === "newGame" ? [] : method === "listSaves" ? slotPins().slice(1) : slotPins()),
      pin("success", "Success", "out", BOOL),
      pin("errorCode", "Error Code", "out", STRING), pin("errorMessage", "Error Message", "out", STRING),
      ...(valueType ? [pin("value", method === "listSaves" ? "Saves" : method === "newGame" ? "Save Data" : "Save", "out", valueType)] : []),
    ],
    codegen: (ctx) => {
      const result = `__save_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      const args = method === "newGame" ? "" : method === "listSaves"
        ? `{ profile: ${ctx.input("profile")} || undefined }`
        : `{ slot: ${ctx.input("slot")} || undefined, profile: ${ctx.input("profile")} || undefined }`;
      ctx.emit(`const ${result} = await ctx.${method}(${args});`);
      ctx.emit(`${ctx.output("success")} = ${result}.ok;`);
      ctx.emit(`${ctx.output("errorCode")} = ${result}.ok ? "" : ${result}.error.code;`);
      ctx.emit(`${ctx.output("errorMessage")} = ${result}.ok ? "" : ${result}.error.message;`);
      if (valueType) ctx.emit(`${ctx.output("value")} = ${result}.ok ? ${result}.value : ${method === "listSaves" ? "[]" : "null"};`);
      ctx.branch?.(`${result}.ok`, "Completed", "Failed");
    },
  };
}

function fieldNode(write: boolean, migration = false): NodeDefinition {
  const method = `${write ? "set" : "get"}${migration ? "SaveMigration" : "Save"}Field`;
  const operation = migration ? (write ? "migrationSetField" : "migrationGetField") : (write ? "setField" : "getField");
  return {
    id: `saveGame.${operation}`,
    title: `${write ? "Set" : "Get"} ${migration ? "Migration" : "Save"} Field`, category: "save-game", pure: !write,
    description: migration ? "Read or update the staged migration field by its permanent field ID. Actor references are persistent ID strings until world restoration. Only valid inside Event Save Migration."
      : "Read or update a typed Save Game field by its permanent ID. Save Game writes changes to storage.",
    pins: (properties) => [
      ...(write ? [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC)] : []),
      ...(properties.fieldId ? [] : [pin("fieldId", "Field ID", "in", STRING)]),
      pin("value", String(properties.fieldName ?? "Value"), write ? "in" : "out", saveFieldPinType(migration && properties.typeId === "actor" ? { ...properties, typeId: "string" } : properties)),
    ],
    codegen: (ctx) => {
      const id = ctx.node.properties.fieldId ? JSON.stringify(ctx.node.properties.fieldId) : ctx.input("fieldId");
      const type = JSON.stringify(String(ctx.node.properties.typeId ?? "string"));
      const array = ctx.node.properties.array === true;
      if (write) ctx.emit(`ctx.${method}(${id}, ${ctx.input("value")}, ${type}, ${array});`);
      else return { value: `ctx.${method}(${id}, ${type}, ${array})` };
    },
  };
}

export const saveGameNodes: NodeDefinition[] = [
  {
    id: "saveGame.getSaveData", title: "Get Save Data", category: "save-game", pure: true,
    description: "Returns the default Save Game's current mutable data. Use generated Get/Set Save Field nodes for typed field pins.",
    pins: () => [pin("data", "Save Data", "out", BOXED_WILDCARD)],
    codegen: () => ({ data: "ctx.getSaveData()" }),
  },
  fieldNode(false), fieldNode(true), fieldNode(false, true), fieldNode(true, true),
  operation("newGame", "New Game", BOXED_WILDCARD),
  operation("saveGame", "Save Game", INFO), operation("loadGame", "Load Game", INFO),
  operation("listSaves", "List Saves", arrayOf(INFO)), operation("deleteSave", "Delete Save"),
  {
    id: "saveGame.registerActor", title: "Register Save Actor", category: "save-game",
    description: "Register a spawned actor for persistence. Use a stable custom ID to reconnect it across loads; its Save Game Component selects saved state.",
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
      pin("actor", "Actor", "in", actorRef("Actor")), pin("persistentId", "Persistent ID", "in", STRING, "data", true, "")],
    codegen: (ctx) => { ctx.emit(`ctx.registerSaveActor(${ctx.input("actor")}, ${ctx.input("persistentId")} || undefined);`); },
  },
  {
    id: "saveGame.registerMigration", title: "Register Save Migration", category: "save-game",
    description: "Register during On Init or Begin Play, before Load Game. Event Save Migration receives each registered From Version and can update staged fields. Register every step to the current schema version.",
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC), pin("fromVersion", "From Version", "in", INT, "data", true, 1)],
    codegen: (ctx) => { ctx.emit(`ctx.registerSaveMigration(${ctx.input("fromVersion")}, "onSaveMigration");`); },
  },
  {
    id: "flow.event.saveMigration", title: "Event Save Migration", category: "save-game", pure: true,
    description: "Runs against a staged copy during Load Game. Use From Version with migration field nodes. Errors abort loading and preserve the original save.",
    pins: () => [pin("execOut", "Then", "out", EXEC), pin("fromVersion", "From Version", "out", INT)],
    codegen: () => ({ fromVersion: "ctx.args.saveMigrationData.schemaVersion" }),
  },
  {
    id: "flow.event.gameLoaded", title: "Event On Game Loaded", category: "save-game", pure: true,
    description: "Runs after selected world state and references are restored, before gameplay continues.",
    pins: () => [pin("execOut", "Then", "out", EXEC)],
    codegen: () => {
      /* Entry point emitted by the compiler; this event has no data outputs. */
    },
  },
];
