export function playChromeLaunchLabel(previewBuild: boolean): "Preview" | "Play" {
  return previewBuild ? "Preview" : "Play";
}

export function playChromeLaunchAriaLabel(
  previewBuild: boolean,
  canPlay: boolean,
): string {
  if (canPlay) return playChromeLaunchLabel(previewBuild);
  return previewBuild
    ? "Preview (Set Startup Scene)"
    : "Play (Open a Scene)";
}
