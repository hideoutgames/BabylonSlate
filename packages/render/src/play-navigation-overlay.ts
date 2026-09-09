import { Color3, Mesh, MeshBuilder, Vector3, type LinesMesh, type Scene } from "@babylonjs/core";
import type { CommandMessage, DebugNavAgent } from "@babylonslate/bridge";
import { createText3DMesh } from "./text3d-mesh";
import { RENDERING_GROUP } from "./sorting";

const PREFIX = "playConsoleViz:nav:";
const PATH_COLOR = new Color3(0.2, 0.85, 1);
const AGENT_COLOR = new Color3(0.4, 1, 0.45);
type Point = { x: number; y: number; z: number };
type Slot = { mesh: Mesh; key: string };

function markOverlay(mesh: Mesh): void {
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  mesh.metadata = { ...(mesh.metadata ?? {}), playDebugOverlay: true };
}

function vector(point: Point): Vector3 {
  return new Vector3(point.x, point.y, point.z);
}

/** Live crowd geometry stays separate from the authored navmesh overlay. */
export function createPlayNavigationOverlay(scene: Scene): {
  applyCommand(command: CommandMessage): boolean;
  dispose(): void;
} {
  let showPathfinding = false;
  let showAgents = false;
  let agents: readonly DebugNavAgent[] = [];
  let world: "2d" | "3d" = "3d";
  const slots = new Map<string, Slot>();

  const remove = (name: string, slot: Slot) => {
    slot.mesh.dispose(false, true);
    slots.delete(name);
  };

  const syncLines = (name: string, lines: Vector3[][], color: Color3, seen: Set<string>) => {
    if (lines.length === 0) return;
    seen.add(name);
    // Babylon updates a line system in place when its vertex layout is stable.
    const key = lines.map((line) => line.length).join(":");
    const prior = slots.get(name);
    if (prior && prior.key !== key) remove(name, prior);
    const instance = slots.get(name)?.mesh as LinesMesh | undefined;
    const mesh = MeshBuilder.CreateLineSystem(name, { lines, updatable: true, instance }, scene);
    mesh.color = color;
    markOverlay(mesh);
    slots.set(name, { mesh, key });
  };

  const sync = () => {
    const seen = new Set<string>();
    for (const agent of agents) {
      const name = `${PREFIX}${agent.actorGuid}:`;
      const position = vector(agent.position);
      if ((showPathfinding || showAgents) && agent.target) {
        const points = [agent.position, ...agent.path].map(vector);
        const lift = world === "3d" ? new Vector3(0, 0.05, 0) : new Vector3(0, 0, -0.05);
        syncLines(`${name}path`, points.length > 1 ? [points.map((point) => point.add(lift))] : [], PATH_COLOR, seen);
        const markers: Vector3[][] = [];
        for (const point of [...agent.path, agent.target]) {
          const center = vector(point).add(lift);
          const across = new Vector3(0.12, 0, 0);
          const along = world === "3d" ? new Vector3(0, 0, 0.12) : new Vector3(0, 0.12, 0);
          markers.push([center.subtract(across), center.add(across)], [center.subtract(along), center.add(along)]);
        }
        syncLines(`${name}markers`, markers, PATH_COLOR, seen);
      }
      if (!showAgents) continue;

      // Crowd radius is a footprint. In 3D the cylinder starts at the feet;
      // in XY worlds its planar footprint is the agent's navigation bound.
      const rings: Vector3[][] = [];
      const ringCount = world === "3d" ? 2 : 1;
      for (let ring = 0; ring < ringCount; ring++) {
        const points: Vector3[] = [];
        for (let index = 0; index <= 24; index++) {
          const angle = (index / 24) * Math.PI * 2;
          const x = Math.cos(angle) * agent.radius;
          const side = Math.sin(angle) * agent.radius;
          points.push(world === "3d"
            ? new Vector3(x, (ring - 0.5) * agent.height, side)
            : new Vector3(x, side, 0));
        }
        rings.push(points);
      }
      if (world === "3d") {
        for (let index = 0; index < 4; index++) {
          const angle = index * Math.PI / 2;
          const x = Math.cos(angle) * agent.radius;
          const z = Math.sin(angle) * agent.radius;
          rings.push([new Vector3(x, -agent.height / 2, z), new Vector3(x, agent.height / 2, z)]);
        }
      }
      syncLines(`${name}bounds`, rings, AGENT_COLOR, seen);
      slots.get(`${name}bounds`)!.mesh.position.copyFrom(position);
      if (world === "3d") slots.get(`${name}bounds`)!.mesh.position.y += agent.height / 2;
      const velocityOrigin = position.add(world === "3d" ? new Vector3(0, 0.1, 0) : new Vector3(0, 0, -0.1));
      syncLines(`${name}velocity`, [[velocityOrigin, velocityOrigin.add(vector(agent.velocity))]], AGENT_COLOR, seen);

      const speed = Math.hypot(agent.velocity.x, agent.velocity.y, agent.velocity.z);
      const text = `${agent.actorName.slice(0, 48)} (${agent.actorGuid.slice(0, 8)})\n${agent.state} - ${speed.toFixed(1)} u/s`;
      const labelName = `${name}label`;
      seen.add(labelName);
      let label = slots.get(labelName);
      if (label && label.key !== text) {
        remove(labelName, label);
        label = undefined;
      }
      if (!label) {
        const mesh = createText3DMesh(scene, labelName, {
          text, size: 0.22, alignment: "center", color: [0.75, 1, 0.8],
        });
        mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
        markOverlay(mesh);
        mesh.metadata = { ...mesh.metadata, label: text };
        label = { mesh, key: text };
        slots.set(labelName, label);
      }
      label.mesh.position.copyFrom(position);
      label.mesh.position.y += (world === "3d" ? agent.height : agent.radius) + 0.3;
    }
    for (const [name, slot] of slots) {
      if (!seen.has(name)) remove(name, slot);
    }
  };

  return {
    applyCommand(command) {
      if (command.type === "setShowPathfinding") {
        showPathfinding = command.enabled;
      } else if (command.type === "setShowNavAgent") {
        showAgents = command.enabled;
      } else if (command.type === "debugNavigation") {
        agents = command.agents;
        world = command.world;
      } else {
        return false;
      }
      sync();
      return true;
    },
    dispose() {
      agents = [];
      for (const [name, slot] of slots) remove(name, slot);
    },
  };
}
