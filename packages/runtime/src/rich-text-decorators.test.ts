import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { ActorComponent, EngineObject, type Actor } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import { RichTextDecorators, type RichTextDecorator } from "./rich-text-decorators";
import type { CompiledScript } from "./script-host";

/** A Rich Text Decorator Class: `tag` is Get Tag's returned expression, `decorate` Decorate's body (inputs are in scope). */
function decoratorClass(classId: string, parentClassId: string, { tag, decorate }: { tag?: string; decorate?: string }): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId, anchors: [],
    entryPoints: [
      ...(tag !== undefined ? [{ name: "Get_Tag", isAsync: false }] : []),
      ...(decorate !== undefined ? [{ name: "Decorate", isAsync: false }] : []),
    ],
    source: [
      tag !== undefined ? `export function Get_Tag(ctx) { return ${tag}; }` : "",
      decorate !== undefined ? `export function Decorate(ctx) { const { Value, Content, Component } = ctx.args; ${decorate} }` : "",
    ].join("\n"),
  };
}

/**
 * The Label Class owning the rich text: Refresh and Rename (to `ctx.args.name`) events, and an On Letter Shown handler
 * that appends each shown letter to its Shown variable.
 */
const LABEL_CLASS: CompiledScript = {
  assetGuid: "label", classId: "Label", parentClassId: "SceneLayerActor", anchors: [],
  entryPoints: [{ name: "Refresh", event: "Refresh", isAsync: false }, { name: "Rename", event: "Rename", isAsync: false },
    { name: "onLetterShown", event: "onLetterShown", isAsync: false, componentId: "rich" }],
  source: `
    export function Refresh(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "refreshText", {}); }
    export function Rename(ctx) { ctx.self.setVariable("playerName", ctx.args.name); }
    export function onLetterShown(ctx) { ctx.self.setVariable("shown", String(ctx.self.getVariable("shown") ?? "") + ctx.args.character); }`,
};

/** `[player]`: the Label's Player Name, "Nobody" before one is set. */
const PLAYER_TAG = decoratorClass("PlayerTag", "RichText2DDecorator", {
  tag: `{ Tag: " Player " }`,
  decorate: `return { Markup: String(Component.owner.getVariable("playerName") ?? "Nobody") };`,
});

/** A Play session whose Scene Layer holds the Label with a 2D Rich Text of `properties`. */
async function session(scripts: CompiledScript[], properties: Record<string, unknown>) {
  const commands: CommandMessage[] = [];
  const layer = createDefaultSceneLayer();
  layer.actors = [createActor("label", "Label", { classId: "Label", components: [
    { id: "rich", classId: "2DRichTextComponent", properties: { appearModes: ["fade"], appearStart: "revealed", ...properties } },
  ] })];
  const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
    playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: (command) => commands.push(command) });
  await runtime.loadScripts([LABEL_CLASS, ...scripts]);
  runtime.realizePlayWorld();
  const created = runtime.createSceneLayer("labels")!;
  runtime.start();
  const label = runtime.getWorld().findActor(`${created.guid}:label`)! as Actor;
  const rich = label.components.find((component) => component.classId === "2DRichTextComponent")!;
  /** Every text the renderer was sent for the rich text, in order. */
  const drawn = () => commands.flatMap((command) => command.type === "assignMesh"
    ? [command.text2d?.text, ...(command.parts ?? []).map((part) => part.text2d?.text)] : [])
    .filter((text): text is string => typeof text === "string");
  const warnings = () => commands.flatMap((command) => command.type === "log" && command.severity === "warning" ? [command.message] : []);
  return { runtime, commands, label, rich, drawn, warnings };
}

