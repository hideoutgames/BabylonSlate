import "./gltf-loader";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";
import { gltfAnimationClips, type GlbBrowseAnimation } from "@babylonslate/assets";
import { gltfLoaderExtension, packedGltfBytes } from "./model-mesh";

/** Load the authored model pose. Playback belongs to the caller, never the loader. */
export async function loadModelContainer(scene: Scene, bytes: Uint8Array, name: string) {
  let clips: GlbBrowseAnimation[] = [];
  const targetFps = 60;
  const container = await LoadAssetContainerAsync(packedGltfBytes(bytes), scene, {
    pluginExtension: gltfLoaderExtension(bytes),
    name,
    pluginOptions: {
      gltf: {
        animationStartMode: GLTFLoaderAnimationStartMode.NONE,
        targetFps,
        onParsed: (data) => {
          clips = gltfAnimationClips(data.json as Record<string, unknown>);
        },
      },
    },
  });
  // glTF normalizes groups to frame zero, inserting a leading hold for DCC takes.
  // Keep source keys intact but play/seek only the authored range of each take.
  for (const [index, group] of container.animationGroups.entries()) {
    const clip = clips[index];
    if (!clip) continue;
    group.name = clip.name;
    if (clip.durationMs !== undefined) {
      group.from = ((clip.startTimeMs ?? 0) / 1000) * targetFps;
      group.to = group.from + (clip.durationMs / 1000) * targetFps;
    }
  }
  return container;
}
