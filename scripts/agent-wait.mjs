import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync, writeSync, readSync, fstatSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import {
  requiredVerifyJobs,
  verificationPolicy,
} from "./verification-policy.mjs";

const TWO_HOURS = 2 * 60 * 60 * 1000;
const CODES = { failure: 1, cancellation: 130, timeout: 124, stale: 3 };
class WaitError extends Error {
  constructor(status, message, exitCode = CODES[status]) {
    super(message);
    this.status = status;
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, timeoutMs: TWO_HOURS, args: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      options.args = rest.slice(i + 1);
      break;
    }
    if (
      !["--script", "--pr", "--timeout-seconds"].includes(arg) ||
      !rest[i + 1]
    ) {
      throw new Error(
        "Use local --script <name> [-- <script args>], ci --pr <number>, or slot --pr <number>; optional --timeout-seconds <seconds>.",
      );
    }
    const value = rest[++i];
    if (arg === "--script") options.script = value;
    else if (arg === "--pr") options.pr = Number(value);
    else options.timeoutMs = Number(value) * 1000;
  }
  if (
    !["local", "ci", "slot"].includes(mode) ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2147483647 ||
    (mode === "local"
      ? !options.script || options.pr !== undefined
      : !Number.isSafeInteger(options.pr) ||
        options.pr <= 0 ||
        options.script ||
        options.args.length)
  ) {
    throw new Error("Invalid operation, script, PR number, or deadline.");
  }
  return options;
}

