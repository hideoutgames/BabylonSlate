import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const androidDir = fileURLToPath(new URL("../android", import.meta.url));
if (!process.env.JAVA_HOME) {
  const java = spawnSync("java", ["-version"], { stdio: "ignore" });
  if (java.error || java.status !== 0) throw new Error("Android build requires JAVA_HOME or java on PATH");
}
const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const result = spawnSync(wrapper, ["assembleDebug", "--no-daemon"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error || result.status !== 0) {
  throw result.error ?? new Error(`Android Gradle build failed with status ${result.status}`);
}
