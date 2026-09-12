import "./gltf-loader";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";
import {
  gltfAnimationClips,
  type GlbBrowseAnimation,
} from "@babylonslate/assets";
import { gltfLoaderExtension, packedGltfBytes } from "./model-mesh";

/** Load the authored model pose. Playback belongs to the caller, never the loader. */
export async function loadModelContainer(
  scene: Scene,
  bytes: Uint8Array,
  name: string,
) {
  let clips: GlbBrowseAnimation[] = [];
  const targetFps = 60;
  const container = await LoadAssetContainerAsync(
    packedGltfBytes(bytes),
    scene,
    {
      pluginExtension: gltfLoaderExtension(bytes),
      name,
      pluginOptions: {
        gltf: {
          animationStartMode: GLTFLoaderAnimationStartMode.NONE,
          targetFps,
          onParsed: (data) => {
            clips = gltfAnimationClips(data.json as Record<string, unknown>);
            const animations =
              (data.json as { animations?: { name?: string }[] }).animations ??
              [];
            for (const [index, animation] of animations.entries())
              animation.name = clips[index]!.name;
          },
        },
      },
    },
  );
  // glTF normalizes groups to frame zero, inserting a leading hold for DCC takes.
  // Keep source keys intact but play/seek only the authored range of each take.
  const byName = new Map(clips.map((clip) => [clip.name, clip]));
  for (const group of container.animationGroups) {
    const clip = byName.get(group.name);
    if (!clip) continue;
    if (clip.durationMs !== undefined) {
      group.from = ((clip.startTimeMs ?? 0) / 1000) * targetFps;
      group.to = group.from + (clip.durationMs / 1000) * targetFps;
    }
  }
  return container;
}
