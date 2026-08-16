import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playerHostVitePlugin } from "./vite-player-host";

type Middleware = (
  req: { url?: string },
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
) => void;

/** Drive the plugin's dev middleware with a resolved Vite base. */
function serveWith(base: string, url: string): { served: boolean } {
  const playerDist = mkdtempSync(join(tmpdir(), "player-host-"));
  writeFileSync(join(playerDist, "index.html"), "<!doctype html>");

  const plugin = playerHostVitePlugin(playerDist, join(playerDist, "editor"));
  (plugin.configResolved as (config: { base: string }) => void)({ base });

  let middleware: Middleware | null = null;
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: {
      use: (handler: Middleware) => {
        middleware = handler;
      },
    },
  });

  let nexted = false;
  const chunks: string[] = [];
  middleware!(
    { url },
    {
      setHeader: () => {},
      // The handler pipes a read stream into the response; collect enough to
      // know it answered rather than deferring to the next middleware.
      on: () => {},
      once: () => {},
      emit: () => {},
      write: (chunk: string) => chunks.push(chunk),
      end: () => {},
    } as never,
    () => {
      nexted = true;
    },
  );
  return { served: !nexted };
}

describe("playerHostVitePlugin", () => {
  it("serves the player at the site root by default", () => {
    expect(serveWith("/", "/player/index.html").served).toBe(true);
  });

  it("serves the player under a deployed sub-path base", () => {
    expect(
      serveWith("/BabylonSlate/", "/BabylonSlate/player/index.html").served,
    ).toBe(true);
  });

  it("ignores the origin-root path when the editor is under a sub-path", () => {
    expect(serveWith("/BabylonSlate/", "/player/index.html").served).toBe(false);
  });

  it("passes unrelated editor routes through", () => {
    expect(serveWith("/", "/index.html").served).toBe(false);
  });
});
