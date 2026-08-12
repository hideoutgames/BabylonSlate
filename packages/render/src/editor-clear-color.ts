import { Color4 } from "@babylonjs/core";

export type EditorColorScheme = "light" | "dark";

/** Neutral `--background`: light `oklch(1 0 0)`, dark `oklch(0.145 0 0)` ≈ `#242424`. */
export function editorClearColor(scheme: EditorColorScheme): Color4 {
  if (scheme === "light") {
    return new Color4(1, 1, 1, 1);
  }
  return new Color4(36 / 255, 36 / 255, 36 / 255, 1);
}

export function applyEditorClearColor(
  scene: { clearColor: Color4 },
  scheme: EditorColorScheme,
): void {
  scene.clearColor = editorClearColor(scheme);
}

export function documentEditorColorScheme(): EditorColorScheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
