import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import {
  NodeParticleBlockConnectionPointTypes,
} from "@babylonjs/core/Particles/Node/Enums/nodeParticleBlockConnectionPointTypes";
import { NodeParticleBlock } from "@babylonjs/core/Particles/Node/nodeParticleBlock";
import type { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import type { NodeParticleBuildState } from "@babylonjs/core/Particles/Node/nodeParticleBuildState";
import type { Particle } from "@babylonjs/core/Particles/particle";
import type { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";

/**
 * Mesh Shape geometry in the emitter's space: positions and indices, with normals and RGBA
 * colours when the mesh has them. Babylon-shaped arrays (3 floats per position or normal,
 * 4 per colour, 3 indices per triangle).
 */
export interface ParticleMeshGeometry {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  colors?: ArrayLike<number> | null;
}

/** A Mesh Shape's geometry; null until it is known (particles spawn at the emitter meanwhile). */
export interface ParticleMeshShapeSource {
  geometry(): ParticleMeshGeometry | null;
}

const NO_GEOMETRY: ParticleMeshShapeSource = { geometry: () => null };

let previewSphere: ParticleMeshGeometry | null = null;

/** Previews have no owning actor: Owner Mesh shows on a unit sphere there. */
export const PREVIEW_OWNER_MESH: ParticleMeshShapeSource = {
  geometry: () => {
    if (!previewSphere) {
      const data = CreateSphereVertexData({ diameter: 1, segments: 12 });
      previewSphere = { positions: data.positions ?? [], indices: data.indices ?? [], normals: data.normals ?? null };
    }
    return previewSphere;
  },
};

/**
 * A mesh's geometry (bind pose) in `emitter`'s space, or null when it has none. An instance (a pooled primitive or
 * model leaf) gives its source's geometry where the instance is placed.
 */
export function meshGeometryRelativeTo(mesh: Mesh | InstancedMesh, emitter: AbstractMesh): ParticleMeshGeometry | null {
  const data = VertexData.ExtractFromMesh(mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh, false, true);
  if (!data.positions?.length || !data.indices?.length) return null;
  const relative = mesh.computeWorldMatrix(true).multiply(Matrix.Invert(emitter.computeWorldMatrix(true)));
  const positions = Float32Array.from(data.positions);
  const point = new Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(positions[index]!, positions[index + 1]!, positions[index + 2]!, relative, point);
    positions[index] = point.x;
    positions[index + 1] = point.y;
    positions[index + 2] = point.z;
  }
  let normals: Float32Array | null = null;
  if (data.normals?.length) {
    normals = Float32Array.from(data.normals);
    for (let index = 0; index < normals.length; index += 3) {
      Vector3.TransformNormalFromFloatsToRef(normals[index]!, normals[index + 1]!, normals[index + 2]!, relative, point);
      point.normalize();
      normals[index] = point.x;
      normals[index + 1] = point.y;
      normals[index + 2] = point.z;
    }
  }
  return { positions, indices: Uint32Array.from(data.indices), normals, colors: data.colors ? Float32Array.from(data.colors) : null };
}

type CreationItem = { process: (particle: Particle, system: ParticleSystem) => void };
type CreationSystem = ParticleSystem & { _positionCreation: CreationItem; _directionCreation: CreationItem; _colorCreation: CreationItem };
type ShapeParticle = Particle & { _properties: Record<string, unknown> };

const randomRange = (min: number, max: number) => (min === max ? min : min + Math.random() * (max - min));

/**
 * Mesh Shape: particles spawn on a random point of a random triangle and move along the
 * surface normal there (Use Mesh Normals) or between Direction 1 and Direction 2, optionally
 * taking the vertex colour (Use Mesh Color), as Babylon's `MeshShapeBlock`. Babylon's block
 * copies a mesh's vertices when the system is built; this one reads them from a source each
 * time a particle is born, so an owner mesh or Model that finishes loading later is picked
 * up, and spawns at the emitter until then. Geometry is in the emitter's space, so it follows
 * the actor in World and Local Space alike.
 */
export class SlateMeshShapeBlock extends NodeParticleBlock {
  source: ParticleMeshShapeSource = NO_GEOMETRY;
  useMeshNormals = true;
  useMeshColor = false;

  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerInput("direction1", NodeParticleBlockConnectionPointTypes.Vector3, true, new Vector3(0, 1, 0));
    this.registerInput("direction2", NodeParticleBlockConnectionPointTypes.Vector3, true, new Vector3(0, 1, 0));
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateMeshShapeBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get direction1(): NodeParticleConnectionPoint {
    return this._inputs[1]!;
  }

  get direction2(): NodeParticleConnectionPoint {
    return this._inputs[2]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const system = this.particle.getConnectedValue(state) as CreationSystem;
    const point = new Vector3();
    const normal = new Vector3();
    let hasNormal = false;
    // Per particle, nothing is allocated: corners are read as scalars, in the order and with the arithmetic of
    // `bu * a + bv * b + bw * c`, so a spawn lands where it did for the same random draws.
    system._positionCreation.process = (particle) => {
      state.particleContext = particle;
      state.systemContext = system;
      const properties = (particle as ShapeParticle)._properties;
      properties.slateMeshColor = false;
      hasNormal = false;
      const geometry = this.source.geometry();
      if (!geometry || geometry.indices.length < 3) {
        point.set(0, 0, 0);
      } else {
        const indices = geometry.indices;
        const face = 3 * Math.floor(Math.random() * Math.floor(indices.length / 3));
        const c0 = indices[face]!, c1 = indices[face + 1]!, c2 = indices[face + 2]!;
        const bu = Math.random();
        const bv = Math.random() * (1 - bu);
        const bw = 1 - bu - bv;
        const positions = geometry.positions;
        const p0 = c0 * 3, p1 = c1 * 3, p2 = c2 * 3;
        point.set(
          bu * positions[p0]! + bv * positions[p1]! + bw * positions[p2]!,
          bu * positions[p0 + 1]! + bv * positions[p1 + 1]! + bw * positions[p2 + 1]!,
          bu * positions[p0 + 2]! + bv * positions[p1 + 2]! + bw * positions[p2 + 2]!,
        );
        if (this.useMeshNormals) {
          const normals = geometry.normals;
          if (normals?.length) {
            normal.set(
              bu * normals[p0]! + bv * normals[p1]! + bw * normals[p2]!,
              bu * normals[p0 + 1]! + bv * normals[p1 + 1]! + bw * normals[p2 + 1]!,
              bu * normals[p0 + 2]! + bv * normals[p1 + 2]! + bw * normals[p2 + 2]!,
            );
          } else {
            // No normals: the triangle's own face normal, (v1 - v0) x (v2 - v0).
            const x0 = positions[p0]!, y0 = positions[p0 + 1]!, z0 = positions[p0 + 2]!;
            const ex = positions[p1]! - x0, ey = positions[p1 + 1]! - y0, ez = positions[p1 + 2]! - z0;
            const fx = positions[p2]! - x0, fy = positions[p2 + 1]! - y0, fz = positions[p2 + 2]! - z0;
            normal.set(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
          }
          hasNormal = normal.lengthSquared() > 0;
          if (hasNormal) normal.normalize();
        }
        const colors = geometry.colors;
        if (this.useMeshColor && colors?.length) {
          const q0 = c0 * 4, q1 = c1 * 4, q2 = c2 * 4;
          particle.color.set(
            bu * colors[q0]! + bv * colors[q1]! + bw * colors[q2]!,
            bu * colors[q0 + 1]! + bv * colors[q1 + 1]! + bw * colors[q2 + 1]!,
            bu * colors[q0 + 2]! + bv * colors[q1 + 2]! + bw * colors[q2 + 2]!,
            bu * (colors[q0 + 3] ?? 1) + bv * (colors[q1 + 3] ?? 1) + bw * (colors[q2 + 3] ?? 1),
          );
          properties.slateMeshColor = true;
        }
      }
      if (system.isLocal) particle.position.copyFrom(point);
      else Vector3.TransformCoordinatesToRef(point, state.emitterWorldMatrix!, particle.position);
      const local = properties.localPosition as Vector3 | undefined;
      if (local) local.copyFrom(particle.position);
      else properties.localPosition = particle.position.clone();
    };
    system._directionCreation.process = (particle) => {
      state.particleContext = particle;
      state.systemContext = system;
      if (hasNormal) {
        if (system.isLocal) particle.direction.copyFrom(normal);
        else Vector3.TransformNormalToRef(normal, state.emitterWorldMatrix!, particle.direction);
      } else {
        const first = this.direction1.getConnectedValue(state) as Vector3;
        const second = this.direction2.getConnectedValue(state) as Vector3;
        const x = randomRange(first.x, second.x);
        const y = randomRange(first.y, second.y);
        const z = randomRange(first.z, second.z);
        if (system.isLocal) particle.direction.set(x, y, z);
        else Vector3.TransformNormalFromFloatsToRef(x, y, z, state.emitterWorldMatrix!, particle.direction);
      }
      // A recycled particle keeps its vector, as Babylon's own direction creation does.
      const properties = (particle as ShapeParticle)._properties;
      const initial = properties.initialDirection as Vector3 | null | undefined;
      if (initial) initial.copyFrom(particle.direction);
      else properties.initialDirection = particle.direction.clone();
    };
    if (this.useMeshColor) {
      // A particle that took the mesh's colour keeps it; others get their authored colour.
      const color = system._colorCreation.process;
      system._colorCreation.process = (particle, owner) => {
        if ((particle as ShapeParticle)._properties.slateMeshColor) return;
        color(particle, owner);
      };
    }
    this.output._storedValue = system;
  }
}
