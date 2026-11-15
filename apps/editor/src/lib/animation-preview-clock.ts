/** A long frame (a hidden tab) advances the preview at most this much real time. */
const MAX_FRAME_MS = 100;

export type AnimationPreviewPlayback = {
  playing: boolean;
  loop: boolean;
  speed: number;
};

/**
 * The Animation preview's playhead in authored time (the Animation's Duration): playing, paused, looping and its
 * speed. A store rather than React state, so playback re-renders only what reads the time on each frame.
 */
export class AnimationPreviewClock {
  private timeMs = 0;
  private durationMs: number;
  private playback: AnimationPreviewPlayback = { playing: true, loop: true, speed: 1 };
  private readonly listeners = new Set<() => void>();

  constructor(durationMs: number) {
    this.durationMs = Math.max(0, durationMs);
  }

  /** The playhead in ms, from 0 to the Duration. */
  get = (): number => this.timeMs;

  getPlayback = (): AnimationPreviewPlayback => this.playback;

  getDuration = (): number => this.durationMs;

  /** The playhead as a fraction of the Duration, which the clip seeks to. */
  normalised = (): number => (this.durationMs > 0 ? this.timeMs / this.durationMs : 0);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A new Duration keeps the playhead at the same point of the clip. */
  setDuration(durationMs: number): void {
    const next = Math.max(0, durationMs);
    if (next === this.durationMs) return;
    const at = this.normalised();
    this.durationMs = next;
    this.timeMs = at * next;
    this.emit();
  }

  /** Advances by real time × Speed while playing; a clip that does not loop stops on its last frame. */
  advance(realMs: number): void {
    if (!this.playback.playing || realMs <= 0) return;
    const next = this.timeMs + Math.min(realMs, MAX_FRAME_MS) * this.playback.speed;
    if (next < this.durationMs) {
      this.timeMs = next;
    } else if (this.playback.loop && this.durationMs > 0) {
      this.timeMs = next % this.durationMs;
    } else {
      this.timeMs = this.durationMs;
      this.playback = { ...this.playback, playing: false };
    }
    this.emit();
  }

  /** Moves the playhead, pausing: scrubbing holds the pose under it. */
  seek(timeMs: number): void {
    this.timeMs = Math.min(this.durationMs, Math.max(0, timeMs));
    this.playback = { ...this.playback, playing: false };
    this.emit();
  }

  /** Pauses and moves one frame on; past the end it wraps to the start. */
  step(frameMs: number): void {
    const next = this.timeMs + Math.max(0, frameMs);
    this.seek(next > this.durationMs + 1e-6 ? 0 : next);
  }

  /** Returns to the start, playing or paused as before. */
  restart(): void {
    this.timeMs = 0;
    this.emit();
  }

  /** Play from the end of a clip that does not loop starts it again. */
  setPlaying(playing: boolean): void {
    if (playing && !this.playback.loop && this.timeMs >= this.durationMs) this.timeMs = 0;
    this.playback = { ...this.playback, playing };
    this.emit();
  }

  setLoop(loop: boolean): void {
    this.playback = { ...this.playback, loop };
    this.emit();
  }

  setSpeed(speed: number): void {
    this.playback = { ...this.playback, speed };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The 0-based frame shown at `timeMs` of a clip `frameCount` frames long: each frame holds an equal share of the
 * Duration, and the end shows the last.
 */
export function animationPreviewFrameAt(timeMs: number, durationMs: number, frameCount: number): number {
  if (frameCount <= 1 || durationMs <= 0) return 0;
  return Math.min(frameCount - 1, Math.floor((timeMs / durationMs) * frameCount + 1e-6));
}