describe("Rich Text Decorators", () => {
  it("draws a Decorator's markup for its tag while the text stays authored, with Value, Content, Component and keywords", async () => {
    const item = decoratorClass("ItemTag", "RichText2DDecorator", {
      tag: `{ Tag: "item" }`,
      decorate: `return { Markup: "[color=orange]" + Content + "[/color]/" + Value + "/" + ctx.getRichTextTagValue("RARITY") + "/" +
        ctx.getRichTextTagValue("value") + "/" + Component.classId };`,
    });
    const authored = "Hi [player]! [item=sword Rarity=epic]Blade[/item]";
    const { runtime, rich, drawn } = await session([PLAYER_TAG, item], { text: authored });
    try {
      expect(drawn().at(-1)).toBe("Hi Nobody! [color=orange]Blade[/color]/sword/epic//2DRichTextComponent");
      expect(rich.getVariable("text")).toBe(authored);
    } finally { runtime.stop(); }
  });

  it("refuses a built-in tag, a tag name it cannot be, a latent Get Tag and a second Class with one tag", async () => {
    const { runtime, drawn, warnings } = await session([
      decoratorClass("AColor", "RichText2DDecorator", { tag: `{ Tag: "Color" }`, decorate: `return { Markup: "!" };` }),
      decoratorClass("BDup", "RichText2DDecorator", { tag: `{ Tag: "dup" }`, decorate: `return { Markup: "<B:" + Content + ">" };` }),
      decoratorClass("CDup", "RichText2DDecorator", { tag: `{ Tag: "DUP" }`, decorate: `return { Markup: "<C>" };` }),
      decoratorClass("DBad", "RichText2DDecorator", { tag: `{ Tag: "9lives" }`, decorate: `return { Markup: "!" };` }),
      decoratorClass("EWait", "RichText2DDecorator", { tag: `Promise.resolve({ Tag: "wait" })`, decorate: `return { Markup: "!" };` }),
      // Loud handles no tag itself; LoudChild names one and runs Loud's Decorate.
      decoratorClass("Loud", "RichText2DDecorator", { decorate: `return { Markup: Content.toUpperCase() };` }),
      decoratorClass("LoudChild", "Loud", { tag: `{ Tag: "loud" }` }),
    ], { text: "[color=red]x[/color] [dup]a[/dup] [9lives] [wait] [loud]hey[/loud]" });
    try {
      expect(drawn().at(-1)).toBe("[color=red]x[/color] <B:a> [9lives] [wait] HEY");
      expect(warnings()).toEqual([
        "Rich Text Decorator AColor cannot handle [color], a built-in tag.",
        "Rich Text Decorators BDup and CDup both handle the [dup] tag: BDup handles it.",
      ]);
    } finally { runtime.stop(); }
  });

  it("reveals the letters of the expanded text: its On Letter Shown letters and its duration", async () => {
    // "Nobody" has 6 letters 0.1 s apart that each take 0.1 s: 0.6 s, where the authored "[player]" would take 0.8 s.
    const { runtime, commands, label } = await session([PLAYER_TAG], {
      text: "[player]", appearStart: "play", appearTransition: "linear", appearInterval: 0.1, appearDuration: 0.1,
    });
    try {
      for (let i = 0; i < 3; i++) runtime.tick();
      expect(commands.filter((command) => command.type === "setText2DAppear").at(-1)).toMatchObject({ progress: 0.5 });
      for (let i = 0; i < 4; i++) runtime.tick();
      expect(label.getVariable("shown")).toBe("Nobody");
    } finally { runtime.stop(); }
  });

  it("expands again on Refresh Text, sending the text only when that changed it", async () => {
    const { runtime, label, drawn } = await session([PLAYER_TAG], { text: "Hi [player]!" });
    try {
      const sent = drawn().length;
      expect(drawn().at(-1)).toBe("Hi Nobody!");
      runtime.invokeScriptEvent("Label", "Refresh", label);
      expect(drawn()).toHaveLength(sent);
      // A changed value shows only once the text is refreshed.
      runtime.invokeScriptEvent("Label", "Rename", label, { name: "Ada" });
      runtime.tick();
      expect(drawn()).toHaveLength(sent);
      runtime.invokeScriptEvent("Label", "Refresh", label);
      expect(drawn().slice(sent)).toEqual(["Hi Ada!"]);
    } finally { runtime.stop(); }
  });

  it("expands every live text again when scripts reload, and draws the authored text once no Decorator is loaded", async () => {
    const { runtime, drawn } = await session([PLAYER_TAG], { text: "Hi [player]!" });
    try {
      runtime.tick();
      const sent = drawn().length;
      // Nothing it draws changed: nothing is sent.
      await runtime.replaceScriptSources([LABEL_CLASS, PLAYER_TAG]);
      expect(drawn()).toHaveLength(sent);
      await runtime.replaceScriptSources([LABEL_CLASS, decoratorClass("PlayerTag", "RichText2DDecorator", {
        tag: `{ Tag: "player" }`, decorate: `return { Markup: "Zed" };`,
      })]);
      expect(drawn().slice(sent)).toEqual(["Hi Zed!"]);
      await runtime.replaceScriptSources([LABEL_CLASS]);
      expect(drawn().slice(sent)).toEqual(["Hi Zed!", "Hi [player]!"]);
    } finally { runtime.stop(); }
  });

  it("runs the Letter Effects of the [fx] tags a Decorator's markup holds, on its letters", async () => {
    const { runtime, commands } = await session([
      decoratorClass("SpinTag", "RichText2DDecorator", { tag: `{ Tag: "spin" }`, decorate: `return { Markup: "[fx=Turn]" + Content + "[/fx]" };` }),
      { assetGuid: "turn", classId: "Turn", parentClassId: "RichText2DLetterEffect", anchors: [],
        entryPoints: [{ name: "onUpdateLetters", event: "onUpdateLetters", isAsync: false }],
        source: `export function onUpdateLetters(ctx) { for (const letter of ctx.args.letters) ctx.setVariableOn(letter, "rotation", 5); }` },
    ], { text: "a[spin]bc[/spin]" });
    try {
      runtime.tick();
      expect(Array.from(commands.filter((command) => command.type === "setText2DLetterPoses").at(-1)?.poses ?? [])).toEqual([
        0, 0, 1, 1, 0, 1, 1, 1, 1,
        0, 0, 1, 1, 5, 1, 1, 1, 1,
        0, 0, 1, 1, 5, 1, 1, 1, 1,
      ]);
    } finally { runtime.stop(); }
  });

  it("expands once more after a Decorate sets its own text, from the text then current", async () => {
    const { runtime, rich, drawn } = await session([decoratorClass("Once", "RichText2DDecorator", {
      tag: `{ Tag: "once" }`,
      decorate: `ctx.callComponentFunction(Component, "setText", { text: "[once]!" }); return { Markup: "A" };`,
    })], { text: "[once]" });
    try {
      expect(rich.getVariable("text")).toBe("[once]!");
      expect(drawn().at(-1)).toBe("A!");
    } finally { runtime.stop(); }
  });
});

