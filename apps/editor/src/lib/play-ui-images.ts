export interface UiTextureAssetSource {
  guid: string;
  path: string;
  type: string;
  chunks?: readonly { id: string; mime?: string }[];
}

export function mimeForUiTexture(mime: string | undefined): string {
  if (mime && mime.startsWith("image/")) return mime;
  return "image/png";
}

function chunkMime(
  asset: UiTextureAssetSource,
  chunkId: string,
): string | undefined {
  return asset.chunks?.find((chunk) => chunk.id === chunkId)?.mime;
}

export type UiImageIssueReason = "missing-asset" | "missing-chunk" | "wrong-type";

export interface UiImageIssue {
  guid: string;
  reason: UiImageIssueReason;
}

export function uiImageIssueMessage(issue: UiImageIssue): string {
  if (issue.reason === "missing-chunk") {
    return `Texture ${issue.guid} has no pixels or source chunk.`;
  }
  if (issue.reason === "wrong-type") {
    return `Asset ${issue.guid} is not a Texture.`;
  }
  return `Texture ${issue.guid} is missing from the project.`;
}

/** Load Texture pixels and report unresolved / missing-chunk issues. */
export async function resolveUiImages(
  imageGuids: readonly string[],
  assets: readonly UiTextureAssetSource[],
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<{ urls: Map<string, string>; issues: UiImageIssue[] }> {
  const byGuid = new Map(assets.map((asset) => [asset.guid, asset] as const));
  const urls = new Map<string, string>();
  const issues: UiImageIssue[] = [];
  for (const guid of imageGuids) {
    if (!guid || urls.has(guid)) continue;
    const asset = byGuid.get(guid);
    if (!asset) {
      issues.push({ guid, reason: "missing-asset" });
      continue;
    }
    if (asset.type !== "Texture") {
      issues.push({ guid, reason: "wrong-type" });
      continue;
    }
    const pixels = await readChunk(asset.path, "pixels");
    const source =
      pixels && pixels.byteLength > 0
        ? pixels
        : await readChunk(asset.path, "source");
    if (!source || source.byteLength === 0) {
      issues.push({ guid, reason: "missing-chunk" });
      continue;
    }
    const mime = mimeForUiTexture(
      chunkMime(asset, pixels && pixels.byteLength > 0 ? "pixels" : "source"),
    );
    const copy = new Uint8Array(source);
    urls.set(guid, URL.createObjectURL(new Blob([copy], { type: mime })));
  }
  return { urls, issues };
}

/** Load Texture pixels (then source) as blob URLs for Babylon GUI Image. */
export async function collectUiImageUrls(
  imageGuids: readonly string[],
  assets: readonly UiTextureAssetSource[],
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Map<string, string>> {
  const { urls } = await resolveUiImages(imageGuids, assets, readChunk);
  return urls;
}

export function revokeUiImageUrls(urls: Map<string, string>): void {
  for (const url of urls.values()) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
}
