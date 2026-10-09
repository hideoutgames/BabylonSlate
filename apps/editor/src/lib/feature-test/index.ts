import type { ProjectSettings, SerializedScene } from "@babylonslate/core";
import { createFeatureTestContext, type FeatureTestContext, type FeatureTestHost } from "./context";
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
  const ctx = createFeatureTestContext({ host: options.host, mainScene, mainScenePath: options.mainScenePath });

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
