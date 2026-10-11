import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function privateCommand(command, args, { directory, stage, cwd, env = process.env, timeoutMs = 30 * 60 * 1000 }) {
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error("Invalid private command stage");
  const stdoutPath = join(directory, `${stage}.stdout`);
  const stdout = await open(stdoutPath, "w", 0o600);
  const stderr = await open(join(directory, `${stage}.stderr`), "w", 0o600);
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (/(?:_BASE64|_PASSWORD|_TOKEN)$/.test(key)) delete childEnv[key];
  try {
    await new Promise((resolve, reject) => {
      // A separate process group lets a timeout or cancellation also stop the tools the
      // command started (xcodebuild compilers, Fastlane's uploader) before cleanup runs.
      const group = process.platform !== "win32";
      const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", stdout.fd, stderr.fd], detached: group, windowsHide: true });
      const signal = name => {
        try { if (group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* Already exited. */ }
      };
      let stopping = false;
      let escalation;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        signal("SIGTERM");
        escalation = setTimeout(() => signal("SIGKILL"), 10_000);
      };
      const timer = setTimeout(stop, timeoutMs);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      const clean = () => {
        clearTimeout(timer);
        clearTimeout(escalation);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        // Descendants that outlived a stopped command must not keep using private files.
        if (stopping) signal("SIGKILL");
      };
      const fail = () => reject(new Error(`Apple ${stage} failed; private diagnostics were not published`));
      child.once("error", () => { clean(); fail(); });
      child.once("close", code => { clean(); if (code === 0 && !stopping) resolve(); else fail(); });
    });
    return await readFile(stdoutPath, "utf8");
  } finally { await stdout.close(); await stderr.close(); }
}
