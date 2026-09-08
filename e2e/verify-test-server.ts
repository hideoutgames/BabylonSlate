/** Direct Playwright invocations may list tests; execution requires an owned server. */
export default async function verifyTestServer() {
  const baseURL = process.env.BL_TEST_BASE_URL;
  if (!baseURL || !process.env.BL_TEST_SERVER_NONCE)
    throw new Error(
      "Run browser tests with pnpm test:e2e so the build and server are owned by this run",
    );
  const response = await fetch(`${baseURL}/__test_identity`, {
    signal: AbortSignal.timeout(5_000),
  });
  const identity = (await response.json()) as { key: string; nonce: string };
  if (
    !response.ok ||
    identity.key !== process.env.BL_TEST_BUILD_KEY ||
    identity.nonce !== process.env.BL_TEST_SERVER_NONCE
  )
    throw new Error("Test server identity does not match this run");
}
