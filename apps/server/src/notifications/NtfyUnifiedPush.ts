// @effect-diagnostics-next-line nodeBuiltinImport:off -- Validate the P-256 point and hash the exact registration tuple.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem lacks O_NOFOLLOW and O_NONBLOCK.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verify file type, mode and owner on the descriptor we read.
import * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { encrypt } from "web-push";

export const MAX_NATIVE_ALERT_AGE_MS = 120_000;
const MAX_FILE_BYTES = 4_096;
// Keep even ntfy's base64 representation under the pinned server's default 4 KiB limit.
const MAX_CIPHERTEXT_BYTES = 3_072;
const RFC8291_OVERHEAD_BYTES = 103;
const Registration = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  installationId: Schema.String,
  environmentId: Schema.String,
});
const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(Registration), {
  onExcessProperty: "error",
});
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

function isUnpaddedBase64Url(value: string, bytes: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

async function readPrivateFile(path: string) {
  // Check permissions and read on the same descriptor. Never follow a symlink or wait on a FIFO.
  if (NodeFS.constants.O_NOFOLLOW === undefined || NodeProcess.getuid === undefined)
    throw new Error();
  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (info.uid !== 0 && info.uid !== NodeProcess.getuid()) ||
      info.size > MAX_FILE_BYTES
    ) {
      throw new Error();
    }
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

export const readUnifiedPushRegistration = Effect.fnUntraced(function* (
  path: string,
  ntfyUrl: string,
  environmentId: string,
  token: Redacted.Redacted<string>,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      if (path.trim() === "") throw new Error();
      const value = decodeRegistration(await readPrivateFile(path));
      const endpoint = URL.parse(value.endpoint);
      if (
        endpoint === null ||
        endpoint.protocol !== "https:" ||
        endpoint.origin !== URL.parse(ntfyUrl)?.origin ||
        !/^\/up[A-Za-z0-9]{12}$/.test(endpoint.pathname) ||
        value.endpoint !== `${endpoint.origin}${endpoint.pathname}?up=1` ||
        value.environmentId !== environmentId ||
        environmentId.length === 0 ||
        environmentId.length > 128 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value.installationId,
        ) ||
        !isUnpaddedBase64Url(value.p256dh, 65) ||
        !isUnpaddedBase64Url(value.auth, 16) ||
        !/^[A-Za-z0-9._~+/-]{1,1024}={0,2}$/.test(Redacted.value(token))
      ) {
        throw new Error();
      }
      const publicKey = Buffer.from(value.p256dh, "base64url");
      if (publicKey[0] !== 4) throw new Error();
      NodeCrypto.ECDH.convertKey(publicKey, "prime256v1");
      const registrationId = sha256(`${value.endpoint}\n${value.p256dh}\n${value.auth}`);
      return {
        ...value,
        registrationId,
        deliveryKey: sha256(`${registrationId}\n${value.installationId}`),
      };
    },
    catch: (cause) =>
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
        ? ("absent" as const)
        : ("invalid" as const),
  }).pipe(Effect.catch((reason) => Effect.succeed(reason)));
});

type Registration = Exclude<Effect.Success<ReturnType<typeof readUnifiedPushRegistration>>, string>;

function truncateNativeText(value: string, maxLength: number, maxBytes: number) {
  const text = value.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, "");
  let low = 0;
  let high = text.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
    if (Buffer.byteLength(JSON.stringify(candidate)) - 2 <= maxBytes) low = length;
    else high = length - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
}

export function makeUnifiedPushRequest(input: {
  registration: Registration;
  token: Redacted.Redacted<string>;
  decisionKey: string;
  updatedAt: number;
  deepLink: string;
  title: string;
  message: string;
  ttlSeconds: number;
}) {
  const { registration, token, decisionKey, updatedAt, deepLink, title, message, ttlSeconds } =
    input;
  return Effect.try({
    try: () => {
      // Match the Android receiver's limits before spending a retry on an undeliverable alert.
      if (deepLink.length > 512) throw new Error();
      const makePayload = (alertTitle: string, alertBody: string) =>
        Buffer.from(
          // @effect-diagnostics-next-line globalJsonInEffect:off -- This typed string map is serialized inside Effect.try.
          JSON.stringify({
            device_id: registration.installationId,
            user_id: "self-hosted",
            environment_id: registration.environmentId,
            registration_id: registration.registrationId,
            updated_at: String(updatedAt),
            alert_id: sha256(`${deepLink}\n${decisionKey}`),
            alert_title: alertTitle,
            alert_body: alertBody,
            alert_group: deepLink,
            alert_path: deepLink,
          }),
        );
      const textBudget = Math.max(
        0,
        MAX_CIPHERTEXT_BYTES - RFC8291_OVERHEAD_BYTES - makePayload("", "").length,
      );
      const nativeTitle = truncateNativeText(title, 120, textBudget);
      const titleBytes = Buffer.byteLength(JSON.stringify(nativeTitle)) - 2;
      const nativeMessage = truncateNativeText(message, 608, textBudget - titleBytes);
      const payload = makePayload(nativeTitle, nativeMessage);
      if (payload.length > MAX_CIPHERTEXT_BYTES - RFC8291_OVERHEAD_BYTES) throw new Error();
      const { cipherText } = encrypt(registration.p256dh, registration.auth, payload, "aes128gcm");
      if (cipherText.length > MAX_CIPHERTEXT_BYTES) throw new Error();
      return HttpClientRequest.post(registration.endpoint).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "content-encoding": "aes128gcm",
          ttl: String(ttlSeconds),
        }),
        HttpClientRequest.bodyUint8Array(cipherText, "application/octet-stream"),
      );
    },
    catch: () => "invalid-native-payload" as const,
  });
}
