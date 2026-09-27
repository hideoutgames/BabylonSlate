import { spawnSync } from "node:child_process";
import { readFile as readFileDefault } from "node:fs/promises";

const numeric = /^\d+(?:\.\d+){0,3}$/;

export async function inspectAndroidToolchain({
  run = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
  readFile = readFileDefault,
} = {}) {
  let javaOutput;
  try {
    const result = await run("java", ["-version"]);
    javaOutput = typeof result === "string" ? result : result?.stderr ?? result?.stdout ?? "";
  } catch (error) {
    javaOutput = error?.stderr?.toString?.() ?? "";
  }
  const jdk = String(javaOutput).match(/version\s+"(\d+(?:\.\d+){0,3})/)?.[1];
  const wrapper = await readFile("apps/editor/android/gradle/wrapper/gradle-wrapper.properties", "utf8");
  const gradle = wrapper.match(/gradle-(\d+(?:\.\d+){0,3})-(?:all|bin)\.zip/)?.[1];
  const variables = await readFile("apps/editor/android/variables.gradle", "utf8");
  const androidSdk = variables.match(/compileSdkVersion\s*=\s*(\d+(?:\.\d+){0,3})/)?.[1];
  if (![jdk, gradle, androidSdk].every(value => typeof value === "string" && numeric.test(value))) throw new Error("Android toolchain versions must be numeric");
  return { jdk, gradle, androidSdk };
}
