/**
 * Packed FontFace from asset bytes (engineplan §15.1). Do not use blob URLs —
 * `FontFace` accepts a BufferSource so the packed payload stays in memory.
 */
export type PackedFontHost = {
  FontFace: typeof FontFace;
  fonts: Pick<FontFaceSet, "add">;
};

function defaultHost(): PackedFontHost | null {
  if (typeof FontFace === "undefined") return null;
  if (typeof document === "undefined" || !document.fonts) return null;
  return { FontFace, fonts: document.fonts };
}

export async function registerPackedFonts(
  fontBytes: Map<string, Uint8Array>,
  host: PackedFontHost | null = defaultHost(),
): Promise<void> {
  if (!host) return;
  for (const [guid, bytes] of fontBytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const face = new host.FontFace(guid, copy);
    host.fonts.add(await face.load());
  }
}
