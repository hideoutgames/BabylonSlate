import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
export function toolCli(name) {
  const entry =
    name === "vitest"
      ? "vitest.mjs"
      : name === "@playwright/test"
        ? "cli.js"
        : "bin/eslint.js";
  return join(dirname(require.resolve(`${name}/package.json`)), entry);
}
export function pnpmCommand(args) {
  const entry = process.env.npm_execpath;
  if (!entry || /\.(cmd|bat|ps1)$/i.test(entry))
    throw new Error(
      "Launch this command through pnpm run so npm_execpath identifies the package manager.",
    );
  return /\.[cm]?js$/i.test(entry)
    ? [process.execPath, [entry, ...args]]
    : [entry, args];
}

/** No shell interpolation. Cancellation targets only this command's descendants. */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: 130, output: "" });
      return;
    }
    const started = Date.now();
    const ownsGroup =
      process.platform !== "win32" && !process.env.BL_TEST_PROCESS_GROUP;
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...(options.env ?? process.env), BL_TEST_PROCESS_GROUP: "1" },
      windowsHide: true,
      detached: ownsGroup,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "",
      stopped = false,
      killTimer,
      cleanup,
      commandError;
    let registration = Promise.resolve();
    const terminate = () => {
      if (stopped || !child.pid) return;
      stopped = true;
      if (process.platform === "win32") {
        cleanup = new Promise((done) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => {
            child.kill();
            done();
          });
          killer.once("close", done);
        });
      } else if (!ownsGroup) {
        child.kill("SIGTERM");
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already stopped */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* stopped */
          }
        }, 500);
      }
    };
    const collect = (chunk) => {
      if (commandError) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > 32 * 1024 * 1024) {
        commandError = new Error("Command output exceeded the capture limit");
        terminate();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    options.signal?.addEventListener("abort", terminate, { once: true });
    child.once("spawn", () => {
      registration = Promise.resolve()
        .then(() => options.onSpawn?.(child.pid))
        .catch((error) => {
          commandError = error;
          terminate();
        });
      if (options.signal?.aborted) terminate();
    });
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", terminate);
      reject(error);
    });
    child.once("close", async (code) => {
      await registration;
      if (cleanup) await cleanup;
      if (killTimer) {
        // The leader may exit first; still reap descendants that ignored SIGTERM.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
      if (commandError) {
        reject(commandError);
        return;
      }
      resolve({
        code: stopped ? 130 : (code ?? 1),
        output,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

export function commandSignal(timeoutMs = 2 * 60 * 60 * 1000) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, timeoutMs);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}
