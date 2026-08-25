export function playChromeLaunchLabel(previewBuild: boolean): "Preview" | "Play" {
  return previewBuild ? "Preview" : "Play";
}

export function playChromeLaunchAriaLabel(
  previewBuild: boolean,
  canPlay: boolean,
  options?: { playFromScene?: boolean },
): string {
  if (canPlay) return playChromeLaunchLabel(previewBuild);
  const prefix = playChromeLaunchLabel(previewBuild);
  if (!previewBuild && options?.playFromScene !== false) {
    return `${prefix} (Open a Scene)`;
  }
  return `${prefix} (Set Startup Scene)`;
}
