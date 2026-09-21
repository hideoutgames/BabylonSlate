import { Matrix, Quaternion, Scene, Vector3 } from "@babylonjs/core";
import { areaRectLightBindings, identitySerializedTransform } from "@babylonslate/core";
import { describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { AreaRectLightOwner } from "./area-rect-light";
import { managedRenderReservations, limitManagedRenderBytes } from "./managed-render-resources";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "@babylonslate/assets";
import { AREA_EMISSION_TEXTURE_BYTES } from "./area-emission-resource";

function binding() {
  return areaRectLightBindings([{ id: "emitter", classId: "AreaRectLightComponent", properties: { width: 2, height: 3 }, transform: identitySerializedTransform() }])[0]!;
}

describe("native rectangular area light ownership", () => {
  it("shares prepared emission, replaces it before retiring old data, and recovers from a missing asset", async () => {
    const { engine, scene } = createTestEngine();
    const data = await decodeAreaEmission(await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(170), "a".repeat(64)));
    const emissions = new Map([["texture", data]]);
    const authored = binding(); authored.properties.textureGuid = "texture";
    const first = new AreaRectLightOwner(scene, "first", authored, undefined, emissions);
    const second = new AreaRectLightOwner(scene, "second", authored, undefined, emissions);
    const texture = first.light.emissionTexture!;
    const dispose = vi.spyOn(texture, "dispose");
    expect(second.light.emissionTexture).toBe(texture);
    expect(managedRenderReservations(engine).categoryBytes.areaLight).toBe(65536 + AREA_EMISSION_TEXTURE_BYTES);
    first.update(authored, new Map());
    expect(first.light.isEnabled()).toBe(false);
    expect(first.error).toContain("Prepare Emission");
    expect(dispose).not.toHaveBeenCalled();
    first.update(authored, emissions);
    expect(first.light.isEnabled()).toBe(true);
    first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    second.update(binding());
    expect(second.light.emissionTexture).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(managedRenderReservations(engine).categoryBytes.areaLight).toBe(0);
    scene.dispose(); engine.dispose();
  });
  it("shares offline lookup textures across views until the last emitter releases them", () => {
    const { engine, scene } = createTestEngine();
    const other = new Scene(engine);
    const first = new AreaRectLightOwner(scene, "first", binding());
    const second = new AreaRectLightOwner(scene, "second", binding());
    const third = new AreaRectLightOwner(other, "third", binding());
    const lookup = scene._ltcTextures!;
    const dispose = vi.spyOn(lookup.LTC1, "dispose");
    expect(other._ltcTextures?.LTC1).toBe(lookup.LTC1);
    expect(managedRenderReservations(engine).categoryBytes.areaLight).toBe(65536);
    first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(scene._ltcTextures).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
    other.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(managedRenderReservations(engine).categoryBytes.areaLight).toBe(0);
    third.dispose();
    expect(scene.transformNodes).toHaveLength(0);
    scene.dispose(); engine.dispose();
  });

  it("rejects allocation over the shared budget without leaving partial lights or reservations", () => {
    const { engine, scene } = createTestEngine();
    limitManagedRenderBytes(engine, 32768);
    expect(() => new AreaRectLightOwner(scene, "limited", binding())).toThrow("memory budget");
    expect(scene.lights).toHaveLength(0);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
    expect(scene._ltcTextures).toBeUndefined();
    scene.dispose(); engine.dispose();
  });

  it.each([1, -1])("preserves the authored +Z emission side under scale sign %s and rotated parents", (mirror) => {
    const { engine, scene } = createTestEngine();
    const owner = new AreaRectLightOwner(scene, "light", binding());
    const rotation = Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0);
    const world = Matrix.Compose(new Vector3(2 * mirror, 3, 4), rotation, new Vector3(5, 6, 7));
    owner.setWorld(world);
    const native = owner.light.parent!.getWorldMatrix();
    const x = Vector3.TransformNormal(Vector3.Right(), native);
    const y = Vector3.TransformNormal(Vector3.Up(), native);
    const direction = Vector3.Cross(x, y).normalize().negate();
    expect(direction.equalsWithEpsilon(Vector3.Forward().applyRotationQuaternion(rotation))).toBe(true);
    expect(x.length() * owner.light.width).toBeCloseTo(4);
    expect(y.length() * owner.light.height).toBeCloseTo(9);
    expect(native.getTranslation().asArray()).toEqual([5, 6, 7]);
    const revised = binding(); revised.properties.width = 4;
    owner.update(revised);
    expect(owner.light.parent!.getWorldMatrix().getTranslation().asArray()).toEqual([5, 6, 7]);
    expect(owner.light.getShadowGenerator()).toBeNull();
    scene.dispose(); engine.dispose();
  });

  it("reports shear once, disables the invalid emitter and recovers without replacing its resources", () => {
    const { engine, scene } = createTestEngine();
    const diagnostic = vi.fn();
    const owner = new AreaRectLightOwner(scene, "light", binding(), diagnostic);
    const shear = Matrix.Identity(); shear.setRowFromFloats(0, 1, 0.5, 0, 0);
    owner.setWorld(shear); owner.setWorld(shear);
    expect(owner.light.isEnabled()).toBe(false);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(owner.error).toContain("sheared");
    owner.setWorld(Matrix.Identity());
    expect(owner.light.isEnabled()).toBe(true);
    expect(owner.error).toBeUndefined();
    expect(scene.lights).toHaveLength(1);
    scene.dispose(); engine.dispose();
  });
});
