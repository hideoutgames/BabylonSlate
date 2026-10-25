import { isInfiniteLoopError } from "@haptic/debugger";
import type { RawInputEvent } from "@haptic/input";
import type { Actor } from "@haptic/object-model";
import { actorGuidIndex } from "./actor-world-transform";
import type { RuntimeComposition } from "./runtime-composition";

/**
 * One fixed step; `TickPipeline` owns the gate, timing, stats and trace
 * around it. The step (fixed step × time dilation) is captured once here and
 * passed to every phase (and advances the water clock with the World clock),
 * so a dilation change made during the tick applies from the next tick.
 * Phases, in order:
 * 1. Input: drain and resolve queued input, reset prints, log gamepad changes.
 * 2. World (timed): tweens, text reveal, painters, Scene Layer focus, the
 *    World tick (actors, then physics through `onPhysics`), deferred owner
 *    work and streamed Scenes. The tick ends here when it stopped the session.
 * 3. Scene systems (timed): tween cleanup, Delays, animation graphs, tile
 *    animation time, behaviour trees and the crowd. The tick also ends here
 *    when one of them stopped the session.
 * 4. Component commands changed during the tick: painters, text reveal, deformers.
 * 5. Publish: advance the frame id, then the pose snapshot and debug views;
 *    `TickPipeline` records stats and the trace frame last.
 */
export function runTick(rt: RuntimeComposition): void {
  rt.breakpointReported = false;
  const timeDilation = rt.timeDilation;
  const simDt = simulationDt(rt);
  rt.world.clock.dt = simDt;
  rt.waterClock.advance(simDt);
  // Voices play in real time, so their age (and the clock restored voices
  // waiting for the audio unlock catch up by) follows the undilated step.
  rt.voices.advance(rt.dt);
  if (rt.voices.hasRestoredVoices) rt.emit({ type: "audioSimTime", seconds: rt.voices.audioTime });
  const pending = resolveTickInput(rt, simDt);
  rt.ticks.beginPhaseTiming();
  tickWorld(rt, pending, simDt);
  if (rt.stopped) return;
  tickSceneSystems(rt, simDt);
  if (rt.stopped) return;
  rt.ticks.closePhaseTiming();
  rt.scriptDebug.flush(rt.world.clock.tickIndex);
  flushComponentCommands(rt);
  const completedFrameId = rt.frameId;
  rt.frameId += 1;
  publishTick(rt);
  rt.ticks.finishTick(completedFrameId, pending, timeDilation);
}

/** Tick phase 1: returns the raw events this tick consumed. */
function resolveTickInput(rt: RuntimeComposition, simDt: number): RawInputEvent[] {
  // Consume every event queued since the last tick. Gating on event.tick
  // dropped Play worker input: the host stamped with a wall-clock index
  // (performance.now()/16.67) while World.clock.tickIndex stayed small,
  // and drain() discarded the "future" events instead of deferring them.
  // Replay still works because it feeds one tick of events at a time.
  if (rt.bindingsUseDeviceMotion) requestDeviceMotion(rt);
  const pending = rt.input.drain();
  // Gestures and touch velocity follow real time: the undilated step.
  rt.resolvedInput = rt.resolver.resolve(pending, simDt, rt.dt);
  rt.connectionBox.current = rt.resolvedInput.gamepadConnections;
  rt.ticks.clearPrints();
  for (const connection of rt.resolvedInput.gamepadConnections) {
    rt.emit({
      type: "log",
      severity: "log",
      category: "input",
      message: connection.connected
        ? `gamepad ${connection.gamepadIndex} connected`
        : `gamepad ${connection.gamepadIndex} disconnected`,
      frameId: rt.frameId,
    });
  }
  return pending;
}

/** Sensors stay off until a game reads them; iOS also asks the player first. */
export function requestDeviceMotion(rt: RuntimeComposition): void {
  if (rt.deviceMotionRequested) return;
  rt.deviceMotionRequested = true;
  rt.emit({ type: "requestDeviceMotion", frameId: rt.frameId });
}

