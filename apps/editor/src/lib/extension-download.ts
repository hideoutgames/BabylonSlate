/** Same download interaction as Plugins, with a distinct editor package format. */
export function downloadExtensionArchive(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    const filename = [...name].map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").replace(/[\\/:<>"|?*]/g, "_");
    anchor.download = `${filename || "extension"}.babextension`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
