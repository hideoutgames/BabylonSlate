import { describe, expect, it, vi } from "vitest";
import { InfiniteLoopError } from "@babylonslate/debugger";
import { Actor, ActorComponent, InterfaceRegistry, type TickContext } from "@babylonslate/object-model";
import { ScriptHost, type CompiledScript, type ScriptHostServices } from "./script-host";

function services(extras: Partial<ScriptHostServices> = {}): ScriptHostServices {
  return {
    log: () => {},
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {},
    reportError: () => {},
    ...extras,
  };
}

function script(
  classId: string,
  source: string,
  extra: Partial<CompiledScript> = {},
): CompiledScript {
  return { assetGuid: `${classId}-asset`, classId, source, anchors: [], entryPoints: [], ...extra };
}

const tick: TickContext = {
  dt: 0.25,
  tickIndex: 7,
  world: { rngNextFloat: () => 0 },
  isActionHeld: (action) => action === "Jump",
};

function interfaces(outputs: Record<string, unknown> = {}): InterfaceRegistry {
  const registry = new InterfaceRegistry();
  registry.register({ guid: "probe", name: "Probe", methods: [{ name: "Probe", outputs }] });
  return registry;
}

describe("ScriptHost nested dispatch", () => {
  it("runs a called custom event and an interface handler inside the caller's frame", async () => {
    const host = new ScriptHost(services({ interfaceRegistry: interfaces() }));
    await host.load(script("Hero", [
      "export function onTick(ctx) { ctx.invokeCustomEvent(ctx.self, 'OnPing', {}); ctx.callInterface(ctx.self, 'probe', 'Probe', {}); }",
      "export function OnPing(ctx) { ctx.self.setVariable('event', [ctx.deltaSeconds, ctx.tickIndex, ctx.isActionHeld('Jump')]); }",
      "export function Probe(ctx) { ctx.self.setVariable('handler', [ctx.deltaSeconds, ctx.tickIndex, ctx.isActionHeld('Jump')]); return {}; }",
    ].join("\n"), {
      entryPoints: [
        { name: "onTick", event: "onTick", isAsync: false },
        { name: "OnPing", event: "OnPing", isAsync: false },
      ],
      interfaceImplementations: [{ interfaceGuid: "probe", method: "Probe", exportName: "Probe" }],
    }));
    const hero = new Actor({ classId: "Hero", implementedInterfaces: ["probe"] });
    host.bindInterfaceHandlers(hero);

    host.hooksFor("Hero")!.onTick!(hero, tick);

    expect(hero.getVariable("event")).toEqual([0.25, 7, true]);
    expect(hero.getVariable("handler")).toEqual([0.25, 7, true]);
  });

  it("aborts the tick when an interface handler or animation rule exceeds the loop guard", async () => {
    const reportError = vi.fn();
    const host = new ScriptHost(services({
      interfaceRegistry: interfaces(),
      reportError,
      checkInfiniteLoop: () => { throw new InfiniteLoopError(); },
    }));
    await host.replaceScripts([
      script("Hero", [
        "export function onTick(ctx) { ctx.callInterface(ctx.self, 'probe', 'Probe', {}); ctx.self.setVariable('after', true); }",
        "export function Probe(ctx) { ctx.checkInfiniteLoop(); return {}; }",
      ].join("\n"), {
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
        interfaceImplementations: [{ interfaceGuid: "probe", method: "Probe", exportName: "Probe" }],
      }),
      script("Rule", "export function evaluate(ctx) { ctx.checkInfiniteLoop(); return { enter: true }; }"),
    ]);
    const hero = new Actor({ classId: "Hero", implementedInterfaces: ["probe"] });
    host.bindInterfaceHandlers(hero);

    expect(() => host.hooksFor("Hero")!.onTick!(hero, tick)).toThrow(InfiniteLoopError);
    expect(hero.getVariable("after")).toBeUndefined();
    expect(() => host.invokeAnimRule("Rule", hero)).toThrow(InfiniteLoopError);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("never runs a member call on the running object when its receiver is null", async () => {
    const host = new ScriptHost(services({ interfaceRegistry: interfaces({ value: 5 }) }));
    await host.load(script("Hero", [
      "export function onTick(ctx) {",
      "  ctx.invokeCustomEvent(null, 'OnPing', {});",
      "  ctx.invokeFunction(null, 'Jump', {});",
      "  ctx.setVariableOn(null, 'hp', 99);",
      "  ctx.self.setVariable('read', [ctx.getVariableFrom(null, 'hp'), ctx.getComponentById(null, 'mesh'), ctx.callComponentFunction(null, 'play', {})]);",
      "  ctx.self.setVariable('interface', ctx.callInterface(undefined, 'probe', 'Probe', {}));",
      "}",
      "export function OnPing(ctx) { ctx.self.setVariable('ping', true); }",
      "export function Jump(ctx) { ctx.self.setVariable('jumped', true); return {}; }",
      "export function Probe(ctx) { ctx.self.setVariable('probed', true); return { value: 1 }; }",
    ].join("\n"), {
      entryPoints: [
        { name: "onTick", event: "onTick", isAsync: false },
        { name: "OnPing", event: "OnPing", isAsync: false },
      ],
      interfaceImplementations: [{ interfaceGuid: "probe", method: "Probe", exportName: "Probe" }],
    }));
    const hero = new Actor({ classId: "Hero", implementedInterfaces: ["probe"] });
    hero.setVariable("hp", 10);
    host.bindInterfaceHandlers(hero);

    host.hooksFor("Hero")!.onTick!(hero, tick);

    expect(hero.getVariable("ping")).toBeUndefined();
    expect(hero.getVariable("jumped")).toBeUndefined();
    expect(hero.getVariable("probed")).toBeUndefined();
    expect(hero.getVariable("hp")).toBe(10);
    expect(hero.getVariable("read")).toEqual([undefined, null, {}]);
    expect(hero.getVariable("interface")).toEqual({ value: 5 });
  });

  it("logs a null access as an error through the host log, and never throws", () => {
    const logged: unknown[][] = [];
    const host = new ScriptHost(services({ log: (...args) => { logged.push(args); } }));
    const { nullAccess } = host.createContext(null, 0, 0);

    nullAccess("Hero: Destroy Actor (Target) tried to access null.");
    nullAccess("Hero: Destroy Actor (Target) tried to access null.");

    // Every occurrence is reported; nothing collapses repeats.
    expect(logged).toEqual([
      ["error", "Script", "Hero: Destroy Actor (Target) tried to access null."],
      ["error", "Script", "Hero: Destroy Actor (Target) tried to access null."],
    ]);
  });

  it("returns the method's pin defaults when Call Interface has no receiver", () => {
    const host = new ScriptHost(services({ interfaceRegistry: interfaces({ value: 5 }) }));
    expect(host.createContext(null, 0, 0).callInterface(null, "probe", "Probe")).toEqual({ value: 5 });
  });

  it("runs a function in every module of its class, awaiting a latent one first", async () => {
    const host = new ScriptHost(services());
    await host.replaceScripts([
      script("MathLib", "export async function Add(ctx) { await ctx.delay(0); ctx.args.log.push('a'); return { value: 1 }; }",
        { assetGuid: "math-a" }),
      script("MathLib", "export function Add(ctx) { ctx.args.log.push('b'); return { value: 2 }; }",
        { assetGuid: "math-b" }),
    ]);
    const log: string[] = [];

    const result = await host.createContext(null, 0, 0).invokeFunction("MathLib", "Add", { log });

    expect(log).toEqual(["a", "b"]);
    expect(result).toEqual({ value: 2 });
  });

  it("lets hooks held across a script reload run the new scripts, and offers none once the class loses them", async () => {
    const host = new ScriptHost(services());
    const beginPlay = { name: "onBeginPlay", event: "onBeginPlay", isAsync: false };
    const onTick = { name: "onTick", event: "onTick", isAsync: false };
    await host.replaceScripts([script("Hero", "export function onBeginPlay(ctx) { ctx.self.setVariable('began', 1); }", { entryPoints: [beginPlay] })]);
    const hero = new Actor({ classId: "Hero" });
    const held = host.hooksFor("Hero")!;
    held.onTick!(hero, tick);
    expect(hero.getVariable("ticked")).toBeUndefined();

    await host.replaceScripts([script("Hero", "export function onTick(ctx) { ctx.self.setVariable('ticked', 2); }", { entryPoints: [onTick] })]);
    held.onTick!(hero, tick);
    expect(hero.getVariable("ticked")).toBe(2);

    await host.replaceScripts([]);
    hero.setVariable("ticked", 0);
    held.onTick!(hero, tick);
    expect(hero.getVariable("ticked")).toBe(0);
    expect(host.hooksFor("Hero")).toBeUndefined();
  });

  it("keeps a static library's Do Once state per calling object", async () => {
    const host = new ScriptHost(services());
    await host.load(script("FlowLib", [
      "export function Once(ctx) {",
      "  const state = ctx.flowState('once');",
      "  if (state.done) return { fired: false };",
      "  state.done = true;",
      "  return { fired: true };",
      "}",
    ].join("\n")));
    const first = host.createContext(new Actor({ classId: "Hero" }), 0, 0);
    const second = host.createContext(new Actor({ classId: "Hero" }), 0, 0);

    expect(first.invokeFunction("FlowLib", "Once")).toEqual({ fired: true });
    expect(first.invokeFunction("FlowLib", "Once")).toEqual({ fired: false });
    expect(second.invokeFunction("FlowLib", "Once")).toEqual({ fired: true });
  });
});

describe("ScriptHost console commands", () => {
  it("keeps each command's reported result when it runs a nested command", async () => {
    const host: ScriptHost = new ScriptHost(services({ executeConsoleCommand: (command) => host.invokeCommand(command, {}) }));
    await host.replaceScripts([
      script("Outer", "export function onCommandRun(ctx) { ctx.reportCommand(true, 'outer'); ctx.executeConsoleCommand('Inner'); }",
        { entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: false }] }),
      script("Inner", "export function onCommandRun(ctx) { ctx.reportCommand(false, 'inner'); }",
        { entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: false }] }),
    ]);

    expect(host.invokeCommand("Outer", {})).toEqual({ success: true, output: "outer" });
  });

  it("fails a command whose handler throws", async () => {
    const reportError = vi.fn();
    const host = new ScriptHost(services({ reportError }));
    await host.load(script("Broken", "export function onCommandRun() { throw new Error('boom'); }",
      { entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: false }] }));

    expect(host.invokeCommand("Broken", {})).toEqual({ success: false, output: "boom" });
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe("ScriptHost actor and component writes", () => {
  it("ignores transform writes with non-finite values, a missing rotator, or a destroyed actor", () => {
    const teleportActor = vi.fn();
    const host = new ScriptHost(services({ teleportActor }));
    const actor = new Actor({ classId: "Hero" });
    const ctx = host.createContext(actor, 0, 0);
    const before = structuredClone(actor.transform);

    ctx.setActorLocation(actor, { x: Number.NaN, y: 0, z: 0 });
    ctx.addActorWorldOffset(actor, { x: Number.POSITIVE_INFINITY, y: 0, z: 0 });
    ctx.setActorRotation(actor, null as never);
    ctx.setActorScale(actor, { x: 1, y: Number.NaN, z: 1 });
    ctx.setActorTransform(actor, { position: { x: 1, y: 2, z: 3 }, scale: { x: Number.NaN, y: 1, z: 1 } });
    actor.destroyed = true;
    ctx.setActorLocation(actor, { x: 1, y: 2, z: 3 });

    expect(actor.transform).toEqual(before);
    expect(teleportActor).not.toHaveBeenCalled();
  });

  it("keeps the current parent and owner when Attach Actor or Set Owner names a destroyed actor", () => {
    const attachToBone = vi.fn();
    const host = new ScriptHost(services({ attachToBone }));
    const child = new Actor({ classId: "Hero" });
    const parent = new Actor({ classId: "Hero" });
    const stale = new Actor({ classId: "Hero" });
    stale.destroyed = true;
    const ctx = host.createContext(child, 0, 0);
    ctx.attachActor(child, parent);
    ctx.setOwner(child, parent);
    attachToBone.mockClear();

    ctx.attachActor(child, stale);
    ctx.setOwner(child, stale);

    expect(child.getVariable("parentId")).toBe(parent.guid);
    expect(child.getVariable("ownerId")).toBe(parent.guid);
    expect(attachToBone).not.toHaveBeenCalled();
  });

  it("fires On Text Changed once when its handler sets the same text again", async () => {
    const host = new ScriptHost(services());
    await host.load(script("Hero", [
      "export function onTextChanged(ctx) {",
      "  ctx.self.setVariable('changes', (ctx.self.getVariable('changes') ?? 0) + 1);",
      "  ctx.callComponentFunction(ctx.getComponentById(ctx.self, 'label'), 'setText', { text: ctx.args.text });",
      "}",
    ].join("\n"), {
      entryPoints: [{ name: "onTextChanged", event: "onTextChanged", isAsync: false, componentId: "label" }],
    }));
    const hero = new Actor({ classId: "Hero" });
    const label = new ActorComponent({ classId: "Text3DComponent", guid: "label" });
    hero.attachComponent(label);

    host.createContext(hero, 0, 0).callComponentFunction(label, "setText", { text: "Hi" });

    expect(label.getVariable("text")).toBe("Hi");
    expect(hero.getVariable("changes")).toBe(1);
  });

  it("applies a different text set inside On Text Changed without firing it again", async () => {
    const host = new ScriptHost(services());
    await host.load(script("Hero", [
      "export function onTextChanged(ctx) {",
      "  ctx.self.setVariable('changes', (ctx.self.getVariable('changes') ?? 0) + 1);",
      "  ctx.callComponentFunction(ctx.getComponentById(ctx.self, 'label'), 'setText', { text: ctx.args.text + '!' });",
      "}",
    ].join("\n"), {
      entryPoints: [{ name: "onTextChanged", event: "onTextChanged", isAsync: false, componentId: "label" }],
    }));
    const hero = new Actor({ classId: "Hero" });
    const label = new ActorComponent({ classId: "Text3DComponent", guid: "label" });
    hero.attachComponent(label);
    const ctx = host.createContext(hero, 0, 0);

    ctx.callComponentFunction(label, "setText", { text: "Hi" });
    expect(label.getVariable("text")).toBe("Hi!");
    expect(hero.getVariable("changes")).toBe(1);

    // The guard lasts only for the running handler: a later write fires again.
    ctx.callComponentFunction(label, "setText", { text: "Bye" });
    expect(label.getVariable("text")).toBe("Bye!");
    expect(hero.getVariable("changes")).toBe(2);
  });

  it("refuses native component calls on a destroyed component", () => {
    const playSound = vi.fn();
    const host = new ScriptHost(services({ playSound }));
    const hero = new Actor({ classId: "Hero" });
    const label = new ActorComponent({ classId: "Text3DComponent", variables: { text: "Old" } });
    const audio = new ActorComponent({ classId: "AudioComponent", variables: { audioAssetGuid: "sound" } });
    hero.attachComponent(label);
    hero.attachComponent(audio);
    label.destroyed = true;
    audio.destroyed = true;
    const ctx = host.createContext(hero, 0, 0);

    ctx.callComponentFunction(label, "setText", { text: "New" });
    ctx.callComponentFunction(audio, "playAudio", {});

    expect(label.getVariable("text")).toBe("Old");
    expect(playSound).not.toHaveBeenCalled();
  });
});
