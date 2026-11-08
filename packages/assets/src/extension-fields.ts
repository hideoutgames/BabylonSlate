/**
 * The declarative field schema extensions use for Project Settings categories
 * and command dialogs. The editor renders fields with its own components;
 * values are plain data, so they persist in project.json and reach games.
 */
export type ExtensionFieldValue = string | number | boolean;
export type ExtensionFieldValues = Record<string, ExtensionFieldValue>;

interface ExtensionFieldBase {
  /** Value key, unique within its form. */
  id: string;
  label: string;
  /** One short sentence, shown as the label's tooltip. */
  hint?: string;
  /** Text fields only: an empty value blocks the command. */
  required?: boolean;
}

export type ExtensionField =
  | (ExtensionFieldBase & { type: "text" | "multiline"; default: string })
  | (ExtensionFieldBase & { type: "code"; language: "javascript" | "glsl"; default: string })
  | (ExtensionFieldBase & { type: "number"; default: number; min?: number; max?: number; integer: boolean; unit?: string })
  | (ExtensionFieldBase & { type: "toggle"; default: boolean })
  | (ExtensionFieldBase & { type: "choice"; default: string; options: { value: string; label: string }[] });

export type ExtensionFieldType = ExtensionField["type"];

export interface ExtensionSettingsSection {
  id: string;
  title: string;
  fields: ExtensionField[];
}

/** A Project Settings category an extension adds while it is enabled. */
export interface ExtensionSettingsContribution {
  /** Category name in Project Settings, chosen by the extension. */
  title: string;
  sections: ExtensionSettingsSection[];
}

/** Pin types an extension node may declare; each maps to the graph pin type of the same name. */
export const EXTENSION_NODE_PIN_TYPES = ["bool", "int", "float", "string", "vec2", "vec3", "vec4", "rotator", "quat", "transform", "color"] as const;
export type ExtensionNodePinType = (typeof EXTENSION_NODE_PIN_TYPES)[number];

export interface ExtensionNodePin {
  /** Argument or result key; a JavaScript identifier, unique across the node's pins. */
  id: string;
  name: string;
  type: ExtensionNodePinType;
  /** Inputs only: the literal used while the pin is not wired. */
  default?: string | number | boolean;
}

/**
 * A Class graph node that calls an export of the extension's game library:
 * inputs are its arguments in order; one output takes the return value, several
 * read the returned object's keys.
 */
export interface ExtensionNodeContribution {
  id: string;
  title: string;
  /** Add Node category; the extension's display name when omitted. */
  category?: string;
  /** One sentence shown as the node title's tooltip. */
  description?: string;
  /** The game library export it calls. */
  call: string;
  /** No exec pins; evaluated where its outputs are read. */
  pure: boolean;
  /** Exec only: awaits the promise the export returns. */
  latent: boolean;
  /** Class ids whose graphs (and subclasses') offer the node; empty means every Class. */
  hosts: string[];
  inputs: ExtensionNodePin[];
  outputs: ExtensionNodePin[];
}

export interface ExtensionContributions {
  settings?: ExtensionSettingsContribution;
  nodes?: ExtensionNodeContribution[];
}

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD_TYPES: readonly ExtensionFieldType[] = ["text", "multiline", "code", "number", "toggle", "choice"];

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} is required.`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${what} must be a number.`);
  return value;
}

