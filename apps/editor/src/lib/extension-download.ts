/** Same download interaction as Plugins, with a distinct editor package format. */
export function downloadExtensionArchive(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.replace(/[\\/:<>"|?*\u0000-\u001f]/g, "_") || "extension"}.babextension`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
