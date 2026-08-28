import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL(
  "../ios/App/App/capacitor.config.json",
  import.meta.url,
);
const config = JSON.parse(await readFile(configPath, "utf8"));
const packageClassList = new Set(config.packageClassList ?? []);
packageClassList.add("BabylonSlateSecretsPlugin");
config.packageClassList = [...packageClassList];
await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`);
