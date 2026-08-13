export function fitContainedRect(
  containerWidth: number,
  containerHeight: number,
  aspectWidth: number,
  aspectHeight: number,
): { width: number; height: number } {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    aspectWidth <= 0 ||
    aspectHeight <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const target = aspectWidth / aspectHeight;
  const container = containerWidth / containerHeight;
  if (container > target) {
    const height = containerHeight;
    return { width: Math.round(height * target), height };
  }
  const width = containerWidth;
  return { width, height: Math.round(width / target) };
}

export function applyPlayPreviewCanvasLayout(options: {
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  followSystem: boolean;
  aspectWidth: number;
  aspectHeight: number;
}): void {
  const { overlay, canvas, followSystem, aspectWidth, aspectHeight } = options;
  overlay.classList.toggle("bg-black", !followSystem);
  overlay.classList.toggle("bg-background", followSystem);
  overlay.classList.toggle("items-center", !followSystem);
  overlay.classList.toggle("justify-center", !followSystem);
  canvas.classList.toggle("h-full", followSystem);
  canvas.classList.toggle("w-full", followSystem);
  if (followSystem) {
    canvas.style.width = "";
    canvas.style.height = "";
    return;
  }
  const fitted = fitContainedRect(
    overlay.clientWidth,
    overlay.clientHeight,
    aspectWidth,
    aspectHeight,
  );
  canvas.style.width = `${fitted.width}px`;
  canvas.style.height = `${fitted.height}px`;
}
