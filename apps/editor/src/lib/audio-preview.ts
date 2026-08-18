export function stopAudioPreviewElement(element: {
  pause(): void;
  currentTime: number;
}): void {
  element.pause();
  element.currentTime = 0;
}
