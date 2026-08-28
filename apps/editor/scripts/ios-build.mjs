import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const defaultDeveloperDir = "/Applications/Xcode_16.4.app/Contents/Developer";

function resolveDeveloperDir() {
  if (process.env.DEVELOPER_DIR) {
    return process.env.DEVELOPER_DIR;
  }
  if (existsSync(defaultDeveloperDir)) {
    return defaultDeveloperDir;
  }

  const result = spawnSync("xcode-select", ["-p"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || "xcode-select failed");
  }
  const selectedDeveloperDir = result.stdout.trim();
  if (!selectedDeveloperDir) {
    throw new Error("xcode-select returned an empty developer directory");
  }
  return selectedDeveloperDir;
}

function runtimeVersion(runtime) {
  const match = runtime.match(/iOS-(\d+)-(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function findNewestIPad(developerDir) {
  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, DEVELOPER_DIR: developerDir },
    },
  );
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || "simctl failed");
  }

  const devices = JSON.parse(result.stdout).devices ?? {};
  const candidates = Object.entries(devices).flatMap(
    ([runtime, runtimeDevices]) =>
      runtimeDevices
        .filter(
          (device) =>
            device.isAvailable !== false &&
            /^iPad(?: |$)/.test(device.name) &&
            typeof device.udid === "string",
        )
        .map((device) => ({ device, runtime })),
  );
  candidates.sort((left, right) => {
    const [leftMajor, leftMinor] = runtimeVersion(left.runtime);
    const [rightMajor, rightMinor] = runtimeVersion(right.runtime);
    return (
      rightMajor - leftMajor ||
      rightMinor - leftMinor ||
      left.device.name.localeCompare(right.device.name)
    );
  });

  if (!candidates[0]) {
    throw new Error("No available iPad simulator was found");
  }
  return candidates[0].device.udid;
}

const developerDir = resolveDeveloperDir();
const simulatorId =
  process.env.IOS_SIMULATOR_ID ?? findNewestIPad(developerDir);
const result = spawnSync(
  "xcodebuild",
  [
    "-workspace",
    "ios/App/App.xcworkspace",
    "-scheme",
    "App",
    "-configuration",
    "Debug",
    "-destination",
    `id=${simulatorId}`,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ],
  {
    env: { ...process.env, DEVELOPER_DIR: developerDir },
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
