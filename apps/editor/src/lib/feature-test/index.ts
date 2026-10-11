import {
  createDefaultScene,
  lookAtRotation,
  type ProjectSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  actor,
  createFeatureTestContext,
  meshComp,
  SCENE_SAVE_ORDER,
  tf,
  type FeatureTestContext,
  type FeatureTestHost,
} from "./context";
import { FEATURE_TEST_STRESS_CAMERA } from "./layout";
import { importFeatureTestContent } from "./imports";
import { applyFeatureTestProjectSettings } from "./settings";
import { buildFeatureTestAi, featureTestNavBakeInput, placeFeatureTestAi } from "./ai";
import { buildFeatureTestAnimation, placeFeatureTestAnimation } from "./animation";
import { buildFeatureTestAudio, placeFeatureTestAudio } from "./audio";
import { buildFeatureTestMaterials, placeFeatureTestMaterials } from "./materials";
import { buildFeatureTestParticles, placeFeatureTestParticles } from "./particles";
import { buildFeatureTestPhysics, placeFeatureTestPhysics } from "./physics";
import { buildFeatureTestRendering, placeFeatureTestRendering } from "./rendering";
import { buildFeatureTestSceneLayers, placeFeatureTestSceneLayers } from "./scene-layers";
import {
  buildFeatureTestScripting,
  buildFeatureTestScriptingTypes,
  placeFeatureTestScripting,
} from "./scripting";
import { buildFeatureTestTwoD } from "./two-d";
import { buildFeatureTestWorld, placeFeatureTestWorld } from "./world";

export type { FeatureTestHost } from "./context";

export interface FeatureTestScaffoldResult {
  /** Apply FeatureTest project settings (class ids, guids, render, tags) to the scaffolded project. */
  applySettings(settings: ProjectSettings): ProjectSettings;
}

/**
 * Build the FeatureTest starter on top of the Basic 3D scaffold: every engine
 * feature in fixed zones of the main scene, plus a 2D scene, a streamed
 * sub-scene and Scene Layers. Assets are created before their referrers so
 * header dependencies resolve; scene documents save last.
 */
export async function applyFeatureTestScaffold(options: {
  host: FeatureTestHost;
  mainScenePath: string;
}): Promise<FeatureTestScaffoldResult> {
  const mainScene = (await options.host.loadDocument("scene", options.mainScenePath)) as SerializedScene;
  const stressScene = createStressScene();
  const ctx = createFeatureTestContext({
    host: options.host,
    mainScene,
    mainScenePath: options.mainScenePath,
    stressScene,
  });
  await ctx.addSceneDocument({
    kind: "scene",
    folder: "Scenes",
    name: "FT_Stress",
    content: stressScene,
    order: SCENE_SAVE_ORDER.scene,
  });

  // Assets, ordered so every reference already exists when its referrer is written.
  await importFeatureTestContent(ctx);
  await buildFeatureTestAudio(ctx);
  await buildFeatureTestMaterials(ctx);
  await buildFeatureTestScriptingTypes(ctx);
  await buildFeatureTestScripting(ctx);
  await buildFeatureTestRendering(ctx);
  await buildFeatureTestPhysics(ctx);
  await buildFeatureTestWorld(ctx);
  await buildFeatureTestAnimation(ctx);
  await buildFeatureTestParticles(ctx);
  await buildFeatureTestAi(ctx);
  await buildFeatureTestTwoD(ctx);
  await buildFeatureTestSceneLayers(ctx);

  // Main scene placement, zone by zone.
  placeHub(ctx);
  await placeFeatureTestRendering(ctx);
  await placeFeatureTestMaterials(ctx);
  await placeFeatureTestPhysics(ctx);
  await placeFeatureTestWorld(ctx);
  await placeFeatureTestAnimation(ctx);
  await placeFeatureTestParticles(ctx);
  await placeFeatureTestAudio(ctx);
  await placeFeatureTestAi(ctx);
  await placeFeatureTestScripting(ctx);
  await placeFeatureTestSceneLayers(ctx);

  await saveSceneDocuments(ctx);
  return { applySettings: (settings) => applyFeatureTestProjectSettings(ctx, settings) };
}

/** Hub zone: title, floor and the Basic 3D Mannequin at the origin. */
function placeHub(ctx: FeatureTestContext): void {
  const hub = ctx.zone("hub");
  hub.floor();
  const mannequin = ctx.mainScene.actors.find((actor) => actor.id === ctx.assets.mannequin.actorId);
  if (mannequin) mannequin.folderId = hub.folderId;
}

/** Heavy workload scene: default camera re-aimed over the regions, sky, sun and one floor (x -64..72). */
function createStressScene(): SerializedScene {
  const scene = createDefaultScene("3d");
  scene.name = "FT_Stress";
  const camera = scene.actors.find((entry) => entry.id === scene.settings.mainCameraActorId);
  if (camera) {
    camera.transform = tf(FEATURE_TEST_STRESS_CAMERA.position, {
      rotation: lookAtRotation(FEATURE_TEST_STRESS_CAMERA.position, FEATURE_TEST_STRESS_CAMERA.target),
    });
  }
  // Basic 3D's empty placeholder actor has no role here.
  scene.actors = scene.actors.filter((entry) => entry.components.length > 0 || entry.id === camera?.id);
  scene.actors.push(
    actor("ft-stress-floor", "Stress Floor", tf([4, -0.15, 0], { scale: [136 / 1.5, 0.3 / 1.5, 40 / 1.5] }), [
      meshComp("ft-stress-floor-mesh", "box", { collision: "simple" }),
    ]),
  );
  return scene;
}

async function saveSceneDocuments(ctx: FeatureTestContext): Promise<void> {
  for (const entry of [...ctx.sceneDocuments].sort((a, b) => a.order - b.order)) {
    await ctx.host.saveDocument(entry.kind, entry.path, entry.content);
  }
  await ctx.host.saveDocument("scene", ctx.mainScenePath, ctx.mainScene);
  const bake = featureTestNavBakeInput(ctx.mainScene);
  if (bake) {
    const bytes = await ctx.host.generateNavMesh(bake);
    await ctx.host.writeSceneNavmeshChunk(
      ctx.mainScenePath,
      bytes,
      ctx.mainScene as unknown as Record<string, unknown>,
    );
  }
}
