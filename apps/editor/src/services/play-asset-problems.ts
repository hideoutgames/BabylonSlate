import {
  documentId, documentKindForAssetType, documentKindLabel, humanizePropertyLabel, renderEffectsAssetGuids,
  type ProjectDocument,
} from "@haptic/core";
import { AssetLoadError, type AssetRegistry } from "@haptic/assets";
import { diagnostic, type Diagnostic } from "@haptic/scripting";
import { componentTypeLabel } from "../panels/add-component-catalog";

/** A required asset Play cannot find. */
export const PLAY_MISSING_ASSET_CODE = "play.missing_asset";
/** A required asset saved in a format this engine does not read. */
export const PLAY_UNSUPPORTED_ASSET_FORMAT_CODE = "play.unsupported_asset_format";
/** A required asset storage could not read, or that changed while Play read it. */
export const PLAY_UNREADABLE_ASSET_CODE = "play.unreadable_asset";

export type PlayAssetProblemCode =
  | typeof PLAY_MISSING_ASSET_CODE
  | typeof PLAY_UNSUPPORTED_ASSET_FORMAT_CODE
  | typeof PLAY_UNREADABLE_ASSET_CODE;

/** An asset as the catalog indexes it; empty name, type and path when it does not. */
export interface PlayAssetDescription {
  guid: string;
  name: string;
  type: string;
  path: string;
}

/** Where a referrer's document holds the failing id; fields are present only where they apply. */
export interface PlayAssetReferenceLocation {
  actorId?: string;
  actorName?: string;
  componentId?: string;
  componentClassId?: string;
  componentName?: string;
  nodeId?: string;
  /** The property key under the component's or Actor's properties, else the key that holds the id. */
  property?: string;
}

export interface PlayAssetProblem {
  code: PlayAssetProblemCode;
  /** The id Play could not resolve. */
  guid: string;
  /** From the Play root down to the asset that names `guid`; empty when `guid` is itself a root. */
  referrers: PlayAssetDescription[];
  location: PlayAssetReferenceLocation | null;
  message: string;
  diagnostic: Diagnostic;
}

/**
 * Required assets Play could not resolve, each with what names it and where. `code`, `guid`,
 * `referrers` and `location` are the first problem's; `cause` is the first underlying error, so a
 * source revision change still reads as one to the retry.
 */
export class PlayRequiredAssetError extends Error {
  override readonly name = "PlayRequiredAssetError";
  readonly code: PlayAssetProblemCode;
  readonly guid: string;
  readonly referrers: PlayAssetDescription[];
  readonly location: PlayAssetReferenceLocation | null;
  readonly problems: readonly PlayAssetProblem[];

  constructor(problems: readonly PlayAssetProblem[], cause?: unknown) {
    super(problems.map((problem) => problem.message).join(" "), cause === undefined ? undefined : { cause });
    this.problems = problems;
    const first = problems[0]!;
    this.code = first.code;
    this.guid = first.guid;
    this.referrers = first.referrers;
    this.location = first.location;
  }

  get diagnostics(): Diagnostic[] {
    return this.problems.map((problem) => problem.diagnostic);
  }
}

/** The PlayRequiredAssetError an error is, or was caused by. */
export function playRequiredAssetErrorOf(error: unknown): PlayRequiredAssetError | null {
  const seen = new Set<unknown>();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    if (cause instanceof PlayRequiredAssetError) return cause;
    seen.add(cause);
  }
  return null;
}

