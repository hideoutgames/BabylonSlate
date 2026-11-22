import { VoronoiNoiseBlock } from "@babylonjs/core/Materials/Node/Blocks/voronoiNoiseBlock";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Babylon 9.29's Voronoi noise block under the class name Haptic's Materials build it by. */
export class HapticVoronoiNoiseBlock extends VoronoiNoiseBlock {
  override getClassName(): string {
    return "HapticVoronoiNoiseBlock";
  }
}

RegisterClass("BABYLON.HapticVoronoiNoiseBlock", HapticVoronoiNoiseBlock);