/** Validates one field, filling the type's default where none is given. */
export function normalizeExtensionField(value: unknown): ExtensionField {
  const raw = record(value, "An extension field");
  const id = text(raw.id, "Field id");
  if (!FIELD_ID.test(id)) throw new Error(`Field id ${id} must start with a letter and use letters, digits, _ or -.`);
  const type = raw.type as ExtensionFieldType;
  if (!FIELD_TYPES.includes(type)) throw new Error(`Field ${id} has an unknown type: ${String(raw.type)}`);
  const base: ExtensionFieldBase = {
    id,
    label: text(raw.label, `Field ${id} label`),
    ...(optionalText(raw.hint) ? { hint: optionalText(raw.hint) } : {}),
    ...(raw.required === true ? { required: true } : {}),
  };
  const fallback = raw.default;
  const wrongDefault = () => new Error(`Field ${id} has a default that does not match its type.`);
  switch (type) {
    case "text":
    case "multiline":
    case "code": {
      if (fallback !== undefined && typeof fallback !== "string") throw wrongDefault();
      const defaultValue = (fallback as string | undefined) ?? "";
      if (type !== "code") return { ...base, type, default: defaultValue };
      const language = raw.language ?? "javascript";
      if (language !== "javascript" && language !== "glsl") throw new Error(`Field ${id} language must be javascript or glsl.`);
      return { ...base, type, language, default: defaultValue };
    }
    case "number": {
      const min = finite(raw.min, `Field ${id} min`);
      const max = finite(raw.max, `Field ${id} max`);
      if (min !== undefined && max !== undefined && min > max) throw new Error(`Field ${id} min is above its max.`);
      const integer = raw.integer === true;
      if (fallback !== undefined && (typeof fallback !== "number" || !Number.isFinite(fallback))) throw wrongDefault();
      const defaultValue = clampNumber((fallback as number | undefined) ?? min ?? 0, min, max, integer);
      return { ...base, type, default: defaultValue, integer,
        ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
        ...(optionalText(raw.unit) ? { unit: optionalText(raw.unit) } : {}) };
    }
    case "toggle":
      if (fallback !== undefined && typeof fallback !== "boolean") throw wrongDefault();
      return { ...base, type, default: (fallback as boolean | undefined) ?? false };
    case "choice": {
      if (!Array.isArray(raw.options) || raw.options.length === 0) throw new Error(`Field ${id} needs options.`);
      const options = raw.options.map((option, index) => {
        const entry = record(option, `Field ${id} option ${index + 1}`);
        return { value: text(entry.value, `Field ${id} option value`), label: text(entry.label, `Field ${id} option label`) };
      });
      if (new Set(options.map((option) => option.value)).size !== options.length) throw new Error(`Field ${id} has duplicate option values.`);
      if (fallback !== undefined && !options.some((option) => option.value === fallback)) throw wrongDefault();
      return { ...base, type, options, default: (fallback as string | undefined) ?? options[0]!.value };
    }
  }
}

/** Validates a form's fields; ids must be unique across it. */
export function normalizeExtensionFields(value: unknown): ExtensionField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Extension fields must be a list.");
  const fields = value.map(normalizeExtensionField);
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.id)) throw new Error(`Duplicate field id: ${field.id}`);
    seen.add(field.id);
  }
  return fields;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED_PIN_IDS = new Set(["execIn", "execOut"]);

function normalizeNodePin(value: unknown, node: string, direction: "input" | "output"): ExtensionNodePin {
  const raw = record(value, `Node ${node} ${direction}`);
  const id = text(raw.id, `Node ${node} ${direction} id`);
  if (!IDENTIFIER.test(id) || RESERVED_PIN_IDS.has(id)) throw new Error(`Node ${node} pin id ${id} must be a JavaScript identifier other than execIn or execOut.`);
  const type = raw.type as ExtensionNodePinType;
  if (!EXTENSION_NODE_PIN_TYPES.includes(type)) throw new Error(`Node ${node} pin ${id} has an unknown type: ${String(raw.type)}`);
  const fallback = raw.default;
  if (fallback !== undefined) {
    if (direction === "output") throw new Error(`Node ${node} output ${id} cannot have a default.`);
    const expected = type === "bool" ? "boolean" : type === "string" ? "string" : type === "int" || type === "float" ? "number" : null;
    if (!expected || typeof fallback !== expected) throw new Error(`Node ${node} input ${id} has a default that does not match its type.`);
  }
  return { id, name: text(raw.name, `Node ${node} pin ${id} name`), type, ...(fallback !== undefined ? { default: fallback as string | number | boolean } : {}) };
}

