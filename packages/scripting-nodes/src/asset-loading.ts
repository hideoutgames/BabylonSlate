import {
  arrayOf, assetRef, BOOL, classRef, ENGINE_ASSET_LOAD_HANDLE_STATE_ENUM_ID, ENGINE_ASSET_LOAD_PRIORITY_ENUM_ID,
  ENGINE_ASSET_LOAD_STATE_ENUM_ID, enumRef, EXEC, FLOAT, pin, STRING, type NodeDefinition,
} from "@babylonslate/scripting";

/** The empty asset type is the wildcard: any Content Browser asset wires in and picks. */
const ASSET = assetRef("");
const ASSETS = arrayOf(ASSET);
/** Any Class. */
const CLASS = classRef("BObject");

const priorityPin = () => pin("priority", "Priority", "in", enumRef(ENGINE_ASSET_LOAD_PRIORITY_ENUM_ID), "data", true, "Normal");
const sessionWidePin = () => pin("sessionWide", "Session Wide", "in", BOOL, "data", true, false);
const handleIn = () => pin("handle", "Handle", "in", STRING);

const OWNERSHIP = "The load handle belongs to the calling object (the current Scene without one, or the session with Session Wide) and keeps the load owned until it is released, that owner is destroyed or Play stops.";
const POLICY = "Soft (Load On Demand) references need this; Hard (Load With Owner) references already load with their owner.";

type Subject = "asset" | "assets" | "class";

/**
 * Request, then wait: Async Load continues gameplay while the load runs;
 * Blocking loads at High priority and holds the simulation (like Load Scene
 * Blocking) until the load settles.
 */
function loadNode(
  id: string, title: string, subject: Subject, blocking: boolean, description: string, searchAliases: readonly string[],
): NodeDefinition {
  const input = subject === "class" ? pin("class", "Class", "in", CLASS)
    : subject === "assets" ? pin("assets", "Assets", "in", ASSETS) : pin("asset", "Asset", "in", ASSET);
  // The Asset(s) pass through to an output of their own: an input and an output must not share an id.
  const passThrough = `${input.id}Out`;
  return {
    id, title, category: "assets", latent: true, description, searchAliases,
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("completed", "Completed", "out", EXEC), pin("failed", "Failed", "out", EXEC),
      input,
      ...(blocking ? [] : [priorityPin()]),
      sessionWidePin(),
      ...(subject === "class" ? [] : [pin(passThrough, input.name, "out", input.type)]),
      pin("handle", "Handle", "out", STRING),
      pin("error", "Error", "out", STRING),
    ],
    codegen: ctx => {
      const key = ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_");
      const value = `__loadInput_${key}`, handle = `__loadHandle_${key}`, result = `__loadResult_${key}`;
      const request = subject === "class" ? "requestClassLoad" : "requestAssetLoad";
      const target = subject === "asset" ? `[${value}]` : value;
      const priority = blocking ? '"High"' : ctx.input("priority");
      ctx.emit(`const ${value} = ${ctx.input(input.id)};`);
      ctx.emit(`const ${handle} = ctx.${request}(${target}, { priority: ${priority}, sessionWide: ${ctx.input("sessionWide")} });`);
      ctx.emit(`const ${result} = await ctx.waitForAssetLoad(${handle}${blocking ? ", { blocking: true }" : ""});`);
      if (subject !== "class") ctx.emit(`${ctx.output(passThrough)} = ${value};`);
      ctx.emit(`${ctx.output("handle")} = ${handle};`);
      ctx.emit(`${ctx.output("error")} = ${result}.errorMessage;`);
      ctx.branch?.(`${result}.success`, "Completed", "Failed");
    },
  };
}