// Context supplies process boundaries and timing for executable fixture tests.
// The CLI always uses real tools and 60-second polling; it has no daemon state.
export async function runAgentWait(options, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const emit = context.write ?? ((text) => process.stdout.write(text));
  const gh = context.gh ?? ["gh"];
  const pollMs = context.pollMs ?? 60000;
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "agent-wait-"));
  const logPath = join(directory, "output.log");
  const resultPath = join(directory, "result.json");
  const fd = openSync(logPath, "w+");
  const result = {
    operation: options.mode,
    status: "failure",
    exitCode: 1,
    commitSha: null,
    logPath,
    resultPath,
  };
  const controller = new AbortController();
  let stopped;
  let commandFailureEnd;
  const stop = (status, code) => {
    if (!stopped) {
      stopped = new WaitError(
        status,
        status === "timeout" ? "Deadline expired." : "Interrupted.",
        code,
      );
      controller.abort();
    }
  };
  const onAbort = () => stop("cancellation");
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => stop("timeout"),
    options.timeoutMs ?? TWO_HOURS,
  );
  const sigint = () => stop("cancellation", 130);
  const sigterm = () => stop("cancellation", 143);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  emit(
    JSON.stringify({ event: "start", operation: options.mode, logPath }) + "\n",
  );

  const check = () => {
    if (stopped) throw stopped;
  };
  const log = (text) => writeSync(fd, text);
  async function command(prefix, args, capture = false, cleanupSignal) {
    const activeSignal = cleanupSignal ?? controller.signal;
    const interruption = () =>
      cleanupSignal
        ? cleanupSignal.aborted
          ? new Error("Final snapshot deadline expired.")
          : undefined
        : stopped;
    if (interruption()) throw interruption();
    // Only tool arguments are recorded, never the inherited environment.
    log(`\n$ ${JSON.stringify([...prefix, ...args])}\n`);
    return new Promise((resolveCommand, reject) => {
      let output = "";
      let capturedBytes = 0;
      const decoder = new StringDecoder("utf8");
      let overflow = false;
      let killTimer;
      let termination;
      const child = spawn(prefix[0], [...prefix.slice(1), ...args], {
        cwd,
        env: { ...env, BL_TEST_PROCESS_GROUP: "1" },
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", capture ? "pipe" : fd, fd],
      });
      const killGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") log(`Cleanup: ${error.message}\n`);
        }
      };
      const terminate = () => {
        if (!child.pid || termination) return;
        if (process.platform === "win32") {
          // /PID + /T targets this helper's child tree only, never an image name.
          termination = new Promise((done) => {
            const killer = spawn(
              "taskkill.exe",
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: ["ignore", fd, fd] },
            );
            killer.once("error", (error) => {
              log(`Cleanup: ${error.message}\n`);
              child.kill();
              done();
            });
            killer.once("close", done);
          });
        } else {
          killGroup("SIGTERM");
          termination = new Promise((done) => {
            killTimer = setTimeout(() => {
              killGroup("SIGKILL");
              done();
            }, 500);
          });
        }
      };
      activeSignal.addEventListener("abort", terminate, { once: true });
      if (activeSignal.aborted) terminate();
      child.stdout?.on("data", (chunk) => {
        writeSync(fd, chunk);
        capturedBytes += chunk.length;
        if (capturedBytes > 16 * 1024 * 1024) overflow = true;
        else output += decoder.write(chunk);
      });
      child.once("error", (error) => {
        activeSignal.removeEventListener("abort", terminate);
        reject(
          interruption() ??
            new WaitError(
              "failure",
              `Cannot launch ${prefix[0]}: ${error.message}`,
              127,
            ),
        );
      });
      child.once("close", async (code, signal) => {
        await termination;
        clearTimeout(killTimer);
        activeSignal.removeEventListener("abort", terminate);
        if (interruption()) return reject(interruption());
        if (overflow)
          return reject(
            new WaitError(
              "failure",
              "Tool metadata exceeds 16 MiB; full output is in the log.",
            ),
          );
        resolveCommand({
          code: code ?? (signal === "SIGINT" ? 130 : 143),
          signal,
          output: output + decoder.end(),
        });
      });
    });
  }
  async function checked(prefix, args, cleanupSignal) {
    const response = await command(prefix, args, true, cleanupSignal);
    if (response.code !== 0)
      throw new WaitError(
        "failure",
        `${prefix[0]} exited with ${response.code}; see log.`,
        response.code,
      );
    return response.output;
  }
  const json = async (args) => JSON.parse(await checked(gh, args));
  const pause = async (ms = pollMs) => {
    try {
      await delay(ms, undefined, { signal: controller.signal });
    } catch {
      check();
    }
  };
  const head = async () =>
    json([
      "pr",
      "view",
      String(options.pr),
      "--json",
      "headRefOid,headRefName,isDraft",
    ]);
  async function state(phase, cleanupSignal) {
    const git = (args) => checked(["git"], args, cleanupSignal);
    const commit = (await git(["rev-parse", "HEAD"])).trim();
    const status = await git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const diff = await git([
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    const untracked = (
      await git(["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256").update(status).update(diff);
    for (const file of untracked) {
      if (cleanupSignal) cleanupSignal.throwIfAborted();
      else check();
      hash
        .update(file)
        .update("\0")
        .update(await readFile(join(cwd, file)))
        .update("\0");
    }
    const snapshot = {
      commit,
      digest: hash.digest("hex"),
      clean: status === "",
    };
    await writeFile(
      join(directory, `${phase}-state.json`),
      JSON.stringify({ ...snapshot, status }, null, 2) + "\n",
    );
    return snapshot;
  }
  async function latest(pr) {
    const runs = await json([
      "run",
      "list",
      "--workflow",
      "verify.yml",
      "--event",
      "pull_request",
      "--commit",
      pr.headRefOid,
      "--branch",
      pr.headRefName,
      "--limit",
      "100",
      "--json",
      "databaseId,headSha,event,status,conclusion,url,createdAt,attempt",
    ]);
    if (!Array.isArray(runs)) throw new Error("Invalid run list.");
    return runs
      .filter(
        (run) => run.event === "pull_request" && run.headSha === pr.headRefOid,
      )
      .sort((a, b) => b.databaseId - a.databaseId)[0];
  }
  try {
    check();
    if (options.mode === "local") {
      result.script = options.script;
      result.deliveryEligible = false;
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (
        !Object.hasOwn(pkg.scripts ?? {}, options.script) ||
        options.script === "agent:wait"
      )
        throw new Error(
          "Select an existing package script other than agent:wait.",
        );
      const entry = env.npm_execpath;
      if (!entry || /\.(cmd|bat|ps1)$/i.test(entry))
        throw new Error(
          "Missing pnpm package-manager entry point. Launch through pnpm agent:wait (or set npm_execpath to its installed JS/executable entry point).",
        );
      try {
        await access(entry);
      } catch {
        throw new Error("The pnpm package-manager entry point is missing.");
      }
      const manager = /\.(c?js|mjs)$/i.test(entry)
        ? [process.execPath, entry]
        : [entry];
      result.initialState = await state("initial");
      result.commitSha = result.initialState.commit;
      const response = await command(manager, [
        "run",
        options.script,
        ...(options.args ?? []),
      ]);
      result.childExitCode = response.code;
      if (response.code !== 0) commandFailureEnd = fstatSync(fd).size;
      result.finalState = await state("final");
      if (response.signal)
        throw new WaitError(
          "cancellation",
          `Child interrupted by ${response.signal}.`,
          response.code,
        );
      if (response.code !== 0)
        throw new WaitError(
          "failure",
          "Package script failed; see log.",
          response.code,
        );
      const unchanged =
        result.initialState.commit === result.finalState.commit &&
        result.initialState.digest === result.finalState.digest;
      if (
        ["verify", "verify:local"].includes(options.script) &&
        (!unchanged || !result.initialState.clean || !result.finalState.clean)
      )
        throw new WaitError(
          "stale",
          "Verification does not match a clean, unchanged committed tree.",
        );
      result.deliveryEligible =
        ["verify", "verify:local"].includes(options.script) &&
        !options.args?.length;
    } else if (options.mode === "ci") {
      const pr = await head();
      if (!/^[a-f0-9]{40}$/i.test(pr.headRefOid) || !pr.headRefName)
        throw new Error("Missing PR head.");
      result.commitSha = pr.headRefOid;
      if (pr.isDraft)
        throw new WaitError(
          "failure",
          "Draft PR checks cannot satisfy Verify. Wait for a slot and mark ready first.",
        );
      const discoveryDeadline =
        Date.now() + (context.discoveryMs ?? 10 * 60 * 1000);
      let run;
      while (!(run = await latest(pr))) {
        if (Date.now() >= discoveryDeadline)
          throw new WaitError(
            "timeout",
            "No pull-request Verify run appeared before the discovery deadline.",
          );
        if ((await head()).headRefOid !== pr.headRefOid)
          throw new WaitError("stale", "PR head changed during discovery.");
        await pause(
          Math.min(pollMs, Math.max(1, discoveryDeadline - Date.now())),
        );
      }
      result.runId = run.databaseId;
      result.runUrl = run.url;
      result.runAttempt = run.attempt;
      const watched = await command(gh, [
        "run",
        "watch",
        String(run.databaseId),
        "--exit-status",
        "--interval",
        "60",
      ]);
      const detail = await json([
        "run",
        "view",
        String(run.databaseId),
        "--json",
        "databaseId,headSha,event,status,conclusion,url,attempt,jobs",
      ]);
      const finalRun = await latest(pr);
      const finalPr = await head();
      if (
        finalPr.headRefOid !== pr.headRefOid ||
        finalPr.isDraft ||
        !finalRun ||
        finalRun.databaseId !== run.databaseId ||
        finalRun.attempt !== run.attempt ||
        detail.databaseId !== run.databaseId ||
        detail.attempt !== run.attempt ||
        detail.headSha !== pr.headRefOid ||
        detail.event !== "pull_request"
      ) {
        throw new WaitError("stale", "PR head or Verify run identity changed.");
      }
      if (detail.conclusion === "cancelled")
        throw new WaitError("cancellation", "Verify was cancelled.");
      if (detail.conclusion === "timed_out")
        throw new WaitError("timeout", "Verify timed out.");
      if (
        watched.code !== 0 ||
        detail.status !== "completed" ||
        detail.conclusion !== "success" ||
        finalRun.status !== "completed" ||
        finalRun.conclusion !== "success"
      )
        throw new WaitError("failure", "Verify did not complete successfully.");
      const required = requiredVerifyJobs;
      if (
        !Array.isArray(detail.jobs) ||
        required.some(
          (name) =>
            !detail.jobs.some(
              (job) =>
                job.name === name &&
                job.status === "completed" &&
                job.conclusion === "success",
            ),
        ) ||
        detail.jobs.some(
          (job) => job.status !== "completed" || job.conclusion !== "success",
        )
      )
        throw new WaitError(
          "failure",
          "Verify contains missing, skipped, or unsuccessful jobs.",
        );
    } else if (options.mode === "slot") {
      result.commitSha = (await head()).headRefOid;
      while (true) {
        const prs = await json([
          "pr",
          "list",
          "--base",
          "main",
          "--state",
          "open",
          "--limit",
          "1000",
          "--json",
          "number,isDraft",
        ]);
        if (
          !Array.isArray(prs) ||
          prs.length >= 1000 ||
          prs.some(
            (pr) =>
              !Number.isInteger(pr.number) || typeof pr.isDraft !== "boolean",
          )
        )
          throw new Error(
            "Incomplete or invalid PR list; capacity is unknown.",
          );
        result.otherReadyPrs = prs.filter(
          (pr) => !pr.isDraft && pr.number !== options.pr && pr.number !== 271,
        ).length;
        if (result.otherReadyPrs < verificationPolicy.readyPrSlots) break;
        await pause();
      }
    } else throw new Error("Unknown operation.");
    check();
    result.status = "success";
    result.exitCode = 0;
  } catch (error) {
    const failure = stopped ?? error;
    result.status = failure.status ?? "failure";
    result.exitCode = failure.exitCode ?? 1;
    result.message = failure.message;
    log(`\n${result.status}: ${result.message}\n`);
    if (options.mode === "local" && result.initialState && !result.finalState) {
      commandFailureEnd ??= fstatSync(fd).size;
      // Children have stopped. A separately bounded, read-only snapshot cannot
      // turn the failed/interrupted operation into a pass.
      try {
        result.finalState = await state("final", AbortSignal.timeout(5000));
      } catch (snapshotError) {
        result.finalState = null;
        result.finalStateError = snapshotError.message;
        log(`Final snapshot unavailable: ${snapshotError.message}\n`);
      }
    }
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
  result.elapsedMs = Date.now() - started;
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  const terminal = {
    event: "result",
    operation: result.operation,
    status: result.status,
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode,
    commitSha: result.commitSha,
    ...(result.runUrl ? { runUrl: result.runUrl } : {}),
    logPath,
    resultPath,
  };
  emit(JSON.stringify(terminal) + "\n");
  if (result.status !== "success") {
    const size = commandFailureEnd ?? fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 3072));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    // Discard a partial UTF-8 codepoint at the byte boundary.
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    const text = tail
      .subarray(start)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .slice(-40)
      .join("\n");
    emit(text + "\n");
  }
  closeSync(fd);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = (
      await runAgentWait(parseArgs(process.argv.slice(2)))
    ).exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
