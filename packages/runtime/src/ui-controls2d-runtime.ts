import {
  clampUIControl2DValue,
  isUIControl2DClass,
  normalizeUIControl2DText,
  parseUIControl2DProperties,
  type UIControl2DProperties,
} from "@babylonslate/core";
import type { ControlMessage } from "@babylonslate/bridge";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import { actorParentGuid } from "./actor-world-transform";

type ControlInput = Extract<ControlMessage, { type: "sceneLayerControl" }>;
type ControlHost = {
  actors(): readonly Actor[];
  canRun(actor: Actor): boolean;
  update(component: ActorComponent, properties: UIControl2DProperties): void;
  event(component: ActorComponent, name: string, args: Record<string, unknown>): void;
};

const numericClasses = new Set(["2DSliderComponent", "2DNumericInputComponent", "2DProgressBarComponent"]);
const checkedClasses = new Set(["2DCheckboxComponent", "2DRadioButtonComponent", "2DToggleComponent"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Component state is authoritative; render hosts only propose input values. */
export class UIControls2DRuntime {
  private readonly previous = new WeakMap<ActorComponent, UIControl2DProperties>();
  private readonly host: ControlHost;

  constructor(host: ControlHost) { this.host = host; }

  private alive(component: ActorComponent): boolean {
    const actor = component.owner;
    return isUIControl2DClass(component.classId) && !component.destroyed && !!actor?.sceneLayerId &&
      !actor.destroyed && this.host.canRun(actor);
  }

  /** Reject stale input after an owner or any of its attachments was hidden. */
  private interactive(component: ActorComponent): boolean {
    if (!this.alive(component) || component.classId === "2DProgressBarComponent") return false;
    const owner = component.owner!;
    const properties = this.read(component);
    if (!properties.enabled || properties.readOnly || component.getVariable("visible") === false) return false;
    const seenComponents = new Set<ActorComponent>([component]);
    let parentId = component.parentId;
    while (parentId) {
      const parent = owner.components.find((entry) => entry.guid === parentId || entry.sourceId === parentId);
      if (!parent || seenComponents.has(parent) || parent.destroyed || parent.getVariable("enabled") === false || parent.getVariable("visible") === false) return false;
      seenComponents.add(parent);
      parentId = parent.parentId;
    }
    const actors = this.host.actors();
    const seenActors = new Set<Actor>();
    let actor: Actor | undefined = owner;
    while (actor) {
      if (seenActors.has(actor) || actor.destroyed || actor.getVariable("enabled") === false || actor.getVariable("visible") === false) return false;
      seenActors.add(actor);
      const parent = actorParentGuid(actor);
      if (!parent) break;
      actor = actors.find((entry) => entry.guid === parent && entry.sceneLayerId === owner.sceneLayerId);
      if (!actor) return false;
    }
    return true;
  }

  private read(component: ActorComponent): UIControl2DProperties {
    return parseUIControl2DProperties(component.classId, Object.fromEntries(component.variables));
  }

  /** Normalize persisted values so graph getters and the displayed values agree. */
  payload(component: ActorComponent): UIControl2DProperties {
    const properties = this.read(component);
    if (!this.previous.has(component) && component.classId === "2DRadioButtonComponent" && properties.checked && component.owner?.sceneLayerId) {
      // Resolve authored conflicts in world/component order before emitting any
      // visual. Disabled radios can remain selected; enablement controls input.
      const actors = this.host.actors();
      const candidates = actors.includes(component.owner) ? actors : [...actors, component.owner];
      const selected = candidates.filter((actor) => !actor.destroyed && actor.sceneLayerId === component.owner!.sceneLayerId)
        .flatMap((actor) => actor.components)
        .find((peer) => !peer.destroyed && peer.classId === "2DRadioButtonComponent" &&
          peer.getVariable("checked") === true && this.read(peer).group === properties.group);
      if (selected !== component) properties.checked = false;
    }
    this.store(component, properties);
    return properties;
  }

  private store(component: ActorComponent, properties: UIControl2DProperties): void {
    for (const [key, value] of Object.entries(properties)) component.setVariable(key, value);
    this.previous.set(component, properties);
  }

  private notify(component: ActorComponent, before: UIControl2DProperties, after: UIControl2DProperties): void {
    if (!this.alive(component)) return;
    this.host.update(component, after);
    if (numericClasses.has(component.classId) && before.value !== after.value) {
      this.host.event(component, "onUIValueChanged", { value: after.value });
    } else if (component.classId === "2DRangeSliderComponent" && (before.lowerValue !== after.lowerValue || before.upperValue !== after.upperValue)) {
      this.host.event(component, "onUIRangeChanged", { lowerValue: after.lowerValue, upperValue: after.upperValue });
    } else if (checkedClasses.has(component.classId) && before.checked !== after.checked) {
      this.host.event(component, "onUICheckedChanged", { checked: after.checked });
    } else if (component.classId === "2DTextInputComponent" && before.text !== after.text) {
      this.host.event(component, "onUITextChanged", { text: after.text });
    } else if (component.classId === "2DDropdownComponent" && (before.selectedIndex !== after.selectedIndex || before.options[before.selectedIndex] !== after.options[after.selectedIndex])) {
      this.host.event(component, "onUISelectionChanged", { index: after.selectedIndex, value: after.options[after.selectedIndex] ?? "" });
    }
  }

  refresh(component: ActorComponent): void {
    if (!this.alive(component)) return;
    const before = this.previous.get(component) ?? this.read(component);
    const after = this.read(component);
    const changes: Array<{ component: ActorComponent; before: UIControl2DProperties; after: UIControl2DProperties }> = [];
    // Update every member before dispatch so graph handlers observe one selection.
    if (component.classId === "2DRadioButtonComponent" && after.checked) {
      for (const actor of this.host.actors()) {
        if (actor.sceneLayerId !== component.owner!.sceneLayerId || actor.destroyed) continue;
        for (const peer of actor.components) {
          if (peer === component || peer.destroyed || peer.classId !== "2DRadioButtonComponent") continue;
          const current = this.read(peer);
          if (!current.checked || current.group !== after.group) continue;
          const next = { ...current, checked: false };
          this.store(peer, next);
          changes.push({ component: peer, before: current, after: next });
        }
      }
    }
    this.store(component, after);
    for (const change of changes) this.notify(change.component, change.before, change.after);
    this.notify(component, before, after);
  }

  private change(component: ActorComponent, values: Record<string, unknown>): boolean {
    if (!this.alive(component)) return false;
    if (!this.previous.has(component)) this.payload(component);
    for (const [key, value] of Object.entries(values)) component.setVariable(key, value);
    this.refresh(component);
    return true;
  }

  invoke(component: ActorComponent, name: string, args: Record<string, unknown>): boolean {
    if (!this.alive(component)) return false;
    const properties = this.read(component);
    if (name === "setUIControlValue" && numericClasses.has(component.classId) && finite(args.value)) {
      return this.change(component, { value: clampUIControl2DValue(args.value, properties) });
    }
    if (name === "incrementUIControl" && numericClasses.has(component.classId) && finite(args.delta)) {
      return this.change(component, { value: clampUIControl2DValue(properties.value + args.delta * (properties.step || 1), properties) });
    }
    if (name === "setUIControlRange" && component.classId === "2DRangeSliderComponent" && finite(args.lowerValue) && finite(args.upperValue)) {
      const lower = clampUIControl2DValue(args.lowerValue, properties), upper = clampUIControl2DValue(args.upperValue, properties);
      return this.change(component, { lowerValue: Math.min(lower, upper), upperValue: Math.max(lower, upper) });
    }
    if (name === "setUIControlChecked" && checkedClasses.has(component.classId) && typeof args.checked === "boolean") {
      return this.change(component, { checked: args.checked });
    }
    if (name === "setUIControlText" && component.classId === "2DTextInputComponent" && typeof args.text === "string") {
      return this.change(component, { text: normalizeUIControl2DText(args.text, properties) });
    }
    if (name === "setUIControlSelectedIndex" && component.classId === "2DDropdownComponent" && finite(args.index)) {
      return this.change(component, { selectedIndex: Math.max(-1, Math.min(properties.options.length - 1, Math.trunc(args.index))) });
    }
    return false;
  }

  activate(component: ActorComponent): boolean {
    if (!this.interactive(component)) return false;
    const properties = this.read(component);
    if (checkedClasses.has(component.classId)) return this.invoke(component, "setUIControlChecked", {
      checked: component.classId === "2DRadioButtonComponent" || !properties.checked,
    });
    if (component.classId === "2DDropdownComponent") return this.invoke(component, "setUIControlSelectedIndex", {
      index: properties.options.length ? (properties.selectedIndex + 1) % properties.options.length : -1,
    });
    if (component.classId === "2DTextInputComponent") {
      this.host.event(component, "onUITextSubmitted", { text: properties.text });
      return true;
    }
    return false;
  }

  input(component: ActorComponent, message: ControlInput): void {
    if (!this.interactive(component)) return;
    if (message.action === "activate") { this.activate(component); return; }
    if (message.action !== "change" && message.action !== "commit") return;
    if (numericClasses.has(component.classId)) this.invoke(component, "setUIControlValue", { value: message.value });
    else if (component.classId === "2DRangeSliderComponent") this.invoke(component, "setUIControlRange", { lowerValue: message.value, upperValue: message.secondaryValue });
    else if (checkedClasses.has(component.classId)) this.invoke(component, "setUIControlChecked", { checked: component.classId === "2DRadioButtonComponent" ? true : message.value });
    else if (component.classId === "2DTextInputComponent") this.invoke(component, "setUIControlText", { text: message.value });
    else if (component.classId === "2DDropdownComponent") this.invoke(component, "setUIControlSelectedIndex", { index: message.value });
    if (message.action === "commit" && component.classId === "2DTextInputComponent" && this.interactive(component)) {
      this.host.event(component, "onUITextSubmitted", { text: this.read(component).text });
    }
  }
}
