/** CI assertions are independent from permission to bypass local admission. */
export function hostedExecution(env = process.env) {
  if (
    env.BL_EXECUTION_POLICY !== undefined &&
    !["local", "hosted-ci"].includes(env.BL_EXECUTION_POLICY)
  )
    throw new Error("BL_EXECUTION_POLICY must be local or hosted-ci");
  if (env.BL_EXECUTION_POLICY !== "hosted-ci") return false;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !env.GITHUB_REPOSITORY ||
    !["Linux", "Windows", "macOS"].includes(env.RUNNER_OS)
  )
    throw new Error(
      "hosted-ci execution requires a complete GitHub-hosted runner context; local CI=true does not bypass admission",
    );
  return true;
}
