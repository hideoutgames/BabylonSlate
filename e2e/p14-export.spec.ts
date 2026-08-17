import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "../packages/core/src/index.ts";
import {
  BOOT_PACK_FILE,
  exportGame,
  GAME_MANIFEST_FILE,
  parseGameManifest,
  unzipExport,
  zipExport,
} from "../packages/exporter/src/index.ts";
import { collectDirFiles, serveExportFiles } from "./export-static-server";
import {
  EXPECTED_PREVIEW_ACTOR_POSITIONS,
  previewPlacementScene,
} from "./preview-scene-fixture";

function playerDist(): string {
  return join(process.cwd(), "apps/player/dist");
}

async function packTinyGame() {
  const scene = {
    ...previewPlacementScene(),
    name: "ExportBoot",
  };
  const playerFiles = collectDirFiles(playerDist());
  expect(playerFiles.has("index.html")).toBe(true);
  expect(playerFiles.has("player.js")).toBe(true);
  const packed = await exportGame({
    bundleDebugger: false,
    startupSceneGuid: "scene-guid-export",
    customResolution: {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      customResolution: true,
      width: 640,
      height: 360,
      blackBars: true,
    },
    scripts: [],
    assets: [
      {
        guid: "scene-guid-export",
        type: "Scene",
        sceneGuid: "scene-guid-export",
        bytes: new TextEncoder().encode(JSON.stringify(scene)),
      },
    ],
    playerFiles,
  });
  expect(packed.ok).toBe(true);
  if (!packed.ok) throw new Error(packed.error);
  expect(packed.value.files.has("index.html")).toBe(true);
  expect(packed.value.files.has(BOOT_PACK_FILE)).toBe(true);
  expect(packed.value.manifest.startupSceneGuid).toBe("scene-guid-export");
  expect(packed.value.fileCount).toBeLessThan(800);
  expect([...packed.value.files.keys()].some((path) => path.includes("main.scene.babasset"))).toBe(
    false,
  );
  return packed.value;
}

test.describe("P14 export smoke", () => {
  test("unzip-serve-boot-tick on range and range-blind servers", async ({
    page,
  }) => {
    const artifact = await packTinyGame();
    const zip = zipExport(artifact);
    const unzipped = unzipExport(zip);
    expect(Object.keys(unzipped)).toContain("index.html");
    const manifest = parseGameManifest(
      new TextDecoder().decode(unzipped[GAME_MANIFEST_FILE]),
    );
    expect(manifest.startupSceneGuid).toBe("scene-guid-export");
    expect(manifest.mode).toBe("packed");

    const files = new Map<string, Uint8Array>();
    for (const [path, bytes] of Object.entries(unzipped)) {
      files.set(path, bytes);
    }
    expect(files.size).toBe(artifact.fileCount);

    const dir = join(tmpdir(), `p14-export-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "game.zip"), zip);

    for (const honorRange of [true, false]) {
      const server = await serveExportFiles(files, { honorRange });
      try {
        await page.goto(server.url);
        await expect(page.getByTestId("player-root")).toBeVisible();
        await expect(page.getByTestId("player-root")).toHaveAttribute(
          "data-startup-scene",
          "scene-guid-export",
        );
        await expect
          .poll(async () => page.getByTestId("player-root").getAttribute("data-ticks"), {
            timeout: 20_000,
          })
          .not.toBe("0");
        await expect(page.getByTestId("player-root")).toHaveAttribute(
          "data-booted",
          "true",
        );
        await expect
          .poll(
            () =>
              page.getByTestId("player-root").evaluate(() => {
                const host = globalThis as unknown as {
                  __babylonslatePlayerTest?: {
                    visuals: () => Array<{
                      visible: boolean;
                      position: [number, number, number];
                    }>;
                  };
                };
                return (host.__babylonslatePlayerTest?.visuals() ?? [])
                  .filter((visual) => visual.visible)
                  .map((visual) => visual.position)
                  .sort((a, b) => a[0] - b[0]);
              }),
            { timeout: 20_000 },
          )
          .toEqual(EXPECTED_PREVIEW_ACTOR_POSITIONS);
      } finally {
        await server.close();
      }
    }
  });
});
