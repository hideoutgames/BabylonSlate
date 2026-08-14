import { generateNavMesh } from "./recast-backend";
import type { NavMeshGenerateInput } from "./types";

export async function runNavBakeJob(
  input: NavMeshGenerateInput,
  generate: (
    input: NavMeshGenerateInput,
  ) => Promise<Uint8Array> = generateNavMesh,
): Promise<Uint8Array> {
  return generate(input);
}
