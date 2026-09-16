import { randomBytes, createHash } from "node:crypto";
import type { Bundle } from "./bundle";
import { consentVersion } from "./bundle";
export interface UploadState {
  id: string;
  token: string;
  receipt?: string;
  endpoint: string;
  hash: string;
  consent: Record<string, unknown>;
}
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function contributionURL(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (!["127.0.0.1", "[::1]"].includes(u.hostname) && u.protocol !== "https:") ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new Error("Contribution service must use HTTPS or literal loopback.");
  return u.toString().replace(/\/$/, "");
}
export async function uploadBundle(
  bundle: Bundle,
  endpoint: string,
  existing: UploadState | undefined,
  save: (state: UploadState) => void,
  request: typeof fetch = fetch,
): Promise<UploadState> {
  const root = contributionURL(endpoint),
    bytes = Buffer.from(JSON.stringify(bundle)),
    sha256 = hash(bytes),
    size = 256 * 1024;
  let state = existing;
  const call = async (
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ) => {
    const r = await request(root + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new Error(
        `Contribution service returned HTTP ${r.status}. Your local run is retained.`,
      );
    return r.json();
  };
  if (state && (state.hash !== sha256 || state.endpoint !== root))
    throw new Error(
      "Review changed. Delete the previous contribution before creating a new one.",
    );
  if (!state) {
    const token = randomBytes(32).toString("hex");
    const consent = {
      version: consentVersion,
      run_id: bundle.run_ref,
      timestamp: new Date().toISOString(),
      data_classes:
        bundle.level === "statistics"
          ? ["statistics"]
          : [
              "sanitized_task",
              "sanitized_actions",
              "corrections",
              "synthetic_frames",
              "statistics",
            ],
      purpose: "computer-use-research-and-synthetic-environments",
      retention: "alpha-7-days",
      bundle_sha256: sha256,
    };
    const id = crypto.randomUUID();
    state = { id, token, endpoint: root, hash: sha256, consent };
    save(state);
  }
  // Idempotent creation also repairs a lost response or interrupted first request.
  await call("/contributions", "POST", {
    id: state.id,
    token: state.token,
    manifest: {
      sha256,
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / size),
    },
    consent: state.consent,
  });
  let status;
  try {
    status = await call(
      "/contributions/" + state.id,
      "GET",
      undefined,
      state.token,
    );
  } catch (e) {
    throw e;
  }
  for (let i = 0; i < Math.ceil(bytes.length / size); i++) {
    const chunk = bytes.subarray(
      i * size,
      Math.min(bytes.length, (i + 1) * size),
    );
    if (status.acked.includes(i)) continue;
    const ack = await call(
      `/contributions/${state.id}/chunks/${i}`,
      "PUT",
      { data: chunk.toString("base64"), sha256: hash(chunk) },
      state.token,
    );
    if (ack.sha256 !== hash(chunk))
      throw new Error("Chunk checksum acknowledgement mismatch.");
  }
  const receipt = await call(
    `/contributions/${state.id}/commit`,
    "POST",
    {},
    state.token,
  );
  if (receipt.sha256 !== sha256)
    throw new Error("Manifest checksum acknowledgement mismatch.");
  state.receipt = receipt.receipt;
  save(state);
  return state;
}
export async function deleteContribution(
  state: UploadState,
  request: typeof fetch = fetch,
) {
  const r = await request(
    contributionURL(state.endpoint) + "/contributions/" + state.id,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer " + state.token },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok)
    throw new Error(
      "Deletion was not acknowledged. Keep the receipt and retry.",
    );
  const result = await r.json();
  if (result.deleted !== state.id)
    throw new Error("Deletion acknowledgement mismatch.");
}
