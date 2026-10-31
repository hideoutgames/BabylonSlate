import { createDefaultScene, lookAtRotation, type SerializedActor, type SerializedScene } from "@haptic/core";
import { actor, meshComp, requireRef, SCENE_SAVE_ORDER, tf, type FeatureTestContext, type Vec3 } from "./context";

/**
 * `FT_Occlusion`: the occlusion culling yardstick, a dense scene to measure it against, not an optimisation of other
 * content. A street-level city block (two rows of buildings along a street, each hiding a yard of crates and posts) and,
 * behind the block, an indoor building of rooms with doorways, each room holding crates and a present Model (whose
 * baked box occludes). The main camera stands in the street; `Rooms Camera` stands in a doorway (`possess "Rooms
 * Camera"`). The check runs `ft_occlusion`, since Occlusion Culling is off on every quality tier.
 */
export const OCCLUSION_SCENE = "FT_Occlusion";
const SCENES_FOLDER = "Scenes";
/** Buildings per side of the street, and the yard props behind each. */
export const OCCLUSION_BLOCKS = 6;
const YARD_ROWS = 3, YARD_COLUMNS = 4;
/** Rooms per side of the indoor building, each with its props. */
export const OCCLUSION_ROOMS = 3;
const STREET_CAMERA = { position: [0, 1.7, -6] as Vec3, target: [0, 1.5, 40] as Vec3 };
const ROOMS_CAMERA = { position: [64, 1.6, 2] as Vec3, target: [64, 1.4, 20] as Vec3 };
/** Box primitives are 1.5 m; scales are in that unit. */
const UNIT = 1.5;

function block(id: string, name: string, centre: Vec3, size: Vec3, occluder?: "always" | "never"): SerializedActor {
  const mesh = meshComp(`${id}-mesh`, "box", { collision: "simple" });
  if (occluder) mesh.properties.occluder = occluder;
  return actor(id, name, tf(centre, { scale: [size[0] / UNIT, size[1] / UNIT, size[2] / UNIT] }), [mesh]);
}

