import { editorKtx2PublicBase } from "./public-engine-assets";

/**
 * Found transcoders, by base path, for the page's lifetime: a build ships its
 * transcoder files and they do not leave while the page runs. A probe that
 * finds them missing is not kept, so a transient failure is asked again at
 * the next project open.
 */
const found = new Map<string, Promise<boolean>>();
let latestRequest = 0;

/**
 * Probe the editor's transcoder files and apply the answer, at most once per
 * page once found. Only the latest open applies its answer, so a slow probe
 * from an earlier open never overrides a later one.
 */
export async function applyEditorKtx2TranscoderAvailability(
  probe: (basePath: string) => Promise<boolean>,
  apply: (available: boolean) => Promise<void>,
): Promise<void> {
  const request = ++latestRequest;
  const base = editorKtx2PublicBase();
  let answer = found.get(base);
  if (!answer) {
    const pending = probe(base);
    answer = pending;
    found.set(base, pending);
    void pending.then((available) => { if (!available && found.get(base) === pending) found.delete(base); },
      () => { if (found.get(base) === pending) found.delete(base); });
  }
  const available = await answer;
  if (request === latestRequest) await apply(available);
}
