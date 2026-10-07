import { ActionManager, ExecuteCodeAction, FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { renderSceneWithGameTime, setSceneGameTimePaused } from "./scene-game-time";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });

it("holds native frame and intersection actions until the next gameplay presentation", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const left = MeshBuilder.CreateBox("left", {}, scene);
  const right = MeshBuilder.CreateBox("right", {}, scene);
  const everyFrame = vi.fn();
  const entered = vi.fn();
  const exited = vi.fn();
  scene.actionManager = new ActionManager(scene);
  scene.actionManager.registerAction(new ExecuteCodeAction(ActionManager.OnEveryFrameTrigger, everyFrame));
  left.actionManager = new ActionManager(scene);
  left.actionManager.registerAction(new ExecuteCodeAction({ trigger: ActionManager.OnIntersectionEnterTrigger, parameter: right }, entered));
  left.actionManager.registerAction(new ExecuteCodeAction({ trigger: ActionManager.OnIntersectionExitTrigger, parameter: right }, exited));
  renderSceneWithGameTime(scene);
  expect(everyFrame).toHaveBeenCalledOnce();
  expect(entered).toHaveBeenCalledOnce();
  setSceneGameTimePaused(scene, true);
  right.position.x = 10;
  renderSceneWithGameTime(scene);
  renderSceneWithGameTime(scene);
  expect(everyFrame).toHaveBeenCalledOnce();
  expect(exited).not.toHaveBeenCalled();
  setSceneGameTimePaused(scene, false);
  renderSceneWithGameTime(scene);
  expect(everyFrame).toHaveBeenCalledTimes(2);
  expect(exited).toHaveBeenCalledOnce();
});
