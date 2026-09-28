import {
  ShadowGenerator,
  type Light,
  type PointLight,
  type SpotLight,
} from "@babylonjs/core";

export type LocalShadowLight = PointLight | SpotLight;

/**
 * A point/spot map that can move to another light of the same kind. Its RTT,
 * render-pass IDs, caster draw wrappers and scene UBO stay allocated, so a
 * camera-driven handoff needs no construction, disposal or shader loading.
 */
export class ReusableShadowGenerator extends ShadowGenerator {
  canMoveTo(light: LocalShadowLight): boolean {
    const current = this._light;
    return (
      light !== current &&
      light.getScene() === current.getScene() &&
      light.getTypeID() === current.getTypeID() &&
      light.needCube() === current.needCube() &&
      !light.getShadowGenerators()?.size
    );
  }

  /**
   * Babylon 9.20 reads the owning light live everywhere except its transform
   * cache. Receivers are not dirtied; the caller owns their transition.
   */
  moveTo(light: LocalShadowLight): void {
    if (!this.canMoveTo(light))
      throw new Error("A shadow map can only move to an unshadowed light of the same kind.");
    const previous: Light = this._light;
    const generators = previous._shadowGenerators;
    if (generators) {
      for (const [camera, generator] of generators)
        if (generator === this) generators.delete(camera);
      // Match ShadowGenerator.dispose: clustered admission rejects an empty map.
      if (!generators.size) previous._shadowGenerators = null;
    }
    (light._shadowGenerators ??= new Map()).set(this.camera, this);
    this._light = light;
    this.id = light.id;
    this._currentRenderId = -1;
    this._cachedPosition.setAll(Number.MAX_VALUE);
    this._cachedDirection.setAll(Number.MAX_VALUE);
  }
}
