import { createSeededRng, type CameraShakeCurves, type CameraShakePayload } from "@haptic/core";
import { actorChainWorldTransform } from "./actor-world-transform";
import { CameraShakes, type WorldCameraShake } from "./camera-shakes";
import type { RuntimeComposition } from "./runtime-composition";
import type { ScriptHostServices } from "./script-host-services";

/** Separates the shakes' noise seeds from the World, script and voice streams that share the session seed. */
const SHAKE_STREAM_SALT = 0x5348414b;

/**
 * The session's camera shakes. A world shake measures from the view's location: the possessed camera actor's
 * world position, else the Layer Camera's centre on the XY plane (a Scene Layer's view: its own Layer Camera).
 */
export function createCameraShakes(rt: RuntimeComposition): CameraShakes {
  let rng: ReturnType<typeof createSeededRng> | null = null;
  return new CameraShakes({
    emit: (command) => rt.emit(command),
    hasLayer: (guid) => rt.world.findSceneLayer(guid) !== undefined,
    seed: () => {
      rng ??= createSeededRng((rt.seed ^ SHAKE_STREAM_SALT) >>> 0);
      return Math.floor(rng.nextFloat() * 0x7fffffff);
    },
    viewLocation: (target) => {
      if (target !== null) {
        const state = rt.world.findSceneLayer(target)?.camera.state;
        return state ? { x: state.x, y: state.y, z: 0 } : null;
      }
      const actor = rt.camera.cameraActor();
      if (actor) return actorChainWorldTransform(actor, (guid) => rt.world.findActor(guid))?.position ?? null;
      const state = rt.world.currentScene?.camera.state;
      return state ? { x: state.x, y: state.y, z: 0 } : null;
    },
  });
}

interface CameraShakeHostDeps {
  shakes: CameraShakes;
  /** Camera Shake assets of the current sources, by guid. */
  catalog: ReadonlyMap<string, { payload: CameraShakePayload }>;
  /** Curve assets of the current sources, by guid. */
  curves: ReadonlyMap<string, { payload: { curve: unknown } }>;
  warn(message: string): void;
}

/** Play Camera Shake and its handle nodes over the session's shakes. A shake asset that is not loaded starts none. */
export function createCameraShakeHostBindings(deps: CameraShakeHostDeps): Pick<ScriptHostServices, "cameraShakes"> {
  const warned = new Set<string>();
  const curve = (guid: string | null) => (guid ? deps.curves.get(guid)?.payload.curve ?? null : null) as never;
  return {
    cameraShakes: {
      play: (asset, options) => {
        const guid = typeof asset === "string" ? asset.trim() : "";
        if (!guid) return 0;
        const entry = deps.catalog.get(guid);
        if (!entry) {
          if (!warned.has(guid)) deps.warn(`Play Camera Shake: Camera Shake "${guid}" is not loaded, so no shake plays.`);
          warned.add(guid);
          return 0;
        }
        const payload = entry.payload;
        const curves: CameraShakeCurves = {
          intensity: curve(payload.intensityCurveGuid),
          location: curve(payload.locationCurveGuid),
          rotation: curve(payload.rotationCurveGuid),
          fov: curve(payload.fovCurveGuid),
        };
        return deps.shakes.play(payload, curves, options);
      },
      stop: (id, immediately) => deps.shakes.stop(id, immediately),
      stopAll: (immediately, target) => deps.shakes.stopAll(immediately, target),
      setPaused: (id, paused) => deps.shakes.setPaused(id, paused),
      setScale: (id, scale) => deps.shakes.setScale(id, scale),
      isPlaying: (id) => deps.shakes.isPlaying(id),
      isPaused: (id) => deps.shakes.isPaused(id),
    },
  };
}

export type { WorldCameraShake };
