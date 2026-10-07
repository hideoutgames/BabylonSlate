import { arrayOf, assetRef, BOOL, EXEC, FLOAT, pin, STRING, type NodeDefinition } from "@babylonslate/scripting";

export const assetLoadingNodes: NodeDefinition[] = [
  {
    id: "assets.preload", title: "Preload Assets", category: "assets", latent: true,
    description: "Prepares selected assets and required dependencies, reporting progress until Completed or Failed. Ownership follows the calling runtime object unless Session Wide is enabled.",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("completed", "Completed", "out", EXEC), pin("failed", "Failed", "out", EXEC),
      pin("assets", "Assets", "in", arrayOf(assetRef("Asset"))),
      pin("sessionWide", "Session Wide", "in", BOOL, "data", true, false),
      pin("preload", "Preload", "out", STRING), pin("progress", "Progress", "out", FLOAT),
      pin("error", "Error", "out", STRING),
    ],
    codegen: ctx => {
      const result = `__preload_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      ctx.emit(`const ${result} = await ctx.preloadAssets(${ctx.input("assets")}, { sessionWide: ${ctx.input("sessionWide")}, onProgress: (progress) => { ${ctx.output("progress")} = progress; } });`);
      ctx.emit(`${ctx.output("preload")} = ${result}.preloadId;`);
      ctx.emit(`${ctx.output("progress")} = ${result}.progress;`);
      ctx.emit(`${ctx.output("error")} = ${result}.errorMessage;`);
      ctx.branch?.(`${result}.success`, "Completed", "Failed");
    },
  },
  {
    id: "assets.releasePreload", title: "Release Preload", category: "assets",
    description: "Releases this preload's ownership. Assets retained by active scenes or other preloads remain usable.",
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC), pin("preload", "Preload", "in", STRING)],
    codegen: ctx => { ctx.emit(`ctx.releasePreload(${ctx.input("preload")});`); },
  },
  {
    id: "assets.getLoadState", title: "Get Asset Load State", category: "assets", pure: true,
    description: "Returns unloaded, loading, ready, or failed. Ready includes required resource preparation.",
    pins: () => [pin("asset", "Asset", "in", assetRef("Asset")), pin("state", "State", "out", STRING)],
    codegen: ctx => ({ state: `ctx.getAssetLoadState(${ctx.input("asset")})` }),
  },
];
