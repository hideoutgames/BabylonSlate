/** The lines a graph node shows of its code body. */
export function codePreviewText(value: string): string {
  return value.split("\n").slice(0, 4).join("\n");
}
