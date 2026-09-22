import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { parse } from "yaml";

// Deliberately literal. Review GitHub's standard/public runner entitlement before
// extending this set; matching "ubuntu" also accepts paid larger-runner labels.
const standardRunners = new Set([
  "ubuntu-latest",
  "ubuntu-22.04",
  "ubuntu-24.04",
  "windows-latest",
  "windows-2022",
  "windows-2025",
  "macos-latest",
  "macos-14",
  "macos-15",
  "macos-26",
]);

export function validateJobRunner(job, context) {
  const label = job["runs-on"];
  const fail = () => {
    throw new Error(
      `${context}: expected literal standard GitHub-hosted runner labels`,
    );
  };
  if (typeof label !== "string") return fail();
  const matrixKey = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(label)?.[1];
  if (!matrixKey) {
    if (!standardRunners.has(label)) fail();
    return;
  }
  const matrix = job.strategy?.matrix;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix))
    return fail();
  const axis = matrix[matrixKey];
  const includes = matrix.include ?? [];
  if (!Array.isArray(includes) || (axis !== undefined && !Array.isArray(axis)))
    return fail();
  if (
    includes.some(
      (row) => !row || typeof row !== "object" || Array.isArray(row),
    )
  )
    return fail();
  const labels = [
    ...(axis ?? []),
    ...includes.filter((row) => matrixKey in row).map((row) => row[matrixKey]),
  ];
  if (!labels.length || labels.some((value) => !standardRunners.has(value)))
    return fail();
  if (axis === undefined && includes.some((row) => !(matrixKey in row))) fail();
}

export async function validateWorkflowRunners(root, path, visited = new Set()) {
  const absolute = resolve(root, path);
  const child = relative(resolve(root, ".github/workflows"), absolute);
  if (isAbsolute(child) || child.startsWith("..") || !/\.ya?ml$/.test(child))
    throw new Error(`Unsupported local reusable workflow: ${path}`);
  if (visited.has(absolute)) return;
  visited.add(absolute);
  const workflow = parse(await readFile(absolute, "utf8"));
  if (!workflow?.jobs || typeof workflow.jobs !== "object")
    throw new Error(`${path}: missing jobs`);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.uses !== undefined) {
      if (
        typeof job.uses !== "string" ||
        !job.uses.startsWith("./.github/workflows/")
      )
        throw new Error(
          `${path}/${name}: reusable workflow must have locally auditable runners`,
        );
      await validateWorkflowRunners(root, job.uses, visited);
    } else validateJobRunner(job, `${path}/${name}`);
  }
}
