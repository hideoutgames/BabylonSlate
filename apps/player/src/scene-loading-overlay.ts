import type { SceneLoadProgress } from "@babylonslate/render";

/** Native modal semantics keep game input behind loading while Stop stays available. */
export function mountPlayerSceneLoading(parent: HTMLElement, onStop: () => void) {
  const dialog = document.createElement("dialog");
  dialog.dataset.testid = "scene-loading-dialog";
  dialog.setAttribute("aria-label", "Loading Scene");
  dialog.style.cssText = "color:#fff;background:#18181b;border:1px solid #3f3f46;border-radius:8px;padding:16px;max-width:calc(100vw - 32px);font:14px/1.4 system-ui,sans-serif;";
  const title = document.createElement("h2");
  title.textContent = "Loading Scene";
  title.style.cssText = "margin:0 0 8px;font-size:16px;";
  const phase = document.createElement("p");
  phase.setAttribute("role", "status");
  phase.style.cssText = "margin:0 0 8px;";
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.setAttribute("aria-label", "Scene Loading Progress");
  progress.style.cssText = "display:block;width:100%;margin-bottom:12px;";
  const stop = document.createElement("button");
  stop.textContent = "Stop";
  stop.type = "button";
  stop.style.cssText = "min-width:44px;min-height:44px;padding:4px 12px;border:1px solid #71717a;border-radius:4px;color:inherit;background:transparent;font:inherit;";
  stop.addEventListener("click", onStop);
  // Escape has the same explicit cancellation semantics as Stop.
  const cancel = (event: Event) => { event.preventDefault(); onStop(); };
  dialog.addEventListener("cancel", cancel);
  dialog.append(title, phase, progress, stop);
  parent.append(dialog);
  let disposed = false;
  return {
    update(state: SceneLoadProgress | null): void {
      if (disposed) return;
      if (!state) { if (dialog.open) dialog.close(); return; }
      phase.textContent = state.phase;
      progress.value = state.progress;
      dialog.dataset.sceneLoadId = String(state.sceneLoadId);
      if (!dialog.open) dialog.showModal();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop.removeEventListener("click", onStop);
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