/** An asset type as the editor names it: `SceneLayer` is a Scene Layer, `Class` a Class. */
export function assetTypeLabel(type: string): string {
  const kind = documentKindForAssetType(type);
  return kind ? documentKindLabel(kind) : humanizePropertyLabel(type.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

export function describePlayAsset(registry: Pick<AssetRegistry, "getByGuid">, guid: string): PlayAssetDescription {
  const asset = registry.getByGuid(guid);
  return asset && !asset.placeholder
    ? { guid, name: asset.header.name, type: asset.header.type, path: asset.path }
    : { guid, name: "", type: "", path: "" };
}

/** `Scene Layer "HUD"`, with ` (path)` when asked; an id the catalog does not index reads `asset <id>`. */
export function formatPlayAsset(asset: PlayAssetDescription, withPath = false): string {
  if (!asset.type) return `asset ${asset.guid}`;
  return `${assetTypeLabel(asset.type)} "${asset.name}"${withPath ? ` (${asset.path})` : ""}`;
}

/** The registry's description of an asset, for messages: `Texture "Bricks" (assets/Bricks.hasset)`. */
export function describePlayAssetForMessage(registry: Pick<AssetRegistry, "getByGuid">, guid: string): string {
  return formatPlayAsset(describePlayAsset(registry, guid), true);
}

/** `textureGuid` reads Texture, as its Inspector row does. */
function propertyLabel(key: string): string {
  return humanizePropertyLabel(key).replace(/ GUID$/, "") || key;
}

type Json = unknown;
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/**
 * Where `payload` names `guid`: the first string that is the id or holds it as a token (`[img=ID size=8]`,
 * `class:ID`), with the Actor (an entry of an `actors` list), component (an entry of a `components` list),
 * graph node (an entry of a `nodes` list) and property around it. Generic over Scene, Scene Layer, Class,
 * Prefab and plain payloads; null when the document does not hold it.
 */
export function findAssetReference(payload: Json, guid: string): PlayAssetReferenceLocation | null {
  const token = new RegExp(`(^|[^\\w-])${guid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`);
  const visit = (value: Json, at: PlayAssetReferenceLocation, key: string | undefined, depth: number): PlayAssetReferenceLocation | null => {
    if (typeof value === "string") return value === guid || token.test(value) ? { ...at, property: at.property ?? key } : null;
    if (depth > 64 || !value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        let next = at;
        if (isRow(entry) && text(entry.id)) {
          if (key === "actors") next = { actorId: text(entry.id), actorName: text(entry.name) };
          else if (key === "components" && text(entry.classId)) {
            next = { ...at, componentId: text(entry.id), componentClassId: text(entry.classId), componentName: text(entry.name),
              property: undefined };
          } else if (key === "nodes") next = { ...at, nodeId: text(entry.id), property: undefined };
        }
        const found = visit(entry, next, key, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [childKey, child] of Object.entries(value)) {
      // The key directly under an Actor's or component's `properties` names the property.
      const property = key === "properties" && (at.componentId || at.actorId) && at.property === undefined ? childKey : at.property;
      const found = visit(child, { ...at, property }, childKey, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const found = visit(payload, {}, undefined, 0);
  if (!found) return null;
  return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined)) as PlayAssetReferenceLocation;
}

/** The Project Settings row that names a Play root, when one does. */
export function projectSettingNaming(project: ProjectDocument, guid: string): { label: string; what: string } | null {
  const { settings } = project;
  if (settings.startupSceneGuid === guid) return { label: "Startup Scene", what: "an asset" };
  if (settings.gameInstanceClass === guid) return { label: "Game Instance", what: "a Class" };
  if (settings.audio.audioMixerGuid === guid) return { label: "Audio Mixer", what: "an asset" };
  if (settings.fonts.defaultFontGuid === guid) return { label: "Default Font", what: "an asset" };
  if (renderEffectsAssetGuids(settings.render.effects).includes(guid)) return { label: "LUT Texture", what: "an asset" };
  return null;
}

export type PlayAssetFailure = { guid: string; code: PlayAssetProblemCode; cause?: unknown };

export interface PlayAssetProblemContext {
  registry: AssetRegistry;
  project: ProjectDocument;
  /** First asset that named each id the walk discovered; roots have none. */
  referrers: ReadonlyMap<string, string>;
  /** The open working document of an asset, when one replaces its stored payload. */
  workingPayload: (guid: string) => Record<string, unknown> | undefined;
  signal?: AbortSignal;
}

/**
 * The underlying error's own words, without the closing period the problem's sentence adds. A loader
 * failure's own cause, since its message repeats the asset id and the consumer.
 */
const causeText = (cause: unknown) => {
  const error = cause instanceof AssetLoadError && cause.cause instanceof Error ? cause.cause : cause;
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
};

/**
 * The typed failure for what a Play closure walk could not resolve. Runs only after a failure: it reads
 * each referrer's document (its working copy, else its stored payload) to find the reference.
 */
export async function playRequiredAssetError(context: PlayAssetProblemContext, failures: readonly PlayAssetFailure[]): Promise<PlayRequiredAssetError> {
  const { registry } = context;
  const payloads = new Map<string, Promise<Json>>();
  const payloadOf = (guid: string): Promise<Json> => {
    let payload = payloads.get(guid);
    if (!payload) {
      const working = context.workingPayload(guid);
      payload = working ? Promise.resolve(working) : (async () => {
        const asset = registry.getByGuid(guid);
        if (!asset || asset.placeholder) return null;
        // A catalog that carries its payload inline needs no read.
        if (!asset.header.chunks.some((chunk) => chunk.id === "document")) return asset.header.payload;
        try { return (await registry.readAssetDocument(guid, { signal: context.signal })).payload; }
        catch { return null; }
      })();
      payloads.set(guid, payload);
    }
    return payload;
  };
  const problems: PlayAssetProblem[] = [];
  for (const failure of failures) {
    const chain: PlayAssetDescription[] = [];
    const seen = new Set([failure.guid]);
    for (let referrer = context.referrers.get(failure.guid); referrer && !seen.has(referrer); referrer = context.referrers.get(referrer)) {
      seen.add(referrer);
      chain.unshift(describePlayAsset(registry, referrer));
    }
    const owner = chain.at(-1);
    const location = owner ? findAssetReference(await payloadOf(owner.guid), failure.guid) : null;
    const message = problemMessage(context, failure, owner, location);
    const kind = owner && documentKindForAssetType(owner.type);
    problems.push({
      code: failure.code, guid: failure.guid, referrers: chain, location, message,
      diagnostic: diagnostic({
        code: failure.code, message,
        assetGuid: owner?.guid ?? "",
        graphId: owner ? kind ? documentId({ kind, path: owner.path }) : owner.path : "Project Settings",
        nodeId: location?.nodeId, actorId: location?.actorId, componentId: location?.componentId,
      }),
    });
  }
  return new PlayRequiredAssetError(problems, failures.find((failure) => failure.cause !== undefined)?.cause);
}

function problemMessage(context: PlayAssetProblemContext, failure: PlayAssetFailure, owner: PlayAssetDescription | undefined,
  location: PlayAssetReferenceLocation | null): string {
  const failing = describePlayAsset(context.registry, failure.guid);
  const what = failure.code === PLAY_MISSING_ASSET_CODE
    ? `an asset that does not exist: ${failure.guid}`
    : failure.code === PLAY_UNSUPPORTED_ASSET_FORMAT_CODE
      ? `${formatPlayAsset(failing, true)}, which is saved in a format Play cannot read: ${causeText(failure.cause)}`
      : `${formatPlayAsset(failing, true)}, which could not be read: ${causeText(failure.cause)}`;
  if (!owner) {
    const setting = projectSettingNaming(context.project, failure.guid);
    if (!setting) return `Play needs ${what}.`;
    const named = failure.code === PLAY_MISSING_ASSET_CODE ? `${setting.what} that does not exist: ${failure.guid}` : what;
    return `Project Settings > ${setting.label} names ${named}.`;
  }
  const component = location?.componentClassId ? location.componentName || componentTypeLabel(location.componentClassId) : undefined;
  const actor = location?.actorName ?? location?.actorId;
  const subject = [
    component, actor ? `${component ? "on " : ""}"${actor}"` : undefined, `${component || actor ? "in " : ""}${formatPlayAsset(owner)}`,
  ].filter(Boolean).join(" ");
  const property = location?.property ? ` (${propertyLabel(location.property)})` : "";
  return failure.code === PLAY_MISSING_ASSET_CODE ? `${subject} uses ${what}${property}.` : `${subject}${property} uses ${what}.`;
}
