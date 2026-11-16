import { VoronoiNoiseBlock } from "@babylonjs/core/Materials/Node/Blocks/voronoiNoiseBlock";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Babylon 9.29's Voronoi noise block under the class name Haptic's Materials build it by. */
export class SlateVoronoiNoiseBlock extends VoronoiNoiseBlock {
  override getClassName(): string {
    return "SlateVoronoiNoiseBlock";
  }
}

RegisterClass("BABYLON.SlateVoronoiNoiseBlock", SlateVoronoiNoiseBlock);