describe("RichTextDecorators", () => {
  const component = (text: string) => new ActorComponent({ classId: "2DRichTextComponent", variables: { text } });
  /** A store with `tag`'s Decorator calling `decorate`, Get Tag Value reading the values it was handed. */
  function store(tag: string, decorate: RichTextDecorator["decorate"]) {
    const tagValues: Array<Record<string, string>> = [];
    const decorators = new RichTextDecorators({
      withTag: (_self, values, run) => { tagValues.push(Object.fromEntries(values)); return run(); },
    });
    decorators.load(new Map([[tag, { classId: "Tag", self: new EngineObject({ classId: "Tag" }), decorate }]]), []);
    return { decorators, tagValues };
  }

  it("keeps a text without custom tags as its own string, and is inactive with no Decorator loaded", () => {
    const text = "plain [b]text[/b]";
    const { decorators } = store("player", () => ({ Markup: "Ada" }));
    expect(decorators.active).toBe(true);
    expect(decorators.text(component(text), text)).toBe(text);
    decorators.load(new Map(), []);
    expect(decorators.active).toBe(false);
  });

  it("hands Get Tag Value every keyword of the tag being decorated", () => {
    const { decorators, tagValues } = store("item", ({ Value, Content }) => ({ Markup: `${String(Value)}:${String(Content)}` }));
    expect(decorators.text(component("x"), "[item=sword Rarity=epic Size=2]Blade[/item]")).toBe("sword:Blade");
    expect(tagValues).toEqual([{ rarity: "epic", size: "2" }]);
  });

  it("leaves the tag as written when Decorate has no string Markup", () => {
    const { decorators } = store("item", () => ({ Markup: 3 }));
    expect(decorators.text(component("x"), "[item]a")).toBe("[item]a");
  });

  it("expands a text whose Decorate keeps setting its text at most three more times", () => {
    let calls = 0;
    const rich = component("[grow]");
    const { decorators } = store("grow", () => {
      calls += 1;
      // A Set Text from Decorate: the new text is asked for while this expansion runs.
      const next = `${String(rich.getVariable("text"))}+`;
      rich.setVariable("text", next);
      expect(decorators.text(rich, next)).toBe(next);
      return { Markup: String(calls) };
    });
    expect(decorators.text(rich, "[grow]")).toBe("4+++");
    expect(calls).toBe(4);
  });
});
