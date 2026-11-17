import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@haptic/core";
import { isPlayEngineCommandType, type CommandMessage } from "@haptic/bridge";
import { Actor, ActorComponent, ClassRegistry, World } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import { Text2DAppearRuntime, type Text2DAppearHost, type Text2DAppearSoundEvent } from "./text2d-appear-runtime";

function text(variables: Record<string, unknown> = {}) {
  const actor = new Actor({ classId: "SceneLayerActor", sceneLayerId: "layer" });
  const component = new ActorComponent({ classId: "2DRichTextComponent", variables: {
    text: "[b]A[/b][img=icon][wave speed=2]B[/wave]", appearModes: ["fade"],
    appearStart: "hidden", appearInterval: 0.1, appearDuration: 0.3, ...variables,
  } });
  actor.attachComponent(component);
  return { actor, component };
}

/** `advance` walks a world's actors, so the standalone fixtures spawn into one. */
function worldOf(...actors: Actor[]): World {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  for (const actor of actors) world.spawnActorNow(actor);
  return world;
}

/** A host that handles `handled` component events and records each one the reveal runs, as `event:index+character`. */
function eventHost(handled: readonly string[]) {
  const fired: string[] = [];
  const queries: string[] = [];
  const host: Text2DAppearHost = {
    world: () => { throw new Error("no scripted letters here"); },
    invokeEvent: () => {},
    callFunction: () => null,
    handlesComponentEvent: (_component, event) => { queries.push(event); return handled.includes(event); },
    fireComponentEvent: (_component, event, args) => {
      fired.push(event === "onLetterShown" ? `${event}:${String(args.index)}${String(args.character)}` : event);
    },
  };
  /** The events run since the last call. */
  const take = () => fired.splice(0);
  return { host, take, queries };
}

const ALL_EVENTS = ["onLetterShown", "onAppearFinished", "onDisappearFinished"];

