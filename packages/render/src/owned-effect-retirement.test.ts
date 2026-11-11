import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { afterEach, expect, it, vi } from "vitest";
import { disposeKeepingLinkingEffects } from "./owned-effect-retirement";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

function compile(engine: NullEngine, colour: string): Effect {
  return engine.createEffect(
    { vertexSource: "void main(){gl_Position=vec4(0.0);}", fragmentSource: `void main(){gl_FragColor=vec4(${colour});}` },
    { attributes: [], uniformsNames: [], samplers: [], defines: "", fallbacks: null, onCompiled: null, onError: null },
    engine,
  );
}

/** The driver is the external boundary: the program links in parallel and has not finished. */
function stillLinking(effect: Effect): void {
  vi.spyOn(effect, "getPipelineContext").mockReturnValue({ isAsync: true, program: {} } as unknown as ReturnType<Effect["getPipelineContext"]>);
  vi.spyOn(effect, "isReady").mockReturnValue(false);
}

it("keeps an Effect whose program still links when its owner is disposed, until the compile settles", async () => {
  const engine = new NullEngine();
  engines.push(engine);
  const linking = compile(engine, "1.0");
  const ready = compile(engine, "0.5");
  stillLinking(linking);
  // The owner (a post-process chain released right after it was built) holds one reference to each.
  disposeKeepingLinkingEffects([linking, ready, linking, null], () => { linking.dispose(); ready.dispose(); });
  expect(ready.isDisposed).toBe(true);
  expect(linking.isDisposed).toBe(false);
  linking.onCompileObservable.notifyObservers(linking);
  // The release waits for Babylon's finalizer to return.
  expect(linking.isDisposed).toBe(false);
  await Promise.resolve();
  expect(linking.isDisposed).toBe(true);
});

it("leaves an Effect another owner still draws with alive, whether or not it links", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const shared = compile(engine, "1.0");
  shared._refCount += 1;
  stillLinking(shared);
  disposeKeepingLinkingEffects([shared], () => shared.dispose());
  expect(shared.isDisposed).toBe(false);
  expect(shared._refCount).toBe(1);
});