export async function buildFeatureTestOcclusion(ctx: FeatureTestContext): Promise<void> {
  const present = requireRef(ctx.assets.models["present-a-cube"], "the present-a-cube Model");
  const scene: SerializedScene = createDefaultScene("3d");
  scene.name = OCCLUSION_SCENE;
  scene.actors = scene.actors.filter((entry) => entry.components.length > 0);
  const camera = scene.actors.find((entry) => entry.id === scene.settings.mainCameraActorId);
  if (camera) camera.transform = tf(STREET_CAMERA.position, { rotation: lookAtRotation(STREET_CAMERA.position, STREET_CAMERA.target) });
  const add = (entry: SerializedActor) => ctx.addActor(entry, { scene });

  // The street and the ground under the block.
  add(block("ft-occ-ground", "Ground", [30, -0.1, 50], [140, 0.2, 140]));
  for (const [side, x] of [["West", -11], ["East", 11]] as const) {
    for (let index = 0; index < OCCLUSION_BLOCKS; index++) {
      const z = 6 + index * 16;
      const number = `${side} ${index + 1}`;
      // Heights vary by a fixed pattern: the skyline is deterministic.
      const height = 8 + ((index * 5 + (side === "East" ? 3 : 0)) % 4) * 3;
      add(block(`ft-occ-building-${side.toLowerCase()}-${index + 1}`, `Building ${number}`, [x, height / 2, z], [10, height, 14]));
      // The yard behind the building: crates and posts the street never sees.
      const yardX = x + Math.sign(x) * 11;
      for (let row = 0; row < YARD_ROWS; row++) {
        for (let column = 0; column < YARD_COLUMNS; column++) {
          const id = `ft-occ-yard-${side.toLowerCase()}-${index + 1}-${row + 1}-${column + 1}`;
          const position: Vec3 = [yardX + (column - 1.5) * 2.2, 0.75, z - 4 + row * 4];
          const kind = (row + column) % 3 === 0 ? "cylinder" : "box";
          add(actor(id, `Yard ${number} ${row + 1}-${column + 1}`, tf(position), [meshComp(`${id}-mesh`, kind)]));
        }
      }
    }
  }
  // Street lamps in view, drawn whatever occludes: thin posts the culling must keep.
  for (let index = 0; index < OCCLUSION_BLOCKS; index++) {
    const id = `ft-occ-lamp-${index + 1}`;
    add(actor(id, `Lamp Post ${index + 1}`, tf([index % 2 ? 4.5 : -4.5, 2, 4 + index * 16], { scale: [0.15 / 1, 4 / UNIT, 0.15 / 1] }),
      [meshComp(`${id}-mesh`, "cylinder")]));
  }

  // The indoor building behind the East row: rooms of 8 m with 2 m doorways, a crate stack and a present in each.
  const origin: Vec3 = [56, 0, 8];
  const room = 8, wall = 0.3, height = 3.5, door = 2;
  for (let row = 0; row <= OCCLUSION_ROOMS; row++) {
    for (let column = 0; column < OCCLUSION_ROOMS; column++) {
      // Walls along x at each row line, each with a doorway in the middle (the outer front wall too, for the camera).
      const z = origin[2] + row * room;
      const x = origin[0] + column * room + room / 2;
      const side = (room - door) / 2;
      add(block(`ft-occ-wall-x-${row}-${column}-a`, `Room Wall ${row}-${column} A`, [x - door / 2 - side / 2, height / 2, z], [side, height, wall]));
      add(block(`ft-occ-wall-x-${row}-${column}-b`, `Room Wall ${row}-${column} B`, [x + door / 2 + side / 2, height / 2, z], [side, height, wall]));
    }
  }
  for (let column = 0; column <= OCCLUSION_ROOMS; column++) {
    for (let row = 0; row < OCCLUSION_ROOMS; row++) {
      const x = origin[0] + column * room;
      const z = origin[2] + row * room + room / 2;
      // Outer side walls are solid; inner ones have doorways.
      if (column === 0 || column === OCCLUSION_ROOMS) {
        add(block(`ft-occ-wall-z-${column}-${row}`, `Room Wall Side ${column}-${row}`, [x, height / 2, z], [wall, height, room]));
        continue;
      }
      const side = (room - door) / 2;
      add(block(`ft-occ-wall-z-${column}-${row}-a`, `Room Wall ${column}-${row} C`, [x, height / 2, z - door / 2 - side / 2], [wall, height, side]));
      add(block(`ft-occ-wall-z-${column}-${row}-b`, `Room Wall ${column}-${row} D`, [x, height / 2, z + door / 2 + side / 2], [wall, height, side]));
    }
  }
  add(block("ft-occ-roof", "Rooms Roof", [origin[0] + (OCCLUSION_ROOMS * room) / 2, height + 0.15, origin[2] + (OCCLUSION_ROOMS * room) / 2],
    [OCCLUSION_ROOMS * room, 0.3, OCCLUSION_ROOMS * room], "never"));
  for (let row = 0; row < OCCLUSION_ROOMS; row++) {
    for (let column = 0; column < OCCLUSION_ROOMS; column++) {
      const centre: Vec3 = [origin[0] + column * room + room / 2, 0, origin[2] + row * room + room / 2];
      const name = `${row + 1}-${column + 1}`;
      for (let crate = 0; crate < 4; crate++) {
        const id = `ft-occ-crate-${name}-${crate + 1}`;
        add(actor(id, `Room Crate ${name} ${crate + 1}`, tf([centre[0] - 2.5 + (crate % 2) * 0.8, 0.375 + Math.floor(crate / 2) * 0.75, centre[2] + 2.5], {
          scale: [0.5, 0.5, 0.5],
        }), [meshComp(`${id}-mesh`, "box")]));
      }
      const id = `ft-occ-present-${name}`;
      add(actor(id, `Room Present ${name}`, tf([centre[0] + 1.5, 0, centre[2] - 1], { scale: [2, 2, 2] }), [meshComp(`${id}-mesh`, "box", { assetGuid: present })]));
    }
  }
  const rooms = actor("ft-occ-rooms-camera", "Rooms Camera", tf(ROOMS_CAMERA.position, { rotation: lookAtRotation(ROOMS_CAMERA.position, ROOMS_CAMERA.target) }), []);
  const cameraComponent = camera?.components.find((entry) => entry.classId === "CameraComponent");
  if (cameraComponent) rooms.components.push({ ...cameraComponent, id: "ft-occ-rooms-camera-lens", properties: { ...cameraComponent.properties } });
  add(rooms);

  await ctx.addSceneDocument({ kind: "scene", folder: SCENES_FOLDER, name: OCCLUSION_SCENE, content: scene, order: SCENE_SAVE_ORDER.scene });
}
