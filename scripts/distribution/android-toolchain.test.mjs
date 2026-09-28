import assert from "node:assert/strict";
import test from "node:test";
import { inspectAndroidToolchain } from "./android-toolchain.mjs";

const files = new Map([
  ["apps/editor/android/gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip"],
  ["apps/editor/android/variables.gradle", "ext { compileSdkVersion = 36 }"],
]);

test("Android toolchain inspection reads Java, Gradle and compile SDK versions", async () => {
  const result = await inspectAndroidToolchain({
    run: async () => { throw { stderr: Buffer.from('openjdk version "21.0.5" 2025-10-21') }; },
    readFile: async path => files.get(path),
  });
  assert.deepEqual(result, { jdk: "21.0.5", gradle: "8.14.3", androidSdk: "36" });
});

test("Android toolchain inspection rejects missing or nonnumeric versions", async () => {
  await assert.rejects(inspectAndroidToolchain({
    run: async () => "java version unknown",
    readFile: async path => files.get(path),
  }), /numeric/);
});
