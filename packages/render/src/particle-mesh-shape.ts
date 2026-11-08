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
    const vertex = [new Vector3(), new Vector3(), new Vector3()] as const;
    const point = new Vector3();
    const normal = new Vector3();
    let hasNormal = false;
    const corner = (values: ArrayLike<number>, index: number, width: number, out: Vector3, w?: { value: number }) => {
      out.set(values[index * width]!, values[index * width + 1]!, values[index * width + 2]!);
      if (w) w.value = values[index * width + 3] ?? 1;
    };
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
        const face = 3 * Math.floor(Math.random() * Math.floor(geometry.indices.length / 3));
        const corners = [geometry.indices[face]!, geometry.indices[face + 1]!, geometry.indices[face + 2]!] as const;
        const bu = Math.random();
        const bv = Math.random() * (1 - bu);
        const bw = 1 - bu - bv;
        const blend = (values: ArrayLike<number>, width: number, out: Vector3) => {
          corner(values, corners[0], width, vertex[0]);
          corner(values, corners[1], width, vertex[1]);
          corner(values, corners[2], width, vertex[2]);
          out.set(
            bu * vertex[0].x + bv * vertex[1].x + bw * vertex[2].x,
            bu * vertex[0].y + bv * vertex[1].y + bw * vertex[2].y,
            bu * vertex[0].z + bv * vertex[1].z + bw * vertex[2].z,
          );
        };
        blend(geometry.positions, 3, point);
        if (this.useMeshNormals) {
          if (geometry.normals?.length) blend(geometry.normals, 3, normal);
          else {
            // No normals: the triangle's own face normal.
            corner(geometry.positions, corners[0], 3, vertex[0]);
            corner(geometry.positions, corners[1], 3, vertex[1]);
            corner(geometry.positions, corners[2], 3, vertex[2]);
            Vector3.CrossToRef(vertex[1].subtract(vertex[0]), vertex[2].subtract(vertex[0]), normal);
          }
          hasNormal = normal.lengthSquared() > 0;
          if (hasNormal) normal.normalize();
        }
        if (this.useMeshColor && geometry.colors?.length) {
          const alpha = [{ value: 1 }, { value: 1 }, { value: 1 }] as const;
          corner(geometry.colors, corners[0], 4, vertex[0], alpha[0]);
          corner(geometry.colors, corners[1], 4, vertex[1], alpha[1]);
          corner(geometry.colors, corners[2], 4, vertex[2], alpha[2]);
          particle.color.set(
            bu * vertex[0].x + bv * vertex[1].x + bw * vertex[2].x,
            bu * vertex[0].y + bv * vertex[1].y + bw * vertex[2].y,
            bu * vertex[0].z + bv * vertex[1].z + bw * vertex[2].z,
            bu * alpha[0].value + bv * alpha[1].value + bw * alpha[2].value,
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
      (particle as ShapeParticle)._properties.initialDirection = particle.direction.clone();
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
