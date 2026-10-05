import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, type SerializedComponent, type UIControl2DProperties } from "@babylonslate/core";
import { isPlayEngineCommandType, type CommandMessage, type ControlMessage } from "@babylonslate/bridge";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { UIControls2DRuntime } from "./ui-controls2d-runtime";
import { createInProcessRuntime } from "./driver";

function fixture() {
  const actors: Actor[] = [], events: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const updates: Array<{ id: string; properties: UIControl2DProperties }> = [];
  const runtime = new UIControls2DRuntime({ actors: () => actors, canRun: () => true,
    event: (component, name, args) => events.push({ id: component.guid, name, args }),
    update: (component, properties) => updates.push({ id: component.guid, properties }),
  });
  const add = (classId: string, variables: Record<string, unknown> = {}, layerId: string | null = "layer") => {
    const actor = new Actor({ guid: `actor-${actors.length}`, classId: "SceneLayerActor", sceneLayerId: layerId });
    const component = new ActorComponent({ guid: `control-${actors.length}`, classId, variables });
    actor.attachComponent(component); actors.push(actor); runtime.payload(component);
    return component;
  };
  const input = (component: ActorComponent, values: Partial<Extract<ControlMessage, { type: "sceneLayerControl" }>>) => runtime.input(component, {
    type: "sceneLayerControl", layerId: component.owner!.sceneLayerId!, actorGuid: component.owner!.guid,
    componentId: component.guid, action: "change", ...values,
  });
  return { runtime, add, input, events, updates };
}

describe("SceneLayer control state", () => {
  it("clamps and snaps proposed numeric values and publishes sorted ranges with graph-readable state", () => {
    const f = fixture(), slider = f.add("2DSliderComponent", { min: 0, max: 10, step: 2 }), range = f.add("2DRangeSliderComponent", { min: 0, max: 10, step: 1 });
    f.input(slider, { value: 7.1 });
    expect(slider.getVariable("value")).toBe(8);
    f.input(slider, { value: 99 });
    f.input(slider, { value: 99, action: "commit" });
    f.input(slider, { value: Number.NaN });
    f.input(range, { value: 9.7, secondaryValue: 2.2 });
    expect([range.getVariable("lowerValue"), range.getVariable("upperValue")]).toEqual([2, 10]);
    expect(f.events).toEqual([
      { id: slider.guid, name: "onUIValueChanged", args: { value: 8 } },
      { id: slider.guid, name: "onUIValueChanged", args: { value: 10 } },
      { id: range.guid, name: "onUIRangeChanged", args: { lowerValue: 2, upperValue: 10 } },
    ]);
    expect(f.updates.at(-1)?.properties).toMatchObject({ lowerValue: 2, upperValue: 10 });
  });

  it("keeps radio selections exclusive within a group and layer while preserving other groups", () => {
    const f = fixture(), first = f.add("2DRadioButtonComponent", { group: "difficulty", checked: true });
    const second = f.add("2DRadioButtonComponent", { group: "difficulty" });
    const otherGroup = f.add("2DRadioButtonComponent", { group: "theme", checked: true });
    const otherLayer = f.add("2DRadioButtonComponent", { group: "difficulty", checked: true }, "other-layer");
    f.runtime.activate(second);
    f.runtime.activate(second);
    expect([first, second, otherGroup, otherLayer].map((component) => component.getVariable("checked"))).toEqual([false, true, true, true]);
    expect(f.events).toEqual([
      { id: first.guid, name: "onUICheckedChanged", args: { checked: false } },
      { id: second.guid, name: "onUICheckedChanged", args: { checked: true } },
    ]);
  });

  it("increments a spinner by its authored step and renormalizes live values after bounds change", () => {
    const f = fixture(), spinner = f.add("2DNumericInputComponent", { min: -1, max: 1, step: 0.25, value: 0.5 });
    expect(f.runtime.invoke(spinner, "incrementUIControl", { delta: 1 })).toBe(true);
    expect(spinner.getVariable("value")).toBe(0.75);
    expect(f.runtime.invoke(spinner, "incrementUIControl", { delta: -2 })).toBe(true);
    expect(spinner.getVariable("value")).toBe(0.25);
    spinner.setVariable("max", 0); f.runtime.refresh(spinner);
    expect(spinner.getVariable("value")).toBe(0);
    expect(f.events.map((event) => event.args.value)).toEqual([0.75, 0.25, 0]);
  });

  it("edits Unicode text, submits normalized text, and clamps selection when options change", () => {
    const f = fixture(), text = f.add("2DTextInputComponent", { maxLength: 3 }), dropdown = f.add("2DDropdownComponent", { options: ["Low", "High"] });
    f.input(text, { value: "😀\nABCD" });
    f.input(text, { value: "😀\nABCD", action: "commit" });
    expect(text.getVariable("text")).toBe("😀 A");
    expect(f.events).toEqual([
      { id: text.guid, name: "onUITextChanged", args: { text: "😀 A" } },
      { id: text.guid, name: "onUITextSubmitted", args: { text: "😀 A" } },
    ]);
    f.input(dropdown, { value: 50 });
    expect(dropdown.getVariable("selectedIndex")).toBe(1);
    dropdown.setVariable("options", []); f.runtime.refresh(dropdown);
    expect(dropdown.getVariable("selectedIndex")).toBe(-1);
    expect(f.events.slice(-2)).toEqual([
      { id: dropdown.guid, name: "onUISelectionChanged", args: { index: 1, value: "High" } },
      { id: dropdown.guid, name: "onUISelectionChanged", args: { index: -1, value: "" } },
    ]);
  });

  it("ignores disabled, read-only, hidden, destroyed, and world-scene input while allowing authored meter updates", () => {
    const f = fixture();
    const disabled = f.add("2DCheckboxComponent", { enabled: false });
    const readOnly = f.add("2DCheckboxComponent", { readOnly: true });
    const hidden = f.add("2DCheckboxComponent"); hidden.owner!.setVariable("visible", false);
    const destroyed = f.add("2DCheckboxComponent"); destroyed.destroyed = true;
    const world = f.add("2DCheckboxComponent", {}, null);
    for (const component of [disabled, readOnly, hidden, destroyed, world]) f.input(component, { value: true });
    expect(f.events).toEqual([]);
    const meter = f.add("2DProgressBarComponent", { max: 100 });
    f.input(meter, { value: 50 });
    expect(meter.getVariable("value")).toBe(0);
    expect(f.runtime.invoke(meter, "setUIControlValue", { value: 120 })).toBe(true);
    expect(meter.getVariable("value")).toBe(100);
    expect(f.runtime.invoke(disabled, "setUIControlChecked", { checked: true })).toBe(true);
    expect(disabled.getVariable("checked")).toBe(true);
    expect(f.runtime.invoke(world, "setUIControlChecked", { checked: true })).toBe(false);
  });
});