describe("2D rich text appearance runtime", () => {
  it("runs Letter Shown as each letter starts on a forward reveal, and the finish events once per arrival", () => {
    // Letters A, B and C at reveal indices 0, 1 and 3 start at 0, 0.25 and 0.75 s; the reveal lasts 1 s.
    const runtime = new Text2DAppearRuntime(), { actor, component } = text({
      text: "AB C", appearInterval: 0.25, appearDuration: 0.25, appearTransition: "linear",
    }), world = worldOf(actor);
    const { host, take } = eventHost(ALL_EVENTS);
    runtime.bind(host);
    const step = (seconds: number) => { runtime.advance(world, seconds, () => true); return take(); };
    runtime.execute(component, "play");
    expect(take()).toEqual([]);
    expect(step(0.125)).toEqual(["onLetterShown:0A"]);
    expect(step(0.25)).toEqual(["onLetterShown:1B"]);
    // Never on Play Reverse.
    runtime.execute(component, "playReverse");
    expect(step(0.125)).toEqual([]);
    // Resumed at 0.25 s: B starts at the resume position and shows again; A, before it, does not.
    runtime.execute(component, "play");
    expect(step(0.125)).toEqual(["onLetterShown:1B"]);
    expect(step(1)).toEqual(["onLetterShown:3C", "onAppearFinished"]);
    // Already fully revealed: Play does nothing.
    runtime.execute(component, "play");
    expect(step(1)).toEqual([]);
    runtime.execute(component, "playReverse");
    expect(step(0.5)).toEqual([]);
    expect(step(1)).toEqual(["onDisappearFinished"]);
    runtime.execute(component, "playReverse");
    expect(step(1)).toEqual([]);
    // Trigger Appear starts over from a fully revealed text too.
    runtime.execute(component, "play");
    step(2);
    runtime.execute(component, "triggerAppear");
    expect(step(2)).toEqual(["onLetterShown:0A", "onLetterShown:1B", "onLetterShown:3C", "onAppearFinished"]);
  });

  it("queues an instant finish to the next reveal step and shows no letters while Appear Modes is Off", () => {
    const runtime = new Text2DAppearRuntime(), { actor, component } = text({ text: "AB", appearModes: [] }), world = worldOf(actor);
    const { host, take } = eventHost(ALL_EVENTS);
    runtime.bind(host);
    const step = () => { runtime.advance(world, 0.1, () => true); return take(); };
    runtime.execute(component, "play");
    expect(runtime.progress(component)).toBe(1);
    // Scripts call Play, so its events wait for the reveal step.
    expect(take()).toEqual([]);
    expect(step()).toEqual(["onAppearFinished"]);
    expect(step()).toEqual([]);
    runtime.execute(component, "play");
    expect(step()).toEqual([]);
    runtime.execute(component, "playReverse");
    runtime.execute(component, "triggerAppear");
    expect(step()).toEqual(["onDisappearFinished", "onAppearFinished"]);
  });

  it("runs nothing the owner does not handle, asks once per play, and never for the starting state", () => {
    const runtime = new Text2DAppearRuntime(), revealed = text({ text: "AB", appearStart: "revealed" }), hidden = text({ text: "AB" });
    const world = worldOf(revealed.actor, hidden.actor);
    const { host, take, queries } = eventHost([]);
    runtime.bind(host);
    runtime.advance(world, 1, () => true);
    expect(queries).toEqual([]);
    runtime.execute(hidden.component, "play");
    for (let tick = 0; tick < 10; tick++) runtime.advance(world, 0.1, () => true);
    expect(runtime.progress(hidden.component)).toBe(1);
    expect(take()).toEqual([]);
    // One Letter Shown query when the play starts, one finish query when it ends: none per tick.
    expect(queries).toEqual(["onLetterShown", "onAppearFinished"]);
  });

  it("reverses from the current position and preserves it through text, timing, and style edits", () => {
    const runtime = new Text2DAppearRuntime(), { actor, component } = text(), world = worldOf(actor);
    expect(runtime.progress(component)).toBe(0);
    runtime.execute(component, "play");
    runtime.advance(world, 0.2, () => true);
    // Three formatted characters: two 0.1-second intervals and a 0.3-second transition.
    expect(runtime.progress(component)).toBeCloseTo(0.4);
    component.setVariable("text", "ABCDE");
    component.setVariable("appearInterval", 0);
    component.setVariable("appearDuration", 0.5);
    component.setVariable("color", [0, 1, 0]);
    runtime.refresh(component);
    expect(runtime.progress(component)).toBeCloseTo(0.4);
    runtime.execute(component, "playReverse");
    runtime.advance(world, 0.1, () => true);
    expect(runtime.progress(component)).toBeCloseTo(0.2);
    runtime.advance(world, 1, () => true);
    expect(runtime.progress(component)).toBe(0);
    runtime.execute(component, "play");
    runtime.advance(world, 1, () => true);
    expect(runtime.progress(component)).toBe(1);
    runtime.execute(component, "triggerAppear");
    expect(runtime.progress(component)).toBe(0);
    runtime.advance(world, 0.25, () => true);
    expect(runtime.progress(component)).toBe(0.5);
  });

  it("advances auto-play only for ready owners and sends no update for destroyed components", () => {
    const runtime = new Text2DAppearRuntime(), ready = text({ appearStart: "play" }), waiting = text({ appearStart: "play" });
    const world = worldOf(ready.actor, waiting.actor);
    runtime.advance(world, 0.25, (actor) => actor === ready.actor);
    expect(runtime.progress(ready.component)).toBe(0.5);
    expect(runtime.progress(waiting.component)).toBe(0);
    ready.component.destroyed = true;
    const updates: number[] = [];
    runtime.flush((_component, progress) => updates.push(progress));
    expect(updates).toEqual([]);
    runtime.advance(world, 0.5, () => true);
    expect(runtime.progress(waiting.component)).toBe(1);
  });

  it("finishes disabled animations synchronously and does not leave zero-character text playing", () => {
    for (const variables of [{ appearModes: [] }, { text: "[b][/b]" }]) {
      const runtime = new Text2DAppearRuntime(), { component } = text(variables);
      runtime.execute(component, "play");
      expect(runtime.progress(component)).toBe(1);
      runtime.execute(component, "playReverse");
      expect(runtime.progress(component)).toBe(0);
      runtime.execute(component, "triggerAppear");
      expect(runtime.progress(component)).toBe(1);
    }
  });

  it("plays the appear sound per letter on a forward reveal only, without replaying earlier letters", () => {
    // Four letters at 0.1 s steps, each sounding 0.05 s after it starts appearing.
    const runtime = new Text2DAppearRuntime(), { actor, component } = text({
      text: "ABCD", appearSound: true, appearSoundAssetGuid: "beep", appearSoundOffset: 0.05,
    }), world = worldOf(actor);
    const plays = () => {
      const events: Text2DAppearSoundEvent[] = [];
      runtime.flush(() => {}, (event) => events.push(event));
      return events.map((event) => event.type === "play" ? `${event.assetGuid}${event.loop ? ":loop" : ""}` : "stop");
    };
    runtime.execute(component, "play");
    runtime.advance(world, 0.04, () => true);
    expect(plays()).toEqual([]);
    runtime.advance(world, 0.12, () => true);
    expect(plays()).toEqual(["beep", "beep"]);
    runtime.execute(component, "playReverse");
    runtime.advance(world, 0.06, () => true);
    expect(plays()).toEqual([]);
    // Resumes at 0.1 s: A (0.05 s) is not replayed; B, C and D (0.15, 0.25 and 0.35 s) sound as they reappear.
    runtime.execute(component, "play");
    runtime.advance(world, 0.3, () => true);
    expect(plays()).toEqual(["beep", "beep", "beep"]);
    runtime.advance(world, 1, () => true);
    expect(plays()).toEqual([]);
    // A fully revealed text has nothing left to sound.
    runtime.execute(component, "play");
    runtime.advance(world, 1, () => true);
    expect(plays()).toEqual([]);
    component.setVariable("appearSoundPlay", "once");
    component.setVariable("appearSoundOffset", 0.7);
    runtime.execute(component, "triggerAppear");
    // The offset outlasts the 0.6 s reveal: the sound still plays after the text is fully revealed.
    runtime.advance(world, 0.65, () => true);
    expect(runtime.progress(component)).toBe(1);
    expect(plays()).toEqual([]);
    runtime.advance(world, 0.1, () => true);
    expect(plays()).toEqual(["beep"]);
  });

  it("loops the appear sound until the reveal finishes and stops it on reverse, edits and removal", () => {
    const runtime = new Text2DAppearRuntime(), { actor, component } = text({
      text: "ABCD", appearSound: true, appearSoundAssetGuid: "hum", appearSoundPlay: "loop",
    }), world = worldOf(actor);
    const events = () => {
      const seen: Text2DAppearSoundEvent[] = [];
      runtime.flush(() => {}, (event) => seen.push(event));
      return seen.map((event) => event.type === "play" ? { play: event.assetGuid, loop: event.loop, voiceId: event.voiceId } : { stop: event.voiceId });
    };
    const voiceId = `${component.guid}:appearSound`;
    runtime.execute(component, "play");
    runtime.advance(world, 0.1, () => true);
    expect(events()).toEqual([{ play: "hum", loop: true, voiceId }]);
    runtime.advance(world, 0.3, () => true);
    expect(events()).toEqual([]);
    runtime.advance(world, 0.3, () => true);
    expect(runtime.progress(component)).toBe(1);
    expect(events()).toEqual([{ stop: voiceId }]);
    for (const interrupt of [
      () => runtime.execute(component, "playReverse"),
      () => { component.setVariable("appearSound", false); runtime.refresh(component); component.setVariable("appearSound", true); },
      () => runtime.remove(component),
    ]) {
      runtime.execute(component, "triggerAppear");
      runtime.advance(world, 0.1, () => true);
      expect(events()).toEqual([{ play: "hum", loop: true, voiceId }]);
      interrupt();
      expect(events()).toEqual([{ stop: voiceId }]);
      runtime.advance(world, 1, () => true);
      expect(events()).toEqual([]);
    }
  });

  it("publishes live graph getters and component updates without rebuilding meshes on each tick", async () => {
    const commands: CommandMessage[] = [];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "LabelActor", components: [
      { id: "rich", classId: "2DRichTextComponent", properties: {
        text: "[b]A[/b][img=icon]B", appearModes: ["fade", "scale"], appearStart: "hidden", appearDuration: 0.3, appearInterval: 0.1,
      } },
      { id: "other", classId: "2DRichTextComponent", properties: { text: "Other" } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "label-script", classId: "LabelActor", parentClassId: "SceneLayerActor", anchors: [],
        entryPoints: ["Play", "Reverse", "Restart", "Edit", "onTick"].map((name) => ({ name, event: name, isAsync: false })),
        source: `
          export function Play(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "play", {}); }
          export function Reverse(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "playReverse", {}); }
          export function Restart(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "triggerAppear", {}); }
          export function Edit(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "rich"), "color", [1, 0, 0]); }
          export function onTick(ctx) {
            const c = ctx.getComponentById(ctx.self, "rich");
            ctx.setVariable("progress", ctx.getVariableFrom(c, "appearProgress"));
            ctx.setVariable("revealed", ctx.getVariableFrom(c, "isRevealed"));
          }`,
      }]);
      runtime.realizePlayWorld(); const layer = runtime.createSceneLayer("labels")!; runtime.start();
      const actor = runtime.getWorld().findActor(`${layer.guid}:label`)!;
      const assignments = () => commands.filter((command) => command.type === "assignMesh");
      const initialAssignments = assignments().length;
      runtime.invokeScriptEvent("LabelActor", "Play", actor);
      runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.2);
      expect(actor.getVariable("revealed")).toBe(false);
      expect(assignments()).toHaveLength(initialAssignments);
      const updates = commands.filter((command) => command.type === "setText2DAppear");
      expect(updates.at(-1)).toMatchObject({ componentId: "rich", progress: 0.2 });
      expect(updates.every((command) => command.componentId === "rich")).toBe(true);
      expect(isPlayEngineCommandType("setText2DAppear")).toBe(true);
      runtime.pause(); runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.2);
      runtime.resume();
      runtime.invokeScriptEvent("LabelActor", "Edit", actor);
      expect(assignments().at(-1)).toMatchObject({ parts: [
        { componentId: "rich", text2d: { appearProgress: 0.2, color: [1, 0, 0] } },
        { componentId: "other", text2d: { appearProgress: 1 } },
      ] });
      for (let i = 0; i < 4; i++) runtime.tick();
      expect(actor.getVariable("progress")).toBe(1);
      expect(actor.getVariable("revealed")).toBe(true);
      runtime.invokeScriptEvent("LabelActor", "Reverse", actor); runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.8);
      expect(actor.getVariable("revealed")).toBe(false);
      runtime.invokeScriptEvent("LabelActor", "Restart", actor);
      expect(commands.filter((command) => command.type === "setText2DAppear").at(-1)).toMatchObject({ progress: 0 });
    } finally { runtime.stop(); }
  });

  it("runs custom Appear Modes per letter as the reveal moves and Decorator Effects every tick on the tagged letters", async () => {
    const commands: CommandMessage[] = [];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "SceneLayerActor", components: [
      { id: "rich", classId: "2DRichTextComponent", properties: {
        text: "A[fx=Tilt strength=3]BC[/fx]", appearModes: ["class:Rise", "class:Missing"], appearTransition: "linear",
        appearStart: "play", appearInterval: 0.1, appearDuration: 0.2,
      } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([
        { assetGuid: "rise", classId: "Rise", parentClassId: "RichText2DAppearMode", anchors: [],
          entryPoints: [{ name: "onLetterAppear", event: "onLetterAppear", isAsync: false }],
          // Offset Y rises 10 px as the letter appears; its Index and Character are readable.
          source: `export function onLetterAppear(ctx) {
            const { letter, alpha } = ctx.args;
            ctx.setVariableOn(letter, "offset", { x: ctx.getVariableFrom(letter, "index"), y: 10 * alpha });
            ctx.setVariableOn(letter, "opacity", ctx.getVariableFrom(letter, "character") === "A" ? 0.5 : 1);
          }` },
        { assetGuid: "tilt", classId: "Tilt", parentClassId: "RichText2DDecoratorEffect", anchors: [],
          entryPoints: [{ name: "onDecorateLetters", event: "onDecorateLetters", isAsync: false }],
          // Adds to what the Appear Mode left: Rotation is the tag Strength, Scale X grows with Delta Seconds.
          source: `export function onDecorateLetters(ctx) {
            for (const letter of ctx.args.letters) {
              ctx.setVariableOn(letter, "rotation", ctx.args.strength);
              ctx.setVariableOn(letter, "scale", { x: 1 + ctx.args.deltaSeconds, y: 1 });
            }
          }` },
      ]);
      runtime.realizePlayWorld(); runtime.createSceneLayer("labels"); runtime.start();
      const poses = () => commands.filter((command) => command.type === "setText2DLetterPoses").at(-1)?.poses.map((value) => Number(value.toFixed(6)));
      runtime.tick();
      // 0.1 s into a 0.4 s reveal: A is half revealed, B starts, C has not.
      expect(poses()).toEqual([
        0, 5, 1, 1, 0, 0.5, 1, 1, 1,
        1, 0, 1.1, 1, 3, 1, 1, 1, 1,
        2, 0, 1.1, 1, 3, 1, 1, 1, 1,
      ]);
      runtime.tick();
      expect(poses()).toEqual([
        0, 10, 1, 1, 0, 0.5, 1, 1, 1,
        1, 5, 1.1, 1, 3, 1, 1, 1, 1,
        2, 0, 1.1, 1, 3, 1, 1, 1, 1,
      ]);
      expect(isPlayEngineCommandType("setText2DLetterPoses")).toBe(true);
      for (let i = 0; i < 4; i++) runtime.tick();
      const sent = commands.filter((command) => command.type === "setText2DLetterPoses").length;
      // Fully revealed and unchanged: nothing more is sent, and a rebuilt visual starts from the same poses.
      runtime.tick();
      expect(commands.filter((command) => command.type === "setText2DLetterPoses")).toHaveLength(sent);
      const label = runtime.getWorld().getActors().find((actor) => actor.components.some((component) => component.guid.endsWith("rich")))!;
      const rich = label.components.find((component) => component.classId === "2DRichTextComponent")!;
      expect(poses()).toEqual([0, 10, 1, 1, 0, 0.5, 1, 1, 1, 1, 10, 1.1, 1, 3, 1, 1, 1, 1, 2, 10, 1.1, 1, 3, 1, 1, 1, 1]);
      // Text without scripted Classes returns every letter to rest.
      rich.setVariable("appearModes", ["fade"]);
      rich.setVariable("text", "ABC");
      runtime.tick();
      expect(poses()).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("runs the rich text's component events on its owner after the reveal moved", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "LabelActor", components: [
      { id: "rich", classId: "2DRichTextComponent", properties: {
        text: "A B", appearModes: ["fade"], appearStart: "play", appearInterval: 0.25, appearDuration: 0.25,
      } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.125, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: () => {} });
    try {
      const bound = (name: string) => ({ name, event: name, isAsync: false, componentId: "rich" });
      await runtime.loadScripts([{ assetGuid: "label-script", classId: "LabelActor", parentClassId: "SceneLayerActor", anchors: [],
        entryPoints: [bound("onLetterShown"), bound("onAppearFinished"), bound("onDisappearFinished"),
          { name: "Reverse", event: "Reverse", isAsync: false }],
        source: `
          const log = (ctx, entry) => ctx.self.setVariable("log", String(ctx.self.getVariable("log") ?? "") + entry);
          const progress = (ctx) => ctx.getVariableFrom(ctx.getComponentById(ctx.self, "rich"), "appearProgress");
          export function onLetterShown(ctx) { log(ctx, ctx.args.character + ctx.args.index + " "); }
          export function onAppearFinished(ctx) { log(ctx, "appeared@" + progress(ctx) + " "); }
          export function onDisappearFinished(ctx) { log(ctx, "hidden@" + progress(ctx)); }
          export function Reverse(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "playReverse", {}); }`,
      }]);
      runtime.realizePlayWorld(); const created = runtime.createSceneLayer("labels")!; runtime.start();
      const actor = runtime.getWorld().findActor(`${created.guid}:label`)!;
      const log = () => actor.getVariable("log") ?? "";
      // A starts at 0 s and B (index 2) at 0.5 s of a 0.75 s reveal, in 0.125 s ticks.
      runtime.tick();
      expect(log()).toBe("A0 ");
      for (let i = 0; i < 4; i++) runtime.tick();
      expect(log()).toBe("A0 B2 ");
      runtime.tick();
      expect(log()).toBe("A0 B2 appeared@1 ");
      runtime.invokeScriptEvent("LabelActor", "Reverse", actor);
      for (let i = 0; i < 6; i++) runtime.tick();
      expect(log()).toBe("A0 B2 appeared@1 hidden@0");
    } finally { runtime.stop(); }
  });

  it("groups a Decorator Effect's letters by the values of the keys its Get Keys declares, called once per build", async () => {
    const commands: CommandMessage[] = [];
    const layer = createDefaultSceneLayer();
    const markup = "[fx=Wave speed=2 height=4 mood=a]AB[/fx][fx=Wave speed=2 height=4 mood=b]C[/fx][fx=Wave speed=3 HEIGHT=4]D[/fx]";
    layer.actors = [createActor("label", "Label", { classId: "SceneLayerActor", components: [
      { id: "rich", classId: "2DRichTextComponent", properties: { text: markup } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([
        { assetGuid: "wave", classId: "Wave", parentClassId: "RichText2DDecoratorEffect", anchors: [],
          // A Class function is an entry point without an event, exported under its compiled name.
          entryPoints: [{ name: "onDecorateLetters", event: "onDecorateLetters", isAsync: false }, { name: "Get_Keys", isAsync: false }],
          // Declares Speed and Height (Mood is not); counts its calls; reads a tag value outside any decorate call.
          source: `
          export function Get_Keys(ctx) {
            ctx.self.setVariable("calls", Number(ctx.self.getVariable("calls") ?? 0) + 1);
            ctx.self.setVariable("outside", ctx.getRichTextTagValue("speed"));
            return { Keys: ["Speed", "height", "speed", 7] };
          }
          export function onDecorateLetters(ctx) {
            for (const letter of ctx.args.letters) {
              ctx.setVariableOn(letter, "rotation", Number(ctx.getRichTextTagValue("SPEED")));
              ctx.setVariableOn(letter, "offset", { x: Number(ctx.getRichTextTagValue("height")), y: ctx.args.letters.length });
              ctx.setVariableOn(letter, "scale", { x: 1, y: ctx.self.getVariable("calls") });
              ctx.setVariableOn(letter, "opacity", ctx.getRichTextTagValue("mood") === "" && ctx.self.getVariable("outside") === "" ? 1 : 0);
              if (ctx.getVariableFrom(letter, "character") === "D") ctx.setVariableOn(letter, "tint", { x: 0.5, y: 2, z: -1, w: 0 });
            }
          }` },
      ]);
      runtime.realizePlayWorld(); runtime.createSceneLayer("labels"); runtime.start();
      const poses = () => commands.filter((command) => command.type === "setText2DLetterPoses").at(-1)?.poses;
      for (let i = 0; i < 3; i++) runtime.tick();
      // A, B and C share Speed 2 and Height 4 (their Moods differ but Mood is not declared): one call of three letters.
      // D has Speed 3: a call of its own, with its Tint clamped to 0..1.
      expect(poses()).toEqual([
        4, 3, 1, 1, 2, 1, 1, 1, 1,
        4, 3, 1, 1, 2, 1, 1, 1, 1,
        4, 3, 1, 1, 2, 1, 1, 1, 1,
        4, 1, 1, 1, 3, 1, 0.5, 1, 0,
      ]);
      // A new text builds again, and Get Keys runs once more.
      const label = runtime.getWorld().getActors().find((actor) => actor.components.some((component) => component.guid.endsWith("rich")))!;
      label.components.find((component) => component.classId === "2DRichTextComponent")!.setVariable("text", `${markup}E`);
      for (let i = 0; i < 3; i++) runtime.tick();
      expect(poses()?.slice(0, 9)).toEqual([4, 3, 1, 2, 2, 1, 1, 1, 1]);
      expect(poses()?.slice(36)).toEqual([0, 0, 1, 1, 0, 1, 1, 1, 1]);
    } finally { runtime.stop(); }
  });
});
