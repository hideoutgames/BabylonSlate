export const PLAY_AUDIO_UNLOCK_HINT = "Click the game view to enable audio";

export function shouldShowPlayAudioUnlockHint(stats: {
  queued: number;
  unlocked: boolean;
}): boolean {
  return stats.queued > 0 && !stats.unlocked;
}
