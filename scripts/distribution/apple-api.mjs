import { createPrivateKey, sign } from "node:crypto";

export function appleClient(env = process.env) {
  let key;
  try { key = createPrivateKey(Buffer.from(env.ASC_PRIVATE_KEY_P8_BASE64, "base64")); }
  catch { throw new Error("App Store Connect private key is invalid"); }
  return async function api(path, { method = "GET", body } = {}) {
    const url = new URL(path, "https://api.appstoreconnect.apple.com");
    if (url.origin !== "https://api.appstoreconnect.apple.com" || !url.pathname.startsWith("/v1/")) throw new Error("Unexpected App Store Connect endpoint");
    const now = Math.floor(Date.now() / 1000);
    const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encoded({ alg: "ES256", kid: env.ASC_KEY_ID, typ: "JWT" });
    const payload = encoded({ iat: now - 10, exp: now + 600, aud: "appstoreconnect-v1", ...(env.ASC_ISSUER_ID ? { iss: env.ASC_ISSUER_ID } : { sub: "user" }) });
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${header}.${payload}.${signature}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) throw new Error(`App Store Connect request failed (${response.status}); inspect configuration or state privately`);
    return response.status === 204 ? null : response.json();
  };
}
