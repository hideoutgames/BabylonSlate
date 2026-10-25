import { currentAreaEmissionChunk, type IndexedAsset } from "@haptic/assets";

export type AreaEmissionPreparation = { state: "preparing" } | { state: "failed"; message: string };
type Prepare = (guid: string) => Promise<void>;

/** One job per Texture source across views; a replaced image prepares again. */
const preparations = new Map<string, AreaEmissionPreparation>();
const listeners = new Set<() => void>();
let revision = 0;
/** Advanced when a project closes, so jobs it started cannot record into the next project. */
let generation = 0;

function sourceKey(asset: IndexedAsset): string | undefined {
  if (asset.header.type !== "Texture") return undefined;
  const source = asset.header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
  return source && `${asset.header.guid}:${source.sha256}`;
}

function publish(): void {
  revision++;
  for (const listener of listeners) listener();
}

export function subscribeAreaEmissionPreparations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function areaEmissionPreparationsRevision(): number {
  return revision;
}

/** The automatic job for an unprepared Texture; undefined once prepared or never started. */
export function areaEmissionPreparation(asset: IndexedAsset | undefined): AreaEmissionPreparation | undefined {
  if (!asset || currentAreaEmissionChunk(asset.header)) return undefined;
  const key = sourceKey(asset);
  return key ? preparations.get(key) : undefined;
}

/**
 * Prepare referenced emission Textures that have none, as Prepare Emission
 * does, so an assigned Texture lights the emitter instead of disabling it.
 * A failure is kept for its source and not retried automatically.
 */
export function prepareReferencedAreaEmissions(guids: readonly string[], lookup: (guid: string) => IndexedAsset | undefined, prepare: Prepare): void {
  for (const guid of guids) {
    const asset = lookup(guid);
    const key = asset && sourceKey(asset);
    if (!key || currentAreaEmissionChunk(asset.header) || preparations.has(key)) continue;
    preparations.set(key, { state: "preparing" });
    publish();
    const started = generation;
    void prepare(guid).then(
      () => {
        if (started !== generation) return;
        preparations.delete(key);
        publish();
      },
      (error: unknown) => {
        if (started !== generation) return;
        preparations.set(key, { state: "failed", message: error instanceof Error ? error.message : String(error) });
        publish();
      },
    );
  }
}

/** Forget every job when the project closes: a reopened project retries failed sources. */
export function resetAreaEmissionPreparations(): void {
  generation++;
  if (preparations.size === 0) return;
  preparations.clear();
  publish();
}

/** Inspector note for an assigned emission Texture without prepared data. */
export function areaEmissionStatusDescription(asset: IndexedAsset | undefined): string | undefined {
  if (!asset || asset.header.type !== "Texture" || currentAreaEmissionChunk(asset.header)) return undefined;
  const preparation = areaEmissionPreparation(asset);
  if (preparation?.state === "preparing") return "Preparing emission data. The light turns on when it finishes.";
  if (preparation?.state === "failed") return `Emission data could not be prepared: ${preparation.message} The light stays off.`;
  return "Emission data is not prepared, so the light stays off. Open the Texture and choose Prepare Emission.";
}