function normalizeNode(value: unknown): ExtensionNodeContribution {
  const raw = record(value, "An extension node");
  const id = text(raw.id, "Node id");
  if (!FIELD_ID.test(id)) throw new Error(`Node id ${id} must start with a letter and use letters, digits, _ or -.`);
  const call = text(raw.call, `Node ${id} call`);
  if (!IDENTIFIER.test(call)) throw new Error(`Node ${id} call must name a game library export.`);
  const pure = raw.pure === true;
  const latent = raw.latent === true;
  if (pure && latent) throw new Error(`Node ${id} cannot be both pure and latent.`);
  const inputs = Array.isArray(raw.inputs) ? raw.inputs.map((pin) => normalizeNodePin(pin, id, "input")) : [];
  const outputs = Array.isArray(raw.outputs) ? raw.outputs.map((pin) => normalizeNodePin(pin, id, "output")) : [];
  if (pure && outputs.length === 0) throw new Error(`Pure node ${id} needs an output.`);
  const pinIds = [...inputs, ...outputs].map((pin) => pin.id);
  if (new Set(pinIds).size !== pinIds.length) throw new Error(`Node ${id} has duplicate pin ids.`);
  const hosts = Array.isArray(raw.hosts) ? raw.hosts.map((host) => text(host, `Node ${id} host`)) : [];
  return {
    id, title: text(raw.title, `Node ${id} title`), call, pure, latent, hosts, inputs, outputs,
    ...(optionalText(raw.category) ? { category: optionalText(raw.category) } : {}),
    ...(optionalText(raw.description) ? { description: optionalText(raw.description) } : {}),
  };
}

function normalizeNodes(value: unknown): ExtensionNodeContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Extension nodes must be a list.");
  const nodes = value.map(normalizeNode);
  const ids = nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) throw new Error("Extension node ids must be unique.");
  return nodes;
}

export function normalizeExtensionContributions(value: unknown): ExtensionContributions {
  if (value === undefined) return {};
  const raw = record(value, "Extension contributes");
  const nodes = normalizeNodes(raw.nodes);
  const withNodes: ExtensionContributions = nodes?.length ? { nodes } : {};
  if (raw.settings === undefined) return withNodes;
  const settings = record(raw.settings, "Extension settings");
  if (!Array.isArray(settings.sections) || settings.sections.length === 0) {
    throw new Error("Extension settings need at least one section.");
  }
  const sectionIds = new Set<string>();
  const sections = settings.sections.map((entry, index): ExtensionSettingsSection => {
    const section = record(entry, `Extension settings section ${index + 1}`);
    const id = text(section.id, "Settings section id");
    if (!FIELD_ID.test(id) || sectionIds.has(id)) throw new Error(`Invalid or duplicate settings section id: ${id}`);
    sectionIds.add(id);
    const fields = normalizeExtensionFields(section.fields);
    if (fields.length === 0) throw new Error(`Settings section ${id} needs at least one field.`);
    return { id, title: text(section.title, `Settings section ${id} title`), fields };
  });
  // One value per field id across the whole category.
  normalizeExtensionFields(sections.flatMap((section) => section.fields));
  return { ...withNodes, settings: { title: text(settings.title, "Extension settings title"), sections } };
}

export function extensionSettingsFields(contributions: ExtensionContributions): ExtensionField[] {
  return contributions.settings?.sections.flatMap((section) => section.fields) ?? [];
}

function clampNumber(value: number, min: number | undefined, max: number | undefined, integer: boolean): number {
  let next = integer ? Math.round(value) : value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

/** A stored value of the field's type (numbers clamped, choices checked), else its default. */
export function resolveExtensionFieldValue(field: ExtensionField, value: unknown): ExtensionFieldValue {
  switch (field.type) {
    case "text":
    case "multiline":
    case "code":
      return typeof value === "string" ? value : field.default;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? clampNumber(value, field.min, field.max, field.integer) : field.default;
    case "toggle":
      return typeof value === "boolean" ? value : field.default;
    case "choice":
      return typeof value === "string" && field.options.some((option) => option.value === value) ? value : field.default;
  }
}

/** Every field's value, from `values` where valid, else the field default. Unknown keys are dropped. */
export function resolveExtensionFieldValues(fields: readonly ExtensionField[], values: Readonly<Record<string, unknown>> = {}): ExtensionFieldValues {
  return Object.fromEntries(fields.map((field) => [field.id, resolveExtensionFieldValue(field, values[field.id])]));
}