export const assetLoadingNodes: NodeDefinition[] = [
  loadNode("assets.asyncLoad", "Async Load Asset", "asset", false,
    `Loads the Asset and its required dependencies while gameplay continues, then runs Completed; runs Failed with an Error if it cannot load. ${OWNERSHIP} ${POLICY}`,
    ["preload", "streamable", "soft", "soft reference", "load asset", "request async load", "stream"]),
  loadNode("assets.asyncLoadMany", "Async Load Assets", "assets", false,
    `Loads every Asset and its required dependencies as one request while gameplay continues, then runs Completed; runs Failed with an Error if any cannot load, and none stay loaded. ${OWNERSHIP} ${POLICY}`,
    ["preload", "preload assets", "streamable", "soft", "soft reference", "load assets", "stream"]),
  loadNode("assets.asyncLoadClass", "Async Load Class", "class", false,
    `Loads the Class (its scripts and required resources) while gameplay continues, then runs Completed; runs Failed with an Error if it cannot load. Spawn Actor can then create it without waiting. ${OWNERSHIP}`,
    ["preload", "preload class", "streamable", "soft", "soft class", "load class", "stream"]),
  loadNode("assets.loadBlocking", "Load Asset Blocking", "asset", true,
    `Loads the Asset at High priority and pauses game simulation (ticks, physics, timers, tweens) until it settles; loading and rendering preparation continue. Runs Completed or Failed with an Error. ${OWNERSHIP}`,
    ["load synchronous", "synchronous", "sync load", "flush async loading", "blocking load", "preload", "loading screen"]),
  loadNode("assets.loadManyBlocking", "Load Assets Blocking", "assets", true,
    `Loads every Asset at High priority as one request and pauses game simulation until it settles; loading and rendering preparation continue. Runs Completed or Failed with an Error. ${OWNERSHIP}`,
    ["load synchronous", "synchronous", "sync load", "flush async loading", "blocking load", "preload assets", "loading screen"]),
  loadNode("assets.loadClassBlocking", "Load Class Blocking", "class", true,
    `Loads the Class at High priority and pauses game simulation until it settles; loading and rendering preparation continue. Runs Completed or Failed with an Error. ${OWNERSHIP}`,
    ["load synchronous", "synchronous", "sync load", "flush async loading", "blocking load", "preload class", "loading screen"]),
  {
    id: "assets.requestLoad", title: "Request Async Load", category: "assets",
    description: `Starts loading the Assets and returns a Handle at once, without waiting. Follow it with Wait For Load Handle, Get Load Handle State or Get Load Handle Progress. ${OWNERSHIP}`,
    searchAliases: ["preload", "streamable", "soft", "request load", "stream", "async load"],
    pins: () => [
      pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
      pin("assets", "Assets", "in", ASSETS), priorityPin(), sessionWidePin(),
      pin("handle", "Handle", "out", STRING),
    ],
    codegen: ctx => {
      ctx.emit(`${ctx.output("handle")} = ctx.requestAssetLoad(${ctx.input("assets")}, { priority: ${ctx.input("priority")}, sessionWide: ${ctx.input("sessionWide")} });`);
    },
  },
  {
    id: "assets.waitForHandle", title: "Wait For Load Handle", category: "assets", latent: true,
    description: "Waits until the Handle is Loaded, then runs Completed (immediately when it already is). Runs Failed with the stored Error when the load failed, or when the Handle was released or never existed. Gameplay continues while it waits.",
    searchAliases: ["await load", "wait for load", "wait for streamable", "wait for preload", "wait for asset"],
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("completed", "Completed", "out", EXEC), pin("failed", "Failed", "out", EXEC),
      handleIn(), pin("error", "Error", "out", STRING),
    ],
    codegen: ctx => {
      const result = `__loadResult_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      ctx.emit(`const ${result} = await ctx.waitForAssetLoad(${ctx.input("handle")});`);
      ctx.emit(`${ctx.output("error")} = ${result}.errorMessage;`);
      ctx.branch?.(`${result}.success`, "Completed", "Failed");
    },
  },
  {
    id: "assets.getHandleState", title: "Get Load Handle State", category: "assets", pure: true,
    description: "Returns Loading, Loaded, Failed or Released. A Failed Handle stays queryable until it is released; a released or unknown Handle reads Released.",
    searchAliases: ["streamable state", "is loading", "load status"],
    pins: () => [handleIn(), pin("state", "State", "out", enumRef(ENGINE_ASSET_LOAD_HANDLE_STATE_ENUM_ID))],
    codegen: ctx => ({ state: `ctx.getAssetLoadHandleState(${ctx.input("handle")})` }),
  },
  {
    id: "assets.getHandleProgress", title: "Get Load Handle Progress", category: "assets", pure: true,
    description: "Returns the load progress from 0 to 1. It never decreases, and reaches 1 only when the Handle is Loaded.",
    searchAliases: ["streamable progress", "loading progress", "percent loaded"],
    pins: () => [handleIn(), pin("progress", "Progress", "out", FLOAT)],
    codegen: ctx => ({ progress: `ctx.getAssetLoadHandleProgress(${ctx.input("handle")})` }),
  },
  {
    id: "assets.releaseHandle", title: "Release Load Handle", category: "assets",
    description: "Cancels the load if it is pending and drops this Handle's ownership; the Handle then reads Released. Assets other owners hold stay loaded.",
    searchAliases: ["release preload", "release streamable", "cancel load", "free handle"],
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC), handleIn()],
    codegen: ctx => { ctx.emit(`ctx.releaseAssetLoad(${ctx.input("handle")});`); },
  },
  {
    id: "assets.unload", title: "Unload Asset", category: "assets",
    description: "Releases every load handle that includes the Asset and belongs to the calling object (or the session with Session Wide). A handle is released whole, so load assets in separate requests to unload them individually. Assets other owners hold, and on-demand loads by sounds, spawned actors and material assignments, are not affected.",
    searchAliases: ["release asset", "free asset", "unload", "evict"],
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC), pin("asset", "Asset", "in", ASSET), sessionWidePin()],
    codegen: ctx => { ctx.emit(`ctx.unloadAsset(${ctx.input("asset")}, { sessionWide: ${ctx.input("sessionWide")} });`); },
  },
  {
    id: "assets.getLoadState", title: "Get Asset Load State", category: "assets", pure: true,
    description: "Returns Unloaded, Loading, Loaded or Failed. Loaded includes the runtime preparation of the Asset's resources, and an Asset nothing has loaded reads Unloaded.",
    searchAliases: ["is loaded", "asset status", "load status"],
    pins: () => [pin("asset", "Asset", "in", ASSET), pin("state", "State", "out", enumRef(ENGINE_ASSET_LOAD_STATE_ENUM_ID))],
    codegen: ctx => ({ state: `ctx.getAssetLoadState(${ctx.input("asset")})` }),
  },
  {
    id: "assets.isLoaded", title: "Is Asset Loaded", category: "assets", pure: true,
    description: "True when the Asset is Loaded: its resources are prepared and ready to use right now.",
    searchAliases: ["is asset ready", "has loaded", "load status"],
    pins: () => [pin("asset", "Asset", "in", ASSET), pin("loaded", "Loaded", "out", BOOL)],
    codegen: ctx => ({ loaded: `(ctx.getAssetLoadState(${ctx.input("asset")}) === "Loaded")` }),
  },
];
