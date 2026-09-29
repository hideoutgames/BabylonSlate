import type { CommandMessage } from "./channels";

/** Packets own their arrays; transfer only these copies, never simulation storage. */
export function dynamicMeshTransferables(command: CommandMessage): ArrayBuffer[] | undefined {
  const updates = command.type === "dynamicMeshUpdate" ? [command.update]
    : command.type === "assignMesh" ? command.parts?.flatMap((part) => part.dynamicMesh ? [part.dynamicMesh.update] : []) : undefined;
  if (!updates?.length) return undefined;
  const buffers: ArrayBuffer[] = [];
  for (const update of updates) {
    for (const array of [update.positions?.data, update.normals?.data, update.uvs?.data, update.indices]) {
      if (array) buffers.push(array.buffer as ArrayBuffer);
    }
  }
  return buffers;
}
