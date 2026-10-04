import type { IndexedAsset } from "@babylonslate/assets";
import { materialAssetDependencies } from "./content-browser-helpers";
import { textureUploadSignature } from "./texture-upload-signature";

/** Document kinds of the assets a Material's library load reads. */
const CLOSURE_KINDS: Readonly<Record<string, string>> = {
  Material: "material",
  MaterialInstance: "material-instance",
  MaterialFunction: "material-function",
  Texture: "texture",
};

const identities = new WeakMap<object, number>();
let lastIdentity = 0;
/** A number that stays the same for one object for as long as it lives. */
function identity(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = ++lastIdentity;
    identities.set(value, id);
  }
  return id;
}

/** Dependencies of unsaved content, cached per content object because edits replace it. */
const openDependencies = new WeakMap<object, readonly string[]>();
function dependenciesOf(type: string, content: object): readonly string[] {
  let found = openDependencies.get(content);
  if (!found) {
    found = materialAssetDependencies(type, content as Record<string, unknown>);
    openDependencies.set(content, found);
  }
  return found;
}

/** Upload signature of a saved Texture, cached per registry entry because each write replaces it. */
const textureSignatures = new WeakMap<IndexedAsset, string>();
function textureSignatureOf(asset: IndexedAsset): string {
  let found = textureSignatures.get(asset);
  if (found === undefined) {
    found = JSON.stringify(textureUploadSignature(asset.header));
    textureSignatures.set(asset, found);
  }
  return found;
}

/**
 * Revision of every Material, Material Instance parent, Material Function and
 * Texture a Material reaches, as `collectPlayMaterialLibrary` and
 * `collectPlayTextureBytes` load them. It changes when any of them is edited in
 * an open tab, saved, reimported, added or removed, and stays equal through
 * unrelated edits. Header-only: no payload is read.
 *
 * Open Material documents contribute their content object (each edit replaces
 * it) and are walked through their unsaved dependencies; closed ones contribute
 * their indexed registry entry (each write replaces it) and are walked through
 * the saved header `dependencies[]`. Textures always contribute their saved
 * upload signature, because texture bytes come from the saved asset even while
 * it is open; encode progress re-indexes a Texture without changing it.
 */
export function materialClosureRevision(
  materialGuid: string,
  registry: { getByGuid(guid: string): IndexedAsset | undefined } | null | undefined,
  openDocuments: ReadonlyArray<{ ref: { kind: string; path: string }; content: unknown }>,
): string {
  const open = new Map<string, object>();
  for (const entry of openDocuments) {
    if (entry.content && typeof entry.content === "object") open.set(`${entry.ref.kind}:${entry.ref.path}`, entry.content);
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  const pending = [materialGuid];
  while (pending.length) {
    const guid = pending.pop()!;
    if (seen.has(guid)) continue;
    seen.add(guid);
    const asset = registry?.getByGuid(guid);
    if (!asset) {
      // A reference that a later import or undo may resolve.
      entries.push(`${guid}=missing`);
      continue;
    }
    const kind = CLOSURE_KINDS[asset.header.type];
    // Preview meshes and other references are not part of what the library loads.
    if (!kind) continue;
    if (kind === "texture") {
      entries.push(`${guid}=texture:${textureSignatureOf(asset)}`);
      continue;
    }
    const content = open.get(`${kind}:${asset.path}`);
    entries.push(content ? `${guid}=open:${identity(content)}` : `${guid}=saved:${identity(asset)}`);
    pending.push(...(content ? dependenciesOf(asset.header.type, content) : asset.header.dependencies));
  }
  return entries.sort().join("|");
}