/** Tick phase 2. An infinite-loop abort ends the phase early. */
function tickWorld(rt: RuntimeComposition, pending: readonly RawInputEvent[], simDt: number): void {
  rt.loopGuard.reset();
  rt.tweens.advance(simDt);
  rt.textAppear.advance(rt.world, simDt, (actor) => rt.admission.canTickActor(actor));
  rt.painters.beginFrame(rt.world, (actor) => rt.admission.canTickActor(actor));
  try {
    rt.overlay.tickFocus(pending, rt.resolvedInput, simDt);
    rt.world.tick();
    // World committed actors queued by this tick; deliver their deferred
    // notifications after actor and component creation hooks have completed.
    rt.admission.flush();
    if (rt.admission.canTickScene()) rt.streams.tickScenes(simDt, () => rt.admission.canTickScene());
  } catch (error) {
    if (!isInfiniteLoopError(error)) throw error;
  }
}

/** Tick phase 3, timed as `sceneSystems` apart from the World's post-physics phase. */
function tickSceneSystems(rt: RuntimeComposition, simDt: number): void {
  rt.ticks.markPhase("sceneSystems");
  rt.tweens.cancelInvalid();
  rt.delays.advance(simDt);
  if (rt.admission.canTickScene() || rt.admission.hasReadyLayers()) rt.animGraphs.tick(simDt);
  if (rt.admission.canTickScene() || rt.admission.hasReadyLayers()) {
    rt.tilemapAnimationTimeMs += simDt * 1000;
    if (rt.hasAnimatedTiles) rt.emit({ type: "tilemapAnimationTime", elapsedMs: rt.tilemapAnimationTimeMs });
    // Only behaviour trees and the crowd read the frame index.
    rt.navFrameActors = rt.navigation.active || rt.behaviourTrees.hasTrees ? liveActorGuidIndex(rt) : null;
    try {
      rt.behaviourTrees.tick(simDt);
      if (rt.navigation.active && rt.admission.canTickScene()) {
        rt.navigation.tickCrowd(rt.navFrameActors ?? liveActorGuidIndex(rt), simDt);
      }
    } finally {
      rt.navFrameActors = null;
    }
  }
}

function liveActorGuidIndex(rt: RuntimeComposition): Map<string, Actor> {
  const revision = rt.world.structuralRevision;
  if (rt.guidIndexCache?.revision !== revision) {
    rt.guidIndexCache = { revision, index: actorGuidIndex(rt.world.getActors()) };
  }
  return rt.guidIndexCache.index;
}

/** Tick phase 4. */
function flushComponentCommands(rt: RuntimeComposition): void {
  flushPainters(rt);
  flushTextAppear(rt);
  rt.renderEmitter.flushDeformers();
  rt.renderEmitter.flushComponentTransforms();
}

/** Tick phase 5, after the frame id advanced. */
function publishTick(rt: RuntimeComposition): void {
  if (rt.admission.canTickScene() || rt.admission.hasReadyLayers()) {
    rt.snapshots.publishTick();
    rt.physics.emitDebugColliders();
    rt.navigation.emitDebug();
    rt.behaviourTrees.emitSnapshot();
  }
}

function simulationDt(rt: RuntimeComposition): number {
  return rt.dt * rt.timeDilation;
}

export function flushPainters(rt: RuntimeComposition): void {
  rt.painters.flush((component, painter) => {
    const slotId = component.owner ? rt.actorSlot(component.owner) : undefined;
    if (slotId !== undefined) rt.emit({ type: "setPainter2D", slotId, componentId: component.guid, painter });
  });
}

export function flushTextAppear(rt: RuntimeComposition): void {
  rt.textAppear.flush((component, progress) => {
    const slotId = component.owner ? rt.actorSlot(component.owner) : undefined;
    if (slotId !== undefined) rt.emit({ type: "setText2DAppear", slotId, componentId: component.guid, progress });
  });
}
