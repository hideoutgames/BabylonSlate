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
      const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", stdout.fd, stderr.fd], timeout: timeoutMs, windowsHide: true });
      const stop = () => child.kill("SIGTERM");
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      const clean = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); };
      child.once("error", () => { clean(); reject(new Error(`Apple ${stage} failed; private diagnostics were not published`)); });
      child.once("close", code => { clean(); if (code === 0) resolve(); else reject(new Error(`Apple ${stage} failed; private diagnostics were not published`)); });
    });
    return await readFile(stdoutPath, "utf8");
  } finally { await stdout.close(); await stderr.close(); }
}