describe("SceneLayer control runtime integration", () => {
  it("reconciles authored radio conflicts before visual assignment, including disabled selections and isolated groups", () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("radios", "Radios", { classId: "SceneLayerActor", components: [
      { id: "first", classId: "2DRadioButtonComponent", properties: { checked: true, enabled: false, group: "choice" } },
      { id: "second", classId: "2DRadioButtonComponent", properties: { checked: true, group: "choice" } },
      { id: "other", classId: "2DRadioButtonComponent", properties: { checked: true, group: "theme" } },
    ] }), createActor("later", "Later", { classId: "SceneLayerActor", components: [
      { id: "later-radio", classId: "2DRadioButtonComponent", properties: { checked: true, group: "choice" } },
    ] })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, seedDemoActors: false,
      playScene: createDefaultScene(), sceneLayerLibrary: { radios: layer }, onCommand: (command) => commands.push(command) });
    try {
      runtime.realizePlayWorld(); runtime.createSceneLayer("radios");
      const parts = commands.filter((command) => command.type === "assignMesh" && command.sceneLayerId).flatMap((command) => command.parts ?? []);
      expect(parts.map((part) => [part.componentId, part.uiControl?.properties.checked])).toEqual([
        ["first", true], ["second", false], ["other", true], ["later-radio", false],
      ]);
      expect(runtime.getWorld().getActors().filter((actor) => actor.sceneLayerId).flatMap((actor) => actor.components).map((component) => component.getVariable("checked"))).toEqual([true, false, true, false]);
      const anotherLayer = runtime.createSceneLayer("radios")!;
      expect(runtime.getWorld().getActors().filter((actor) => actor.sceneLayerId === anotherLayer.guid)
        .flatMap((actor) => actor.components).map((component) => component.getVariable("checked"))).toEqual([true, false, true, false]);
    } finally { runtime.stop(); }
  });

  it("routes graph setters and input to component-bound events without rebuilding visuals, and rejects stale layer input", async () => {
    const layer = createDefaultSceneLayer();
    const components: SerializedComponent[] = [
      { id: "slider", classId: "2DSliderComponent", properties: { min: 0, max: 10, step: 2, thumbMaterialGuid: "thumb" } },
      { id: "toggle", classId: "2DToggleComponent", properties: { focusInitial: true } },
    ];
    layer.actors = [createActor("controls", "Controls", { classId: "Controls", components })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, seedDemoActors: false,
      playScene: createDefaultScene(), sceneLayerLibrary: { controls: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "controls-script", classId: "Controls", parentClassId: "SceneLayerActor", anchors: [],
        source: `
          export function Set(ctx) { const c = ctx.getComponentById(ctx.self, "slider"); const result = ctx.callComponentFunction(c, "setUIControlValue", { value: 7.1 }); ctx.setVariable("success", result.success); ctx.setVariable("readback", ctx.getVariableFrom(c, "value")); ctx.setVariable("defaults", [ctx.getVariableFrom(c, "width"), ctx.getVariableFrom(c, "enabled"), ctx.getVariableFrom(c, "opacity")]); }
          export function Changed(ctx) { ctx.setVariable("eventValue", ctx.args.value); ctx.setVariable("changes", Number(ctx.getVariable("changes") || 0) + 1); }
          export function Toggled(ctx) { ctx.setVariable("eventChecked", ctx.args.checked); }
        `,
        entryPoints: [
          { name: "Set", event: "Set", isAsync: false },
          { name: "Changed", event: "onUIValueChanged", componentId: "slider", isAsync: false },
          { name: "Toggled", event: "onUICheckedChanged", componentId: "toggle", isAsync: false },
        ],
      }]);
      runtime.realizePlayWorld(); const liveLayer = runtime.createSceneLayer("controls")!; runtime.start();
      const actor = runtime.getWorld().findActor("controls")!;
      const assignment = commands.find((command) => command.type === "assignMesh" && command.actorGuid === actor.guid);
      expect(assignment).toMatchObject({ type: "assignMesh", sceneLayerId: liveLayer.guid, hitTest: "block", parts: [
        { componentId: "slider", meshKind: "2dcontrol", uiControl: { classId: "2DSliderComponent", properties: { thumbMaterialGuid: "thumb" } } },
        { componentId: "toggle", meshKind: "2dcontrol" },
      ] });
      const assignments = commands.filter((command) => command.type === "assignMesh").length;
      runtime.invokeScriptEvent("Controls", "Set", actor);
      expect([actor.getVariable("success"), actor.getVariable("readback"), actor.getVariable("eventValue")]).toEqual([true, 8, 8]);
      expect(actor.getVariable("defaults")).toEqual([4, true, 1]);
      const input: Extract<ControlMessage, { type: "sceneLayerControl" }> = {
        type: "sceneLayerControl", layerId: liveLayer.guid, actorGuid: actor.guid, componentId: "slider", action: "change", value: 3,
      };
      runtime.applySceneLayerControl({ ...input, layerId: "unrelated" });
      expect(actor.getVariable("eventValue")).toBe(8);
      runtime.applySceneLayerControl(input);
      expect(actor.getVariable("eventValue")).toBe(4);
      expect(actor.getVariable("changes")).toBe(2);
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(assignments);
      expect(commands.filter((command) => command.type === "setUIControl2D").at(-1)).toMatchObject({ componentId: "slider", uiControl: { properties: { value: 4 } } });
      expect(isPlayEngineCommandType("setUIControl2D")).toBe(true);
      runtime.tick(); runtime.pushInput([
        { kind: "key", tick: 0, code: "Enter", phase: "down" },
        { kind: "key", tick: 0, code: "Enter", phase: "up" },
      ]); runtime.tick();
      expect(actor.getVariable("eventChecked")).toBe(true);
      expect(commands.some((command) => command.type === "setUIControl2D" && command.componentId === "toggle" && command.focused === true)).toBe(true);
      runtime.removeSceneLayer(liveLayer.guid);
      runtime.applySceneLayerControl({ ...input, value: 10 });
      expect(actor.getVariable("eventValue")).toBe(4);
    } finally { runtime.stop(); }
  });
});
