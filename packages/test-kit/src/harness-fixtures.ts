import type { ProjectStorage } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";

export interface HarnessProjectFixtures {
  storage: MemoryStorageAdapter;
  projectName: string;
  /** Relative paths written into the memory VFS. */
  paths: string[];
}

/**
 * Install a minimal project tree into a MemoryStorageAdapter for harness tests.
 * Uses plain JSON stubs (not the full babasset codec) so test-kit does not
 * depend on assets and avoid a workspace cycle.
 */
export async function installHarnessProjectFixtures(options?: {
  projectName?: string;
  projectGuid?: string;
}): Promise<HarnessProjectFixtures> {
  const projectName = options?.projectName ?? "Harness.babproject";
  const projectGuid = options?.projectGuid ?? "harness-project-guid";
  const storage = new MemoryStorageAdapter("opfs");
  await storage.pickProjectFolder(projectName);

  const encoder = new TextEncoder();
  const files: Array<{ path: string; data: Uint8Array }> = [
    {
      path: "project.json",
      data: encoder.encode(
        JSON.stringify({
          kind: "project",
          guid: projectGuid,
          name: "Harness",
          engineVersion: "0.0.0",
          version: 1,
          startupScene: "assets/main.scene.babasset",
        }),
      ),
    },
    {
      path: "layout.json",
      data: encoder.encode(JSON.stringify({ documents: {}, tabOrder: [] })),
    },
    {
      path: "assets/Enemy.class.json",
      data: encoder.encode(
        JSON.stringify({
          guid: "harness-enemy-class",
          type: "Class",
          name: "Enemy",
          parentClass: "Actor",
          variables: [{ name: "speed", type: "float", defaultValue: 1 }],
        }),
      ),
    },
  ];

  const paths: string[] = [];
  for (const file of files) {
    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    if (dir) {
      await storage.mkdir(dir, true);
    }
    await storage.writeBinary(file.path, file.data);
    paths.push(file.path);
  }

  paths.sort();
  return { storage, projectName, paths };
}

export async function assertHarnessFixtureReadable(
  storage: ProjectStorage,
  path: string,
): Promise<Uint8Array> {
  return storage.readBinary(path);
}
