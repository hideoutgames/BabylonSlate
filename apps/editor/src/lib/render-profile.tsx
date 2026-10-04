import {
  Profiler,
  type FunctionComponent,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";

/** React commits that rendered one profiled region, with React's own timings. */
export interface RenderProfileRegion {
  /** Commits in which anything inside the region rendered. */
  commits: number;
  mounts: number;
  updates: number;
  /** Commits scheduled synchronously from the previous commit's layout phase. */
  nestedUpdates: number;
  /** Sum of `actualDuration`: time spent rendering the region in those commits. */
  actualMs: number;
  /** Sum of `baseDuration`: estimated cost of re-rendering the whole region unmemoized. */
  baseMs: number;
  maxActualMs: number;
}

export interface RenderProfile {
  /** False when this build mounts no Profilers, so every count stays zero. */
  enabled: boolean;
  /** Distinct React commits that rendered at least one profiled region. */
  commits: number;
  regions: Record<string, RenderProfileRegion>;
}

export interface RenderProfileRecorder {
  onRender: ProfilerOnRenderCallback;
  snapshot: () => RenderProfile;
  reset: () => void;
}

export function createRenderProfileRecorder(
  enabled: boolean,
): RenderProfileRecorder {
  let regions = new Map<string, RenderProfileRegion>();
  let commits = 0;
  let lastCommitTime: number | null = null;
  return {
    onRender: (id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
      // React calls every Profiler of one commit before the next commit
      // starts, and they share its commit time.
      if (commitTime !== lastCommitTime) {
        commits += 1;
        lastCommitTime = commitTime;
      }
      let region = regions.get(id);
      if (!region) {
        region = {
          commits: 0,
          mounts: 0,
          updates: 0,
          nestedUpdates: 0,
          actualMs: 0,
          baseMs: 0,
          maxActualMs: 0,
        };
        regions.set(id, region);
      }
      region.commits += 1;
      if (phase === "mount") region.mounts += 1;
      else if (phase === "nested-update") region.nestedUpdates += 1;
      else region.updates += 1;
      region.actualMs += actualDuration;
      region.baseMs += baseDuration;
      region.maxActualMs = Math.max(region.maxActualMs, actualDuration);
    },
    snapshot: () => ({
      enabled,
      commits,
      regions: Object.fromEntries(
        [...regions].map(([id, region]) => [id, { ...region }]),
      ),
    }),
    reset: () => {
      regions = new Map();
      commits = 0;
      lastCommitTime = null;
    },
  };
}

/** Wrap trees and component maps in Profilers that report to `onRender`. */
export function createRenderProfileRegions(onRender: ProfilerOnRenderCallback) {
  return {
    region: (id: string, node: ReactNode): ReactNode => (
      <Profiler id={id} onRender={onRender}>
        {node}
      </Profiler>
    ),
    /** One Profiler per entry, named `${prefix}${key}`; wrappers are created once. */
    components: <P extends object>(
      prefix: string,
      components: Record<string, FunctionComponent<P>>,
    ): Record<string, FunctionComponent<P>> =>
      Object.fromEntries(
        Object.entries(components).map(([key, Component]) => {
          const id = `${prefix}${key}`;
          const Profiled: FunctionComponent<P> = (props) => (
            <Profiler id={id} onRender={onRender}>
              <Component {...props} />
            </Profiler>
          );
          Profiled.displayName = `RenderProfile(${id})`;
          return [key, Profiled];
        }),
      ),
  };
}

/**
 * Profiler callbacks only run in React builds compiled with profiling: the
 * Vite dev server, or a build made with `VITE_REACT_PROFILING=true` (which
 * aliases `react-dom/client` to `react-dom/profiling`). Both values are
 * replaced at build time, and test mode must also be on, so the default and
 * distribution builds evaluate this to false once and mount no Profilers.
 */
const RENDER_PROFILING_ENABLED =
  (import.meta.env.DEV || import.meta.env.VITE_REACT_PROFILING === "true") &&
  isTestModeEnabled();

const recorder = createRenderProfileRecorder(RENDER_PROFILING_ENABLED);
const regions = RENDER_PROFILING_ENABLED
  ? createRenderProfileRegions(recorder.onRender)
  : null;

/** Returns `node` itself unless editor-edit profiling is enabled. */
export function profileRegion(id: string, node: ReactNode): ReactNode {
  return regions ? regions.region(id, node) : node;
}

/** Returns `components` itself unless editor-edit profiling is enabled. */
export function profileComponents<P extends object>(
  prefix: string,
  components: Record<string, FunctionComponent<P>>,
): Record<string, FunctionComponent<P>> {
  return regions ? regions.components(prefix, components) : components;
}

/** Per-region totals since the last reset (test host `renderProfile()`). */
export function renderProfile(): RenderProfile {
  return recorder.snapshot();
}

export function resetRenderProfile(): void {
  recorder.reset();
}
