import { expandRichTextTags, RICH_TEXT_BUILT_IN_TAGS } from "@haptic/core";
import {
  RICH_TEXT_2D_DECORATOR_CLASS_ID, RICH_TEXT_DECORATE_FUNCTION, RICH_TEXT_GET_TAG_FUNCTION,
  type ActorComponent, type ClassRegistry, type EngineObject, type EngineOverridableFunction,
} from "@haptic/object-model";
import { jsIdent } from "@haptic/scripting";

/** Get Tag's and Decorate's compiled export names. */
export const GET_TAG_EXPORT = jsIdent(RICH_TEXT_GET_TAG_FUNCTION.name);
export const DECORATE_EXPORT = jsIdent(RICH_TEXT_DECORATE_FUNCTION.name);

const dataPins = (fn: EngineOverridableFunction, direction: "in" | "out") =>
  fn.pins.filter((pin) => pin.direction === direction && pin.typeId !== "exec").map((pin) => pin.name);
const [TAG_OUTPUT] = dataPins(RICH_TEXT_GET_TAG_FUNCTION, "out") as [string];
const [VALUE_INPUT, CONTENT_INPUT, COMPONENT_INPUT] = dataPins(RICH_TEXT_DECORATE_FUNCTION, "in") as [string, string, string];
const [MARKUP_OUTPUT] = dataPins(RICH_TEXT_DECORATE_FUNCTION, "out") as [string];

/** A tag name a Decorator may handle: a letter, then letters, digits and hyphens, as the parser reads tag names. */
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
/** How many more times a text whose expansion was asked for again while it ran is expanded afterwards. */
const MAX_REQUESTED_EXPANSIONS = 3;
const NO_TAGS: ReadonlySet<string> = new Set();
const NO_DECORATORS: ReadonlyMap<string, RichTextDecorator> = new Map();

/** A loaded Rich Text 2D Decorator Class: its one instance for this script load, and a call of its Decorate. */
export type RichTextDecorator = {
  classId: string;
  self: EngineObject;
  /** Decorate's outputs by output pin name; null when it is missing, throws or waits. */
  decorate(args: Record<string, unknown>): Record<string, unknown> | null;
};

/** What loading Decorators needs from the session: its classes, bare instances and engine function calls. */
export interface RichTextDecoratorLoadHost {
  classes(): Pick<ClassRegistry, "classIds" | "isA">;
  /** A new instance of `classId` with its Class defaults; no lifecycle event runs on it. */
  createInstance(classId: string): EngineObject;
  /** Function `exportName`'s outputs by output pin name on `self`; null when it is missing, throws or waits. */
  call(self: EngineObject, exportName: string, args: Record<string, unknown>): Record<string, unknown> | null;
  /** Done with an instance: it is never used again. */
  release(self: EngineObject): void;
  warn(message: string): void;
}

/**
 * The Decorators of every loaded Class deriving from Rich Text 2D Decorator (not the base itself), by the tag each
 * handles. In sorted Class id order, each Class gets one instance, kept until the next load, and its Get Tag runs once;
 * the trimmed, lower-cased result is its tag. A Class whose tag is empty, not a tag name or a built-in tag is skipped,
 * as is one whose Get Tag has no result (missing, an error, or latent); of two Classes with one tag the first keeps it.
 */
export function loadRichTextDecorators(host: RichTextDecoratorLoadHost): Map<string, RichTextDecorator> {
  const classes = host.classes();
  const decorators = new Map<string, RichTextDecorator>();
  const classIds = classes.classIds()
    .filter((classId) => classId !== RICH_TEXT_2D_DECORATOR_CLASS_ID && classes.isA(classId, RICH_TEXT_2D_DECORATOR_CLASS_ID))
    .sort();
  for (const classId of classIds) {
    const self = host.createInstance(classId);
    const output = host.call(self, GET_TAG_EXPORT, {})?.[TAG_OUTPUT];
    const tag = typeof output === "string" ? output.trim().toLowerCase() : "";
    const taken = decorators.get(tag);
    if (taken) host.warn(`Rich Text Decorators ${taken.classId} and ${classId} both handle the [${tag}] tag: ${taken.classId} handles it.`);
    else if (RICH_TEXT_BUILT_IN_TAGS.has(tag)) host.warn(`Rich Text Decorator ${classId} cannot handle [${tag}], a built-in tag.`);
    if (taken || !TAG_NAME.test(tag) || RICH_TEXT_BUILT_IN_TAGS.has(tag)) {
      host.release(self);
      continue;
    }
    decorators.set(tag, { classId, self, decorate: (args) => host.call(self, DECORATE_EXPORT, args) });
  }
  return decorators;
}

/** What expansion needs from letter scripting: Get Tag Value answering from the tag being decorated. */
export interface RichTextDecoratorsHost {
  /** Runs `run` with Get Tag Value on `self` reading `values` (keys lower-cased), and restores the previous tag after. */
  withTag<T>(self: EngineObject, values: ReadonlyMap<string, string>, run: () => T): T;
}

/**
 * The text each 2D Rich Text draws: its authored `text` with the custom tags of the loaded Decorators expanded
 * (`expandRichTextTags`). Callers ask only while `active`, so with no Decorator loaded the text paths do one check and
 * keep the authored string. An expansion is kept per component with the source it was made from and runs again only
 * when that source changes, on `refresh` (Refresh Text) or on `load`; a text without custom tags keeps its own string.
 */
export class RichTextDecorators {
  private decorators: ReadonlyMap<string, RichTextDecorator> = NO_DECORATORS;
  private tags: ReadonlySet<string> = NO_TAGS;
  private expanded = new WeakMap<ActorComponent, { source: string; text: string }>();
  /** Components being expanded now, and those asked for again meanwhile (by a Decorate that set their text). */
  private readonly expanding = new Set<ActorComponent>();
  private readonly requested = new Set<ActorComponent>();
  private readonly host: RichTextDecoratorsHost;

  constructor(host: RichTextDecoratorsHost) {
    this.host = host;
  }

  /** Whether any Decorator is loaded; while none is, every text draws as authored. */
  get active(): boolean {
    return this.tags.size > 0;
  }

  /** The text `component` draws for its authored text `authored`; anything but a string is returned as it is. */
  text(component: ActorComponent, authored: unknown): unknown {
    if (typeof authored !== "string") return authored;
    const entry = this.expanded.get(component);
    return entry !== undefined && entry.source === authored ? entry.text : this.expand(component, authored);
  }

  /** Refresh Text: expands `component`'s text again; whether what it draws changed. */
  refresh(component: ActorComponent): boolean {
    if (!this.active) return false;
    const authored = component.getVariable("text");
    if (typeof authored !== "string") return false;
    const before = this.drawn(this.expanded, component, authored);
    return this.expand(component, authored) !== before;
  }

  /**
   * A script load's Decorators (`loadRichTextDecorators`) replace the previous ones. Every one of `components` is
   * expanded again, since tags and markup may have changed; returns those whose drawn text changed.
   */
  load(decorators: ReadonlyMap<string, RichTextDecorator>, components: Iterable<ActorComponent>): ActorComponent[] {
    const previous = this.expanded, wasActive = this.active;
    this.decorators = decorators.size > 0 ? decorators : NO_DECORATORS;
    this.tags = decorators.size > 0 ? new Set(decorators.keys()) : NO_TAGS;
    this.expanded = new WeakMap();
    if (!wasActive && !this.active) return [];
    const changed: ActorComponent[] = [];
    for (const component of components) {
      const authored = component.getVariable("text");
      if (typeof authored !== "string") continue;
      const before = this.drawn(previous, component, authored);
      if ((this.active ? this.expand(component, authored) : authored) !== before) changed.push(component);
    }
    return changed;
  }

  /** What `component` drew for `authored` by `expansions`: the authored text when nothing was expanded for it. */
  private drawn(expansions: WeakMap<ActorComponent, { source: string; text: string }>, component: ActorComponent, authored: string): string {
    const entry = expansions.get(component);
    return entry !== undefined && entry.source === authored ? entry.text : authored;
  }

  /**
   * Expands `authored` and keeps the result. Decorate is script and may set this component's text again: that asks
   * for an expansion while this one runs, which answers with the text drawn so far and is done once this one
   * finishes, from the text then current, at most `MAX_REQUESTED_EXPANSIONS` times.
   */
  private expand(component: ActorComponent, authored: string): string {
    if (this.expanding.has(component)) {
      this.requested.add(component);
      return this.drawn(this.expanded, component, authored);
    }
    this.expanding.add(component);
    try {
      let source = authored;
      let text = this.run(component, source);
      for (let again = 0; this.requested.delete(component) && again < MAX_REQUESTED_EXPANSIONS; again++) {
        const current = component.getVariable("text");
        if (typeof current !== "string") break;
        source = current;
        text = this.run(component, source);
      }
      this.requested.delete(component);
      this.expanded.set(component, { source, text });
      return text;
    } finally {
      this.expanding.delete(component);
    }
  }

  private run(component: ActorComponent, source: string): string {
    return expandRichTextTags(source, this.tags, ({ tag, value, content, attrs }) => {
      const decorator = this.decorators.get(tag);
      if (!decorator || decorator.self.destroyed) return null;
      const outputs = this.host.withTag(decorator.self, new Map(Object.entries(attrs)), () =>
        decorator.decorate({ [VALUE_INPUT]: value, [CONTENT_INPUT]: content, [COMPONENT_INPUT]: component }));
      const markup = outputs?.[MARKUP_OUTPUT];
      return typeof markup === "string" ? markup : null;
    });
  }
}
