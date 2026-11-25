// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off globalFetch:off globalTimers:off globalTimersInEffect:off processEnvInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import WebSocket from "ws";
export class HermesGatewayError extends Schema.TaggedError<HermesGatewayError>()(
  "HermesGatewayError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export const hermesOrigin = (endpoint: string): string => {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
};

export const isHermesGatewayError = Schema.is(HermesGatewayError);

const failure = (operation: string, cause: unknown) =>
  isHermesGatewayError(cause)
    ? cause
    : new HermesGatewayError({
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        ...(cause === undefined ? {} : { cause }),
      });

const recordField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const stringField = (value: unknown, key: string): string | undefined => {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
};
const integerField = (value: unknown, key: string): number | undefined => {
  const field = recordField(value, key);
  return typeof field === "number" && Number.isInteger(field) ? field : undefined;
};

type Pending = {
  readonly resume: (effect: Effect.Effect<unknown, HermesGatewayError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const SessionEvent = Schema.Struct({
  type: Schema.String,
  session_id: Schema.String,
  payload: Schema.Unknown,
  replay_epoch: Schema.optional(Schema.String),
  seq: Schema.optional(Schema.Int),
  authority_epoch: Schema.optional(Schema.Int),
  admission_id: Schema.optional(Schema.String),
  execution_generation: Schema.optional(Schema.Int),
});
const decodeSessionEvent = Schema.decodeUnknownOption(SessionEvent);

const TextTurnReceipt = Schema.Struct({
  admission_id: Schema.NonEmptyString,
  ref: Schema.Struct({ profile_id: Schema.NonEmptyString, session_id: Schema.NonEmptyString }),
  sequence: Schema.Int,
  status: Schema.Literals(["queued", "started", "unknown", "terminal"]),
  outcome: Schema.NullOr(Schema.String),
  authority_epoch: Schema.Int,
  execution_generation: Schema.NullOr(Schema.Int),
  result: Schema.optional(
    Schema.Struct({
      final_response: Schema.optional(Schema.String),
      error: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  usage: Schema.optional(Schema.Unknown),
});
export type HermesTextTurnReceipt = typeof TextTurnReceipt.Type;
const decodeReceipt = Schema.decodeUnknownSync(TextTurnReceipt);
export function decodeTextTurnReceipt(raw: unknown): HermesTextTurnReceipt {
  const receipt = decodeReceipt(raw);
  if (receipt.result?.error === null) {
    return { ...receipt, result: { final_response: receipt.result.final_response } };
  }
  return receipt;
}

export const ImageAttachResult = Schema.Struct({
  attached: Schema.Literal(true),
  path: Schema.NonEmptyString,
  mime: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: Schema.Int,
});
export type HermesImageAttachResult = typeof ImageAttachResult.Type;

export const decodeImageAttachResult = Schema.decodeUnknownSync(ImageAttachResult);

export interface HermesPendingImage {
  readonly inputId: string;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentBase64: string;
  readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly uploadClaimed: boolean;
}

export interface HermesAttachedImage {
  readonly inputId: string;
  readonly attachmentId: string;
  readonly path: string;
  readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly bytes: number;
}

const decodeReplay = Schema.decodeUnknownSync(
  Schema.Struct({
    replay_epoch: Schema.String,
    last_sequence: Schema.Int,
    snapshot_required: Schema.Literal(false),
    truncated: Schema.Literal(false),
    events: Schema.Array(SessionEvent),
  }),
);

type ReplayCursor = { readonly epoch: string; readonly sequence: number };

/** One scoped canonical listener with single-flight reconnects. */
export class HermesGateway {
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Map<
    Queue.Queue<typeof SessionEvent.Type, HermesGatewayError>,
    string
  >();
  private readonly rpcLock = Semaphore.makeUnsafe(1);
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;

  private readonly endpoint: URL;
  private readonly token: string;
  private readonly origin: string;

  private constructor(endpoint: URL, token: string, origin: string) {
    this.endpoint = endpoint;
    this.token = token;
    this.origin = origin;
  }

  static connect(
    endpoint: string,
    token: string,
    origin: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    return Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const url = new URL(endpoint);
          if (url.protocol !== "ws:" && url.protocol !== "wss:") {
            throw new Error("Hermes gateway URL must use ws: or wss:");
          }
          if (
            url.protocol === "ws:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            environment.HERMES_ALLOW_CLEARTEXT !== "1"
          ) {
            throw new Error("Cleartext Hermes transport requires HERMES_ALLOW_CLEARTEXT=1");
          }
          const gateway = new HermesGateway(url, token, origin);
          await gateway.ensureOpen();
          return gateway;
        },
        catch: (cause) => failure("connect", cause),
      }),
      (gateway) => gateway.close,
    );
  }

  private async mintTicket(): Promise<string> {
    const url = new URL(this.endpoint);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/api/webapp/socket-ticket";
    url.searchParams.set("socket", "gateway");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const body = await Promise.race([
      (async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "X-Hermes-Session-Token": this.token },
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok)
          throw Object.assign(
            new Error(`Hermes ticket exchange returned HTTP ${response.status}`),
            { status: response.status },
          );
        return (await response.json()) as { ticket?: unknown };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Hermes ticket exchange timed out"));
        }, 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (typeof body.ticket !== "string" || !body.ticket) {
      throw new Error("Hermes ticket exchange returned no ticket");
    }
    return body.ticket;
  }

  private ensureOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("Hermes Gateway connection is closed"));
    if (this.opening) return this.opening;
    this.opening = this.openSocket().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openSocket(): Promise<void> {
    const ticket = await this.mintTicket();
    if (this.closed) throw new Error("Hermes Gateway connection is closed");
    const url = new URL(this.endpoint);
    url.searchParams.set("native_dial", "browser");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`], {
        headers: { origin: this.origin },
      });
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("Timed out connecting to Hermes Gateway"));
      }, 10_000);
      const succeed = () => {
        if (this.closed) {
          clearTimeout(timer);
          socket.close();
          fail(new Error("Gateway closed while connecting"));
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(failure("connect", cause));
      };
      socket.addEventListener("open", succeed);
      socket.addEventListener("error", (event) =>
        fail(event.error ?? "WebSocket connection failed"),
      );
      socket.addEventListener("close", () => {
        this.disconnect(socket, failure("socket", "Gateway connection closed"));
        fail(new Error("Gateway closed before the connection opened"));
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data, socket));
    });
  }

  private handleMessage(data: unknown, source: WebSocket): void {
    if (this.socket !== source) return;
    try {
      const message = JSON.parse(String(data)) as {
        id?: string | null;
        method?: unknown;
        params?: unknown;
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if ("method" in message) {
        if (message.id == null && message.method === "event") {
          const addressedSession = stringField(message.params, "session_id");
          // Global broadcasts have no session stream to reconcile.
          if (!addressedSession) return;
          const decoded = decodeSessionEvent(message.params);
          const event = decoded._tag === "Some" ? decoded.value : undefined;
          const gap = event?.type === "session.replay_gap";
          for (const [queue, sessionId] of this.subscribers) {
            if (addressedSession !== sessionId) continue;
            if (!event || gap || !Queue.offerUnsafe(queue, event)) {
              this.subscribers.delete(queue);
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  failure(
                    "event",
                    !event
                      ? "Invalid Hermes session event"
                      : gap
                        ? "Gateway reported an event replay gap"
                        : "Gateway event backlog overflow",
                  ),
                ),
              );
            }
          }
        }
        return;
      }
      if (message.id == null) {
        if (message.error) {
          const error = failure(
            "rpc",
            message.error.message ?? "Uncorrelated Hermes JSON-RPC error",
          );
          this.disconnect(source, error);
          source.close();
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resume(
        message.error
          ? Effect.fail(
              failure(
                "rpc-response",
                `${message.error.message ?? "Hermes JSON-RPC error"} (code ${message.error.code ?? "unknown"})`,
              ),
            )
          : Effect.succeed(message.result),
      );
    } catch (cause) {
      this.disconnect(source, failure("decode", cause));
      source.close();
    }
  }

  /** Acquire a fresh connection, then keep verification and its RPCs on that exact socket. */
  readonly connection = Effect.tryPromise({
    try: async () => {
      await this.ensureOpen();
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Hermes Gateway connection is not open");
      }
      const request = (method: string, params: Record<string, unknown>) =>
        this.rpcLock.withPermits(1)(this.requestOn(socket, method, params));
      return {
        request,
        subscribeEvents: (sessionId: string) => this.subscribeEventsOn(socket, sessionId),
        replayEvents: (sessionId: string, cursor: ReplayCursor) =>
          request("session.events.since", {
            session_id: sessionId,
            replay_epoch: cursor.epoch,
            last_sequence: cursor.sequence,
          }).pipe(
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => {
                  const replay = decodeReplay(raw);
                  if (
                    replay.replay_epoch !== cursor.epoch ||
                    replay.last_sequence !== cursor.sequence + replay.events.length ||
                    replay.events.some(
                      (frame, index) =>
                        frame.session_id !== sessionId ||
                        frame.replay_epoch !== cursor.epoch ||
                        frame.seq !== cursor.sequence + index + 1 ||
                        frame.type === "session.replay_gap",
                    )
                  ) {
                    throw new Error("Hermes replay does not cover the requested cursor");
                  }
                  return replay.events;
                },
                catch: (cause) => failure("session.events.since", cause),
              }),
            ),
          ),
      };
    },
    catch: (cause) => failure("socket", cause),
  });

  /** Live frames only. After loss, reacquire, reverify, and replay from the last applied cursor. */
  private subscribeEventsOn(socket: WebSocket, sessionId: string) {
    return Effect.acquireRelease(
      Effect.gen({ self: this }, function* () {
        const queue = yield* Queue.dropping<typeof SessionEvent.Type, HermesGatewayError>(256);
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
          Queue.shutdownUnsafe(queue);
          return yield* failure("socket", "Pinned Gateway connection is not open");
        }
        this.subscribers.set(queue, sessionId);
        return queue;
      }),
      (queue) =>
        Effect.sync(() => {
          this.subscribers.delete(queue);
          Queue.shutdownUnsafe(queue);
        }),
    ).pipe(Effect.map(Stream.fromQueue));
  }

  private requestOn(
    socket: WebSocket,
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, HermesGatewayError> {
    return Effect.callback<unknown, HermesGatewayError>((resume) => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        resume(Effect.fail(failure(method, "Pinned Gateway connection is not open")));
        return;
      }
      const id = NodeCrypto.randomUUID();
      const fail = (cause: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resume(Effect.fail(failure(method, cause)));
      };
      const timer = setTimeout(() => {
        fail("Hermes RPC timed out");
        this.disconnect(socket, failure("socket", "Gateway connection closed after RPC timeout"));
        socket.close();
      }, 30_000);
      this.pending.set(id, { resume, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
          if (error) fail(error);
        });
      } catch (cause) {
        fail(cause);
      }
      return Effect.sync(() => {
        clearTimeout(timer);
        this.pending.delete(id);
      });
    });
  }

  private disconnect(source: WebSocket, error: HermesGatewayError): void {
    if (this.socket !== source) return;
    this.socket = null;
    this.rejectAll(error);
    for (const queue of this.subscribers.keys()) Queue.failCauseUnsafe(queue, Cause.fail(error));
    this.subscribers.clear();
  }

  private rejectAll(error: HermesGatewayError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resume(Effect.fail(error));
    }
    this.pending.clear();
  }

  private readonly close = Effect.sync(() => {
    this.closed = true;
    const socket = this.socket;
    if (socket) {
      this.disconnect(socket, failure("close", "Gateway connection closed"));
      socket.close();
    }
  });
}

export interface HermesThreadRecord {
  readonly threadId: string;
  readonly requestId: string;
  readonly sessionId: string | null;
  readonly profileId: string;
  readonly instanceId: string;
  readonly principalId: string;
  readonly authorityEpoch: number;
}

/** Project-local durable mapping. The reservation exists before session.create is sent. */
export class HermesSessionStore {
  private readonly db: NodeSqlite.DatabaseSync;

  static stateDirectoryFromEnv(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    return environment.HERMES_STATE_DIR;
  }

  static hasReservedTurn(
    directory: string,
    threadId: string,
    runId: string,
    sessionId: string,
    attemptId: string,
  ) {
    if (!NodePath.isAbsolute(directory)) return false;
    const path = NodePath.join(directory, "sessions.sqlite3");
    if (!NodeFS.existsSync(path)) return false;
    const store = new HermesSessionStore(path, true);
    try {
      const thread = store.get(threadId);
      if (thread?.sessionId !== sessionId) return false;
      const submission = store.getTextTurnSubmission({ ...thread, runId, attemptId });
      return submission !== null;
    } finally {
      store.close();
    }
  }

  constructor(path: string, readOnly = false) {
    if (!readOnly) NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(path, { readOnly });
    if (readOnly) return;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hermes_threads (
        thread_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        session_id TEXT UNIQUE,
        profile_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS hermes_text_turns (
        thread_id TEXT NOT NULL REFERENCES hermes_threads(thread_id),
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        input_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL,
        text_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS hermes_text_turns_session
        ON hermes_text_turns (profile_id, session_id, thread_id);
      CREATE TABLE IF NOT EXISTS hermes_text_receipts (
        input_id TEXT PRIMARY KEY REFERENCES hermes_text_turns(input_id),
        admission_id TEXT NOT NULL UNIQUE,
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_text_interactions (
        input_id TEXT NOT NULL REFERENCES hermes_text_turns(input_id),
        prompt_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('approval', 'clarify')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (input_id, prompt_id)
      );
      CREATE TABLE IF NOT EXISTS hermes_pending_images (
        input_id TEXT PRIMARY KEY REFERENCES hermes_text_turns(input_id),
        session_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        content_base64 TEXT NOT NULL,
        mime TEXT NOT NULL,
        upload_claimed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS hermes_attached_images (
        input_id TEXT PRIMARY KEY REFERENCES hermes_text_turns(input_id),
        attachment_id TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
    `);
  }

  reserve(input: Omit<HermesThreadRecord, "requestId" | "sessionId">): HermesThreadRecord {
    const existing = this.get(input.threadId);
    if (existing) {
      const identityChanged =
        existing.profileId !== input.profileId ||
        existing.instanceId !== input.instanceId ||
        existing.principalId !== input.principalId ||
        existing.authorityEpoch !== input.authorityEpoch;
      if (existing.sessionId === null) {
        const requestId = identityChanged ? `t3-${NodeCrypto.randomUUID()}` : existing.requestId;
        this.db
          .prepare(
            `UPDATE hermes_threads
             SET request_id = ?, profile_id = ?, instance_id = ?, principal_id = ?, authority_epoch = ?
             WHERE thread_id = ? AND session_id IS NULL`,
          )
          .run(
            requestId,
            input.profileId,
            input.instanceId,
            input.principalId,
            input.authorityEpoch,
            input.threadId,
          );
        return { ...existing, ...input, requestId };
      }
      if (identityChanged) {
        throw new Error("Stored Hermes thread identity does not match runtime.describe");
      }
      return existing;
    }
    const requestId = `t3-${NodeCrypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO hermes_threads
          (thread_id, request_id, session_id, profile_id, instance_id, principal_id, authority_epoch)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.threadId,
        requestId,
        input.profileId,
        input.instanceId,
        input.principalId,
        input.authorityEpoch,
      );
    return { ...input, requestId, sessionId: null };
  }

  bind(threadId: string, requestId: string, sessionId: string): HermesThreadRecord {
    const current = this.get(threadId);
    if (!current || current.requestId !== requestId)
      throw new Error("Hermes thread reservation is missing");
    if (current.sessionId !== null && current.sessionId !== sessionId) {
      throw new Error("Hermes thread is already bound to another session");
    }
    this.db
      .prepare("UPDATE hermes_threads SET session_id = ? WHERE thread_id = ?")
      .run(sessionId, threadId);
    return { ...current, sessionId };
  }

  get(threadId: string): HermesThreadRecord | null {
    const row = this.db
      .prepare("SELECT * FROM hermes_threads WHERE thread_id = ?")
      .get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      threadId: String(row.thread_id),
      requestId: String(row.request_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      profileId: String(row.profile_id),
      instanceId: String(row.instance_id),
      principalId: String(row.principal_id),
      authorityEpoch: Number(row.authority_epoch),
    };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /** This returns the exact wire payload; reserving a turn never sends or retries the RPC. */
  reserveTextTurn(
    input: Omit<HermesThreadRecord, "requestId" | "sessionId"> & {
      readonly sessionId: string;
      readonly runId: string;
      readonly attemptId: string;
      readonly text: string;
      readonly image?: Omit<HermesPendingImage, "inputId" | "sessionId" | "uploadClaimed">;
    },
  ): { readonly session_id: string; readonly input_id: string; readonly text: string } {
    const {
      threadId,
      runId,
      attemptId,
      sessionId,
      profileId,
      instanceId,
      principalId,
      authorityEpoch,
      text,
      image,
    } = input;
    const stored = this.get(threadId);
    if (
      stored?.sessionId !== sessionId ||
      stored.profileId !== profileId ||
      stored.instanceId !== instanceId ||
      stored.principalId !== principalId ||
      stored.authorityEpoch !== authorityEpoch
    ) {
      throw new Error("Hermes turn does not match the durable session mapping");
    }

    // Keep the legacy string encoding for text-only turns. Retain the image digest after staging bytes are gone.
    const textJson = JSON.stringify(
      image
        ? [
            text,
            NodeCrypto.createHash("sha256")
              .update(
                JSON.stringify([
                  image.attachmentId,
                  image.filename,
                  image.mime,
                  image.contentBase64,
                ]),
              )
              .digest("hex"),
          ]
        : text,
    );
    return this.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO hermes_text_turns
           (thread_id, run_id, attempt_id, input_id, session_id, profile_id, instance_id, principal_id, authority_epoch, text_json)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM hermes_text_turns prior
             LEFT JOIN hermes_text_receipts receipt ON receipt.input_id = prior.input_id
             WHERE prior.profile_id = ? AND prior.session_id = ?
               AND (prior.thread_id <> ? OR prior.run_id <> ?)
               AND json_extract(receipt.receipt_json, '$.status') IS NOT 'terminal'
           )
           ON CONFLICT (thread_id, run_id) DO NOTHING`,
        )
        .run(
          threadId,
          runId,
          attemptId,
          `t3-${NodeCrypto.randomUUID()}`,
          sessionId,
          profileId,
          instanceId,
          principalId,
          authorityEpoch,
          textJson,
          profileId,
          sessionId,
          threadId,
          runId,
        );

      const row = this.db
        .prepare(
          `SELECT input_id FROM hermes_text_turns
           WHERE thread_id = ? AND run_id = ? AND attempt_id = ? AND session_id = ? AND profile_id = ?
             AND instance_id = ? AND principal_id = ? AND authority_epoch = ? AND text_json = ?`,
        )
        .get(
          threadId,
          runId,
          attemptId,
          sessionId,
          profileId,
          instanceId,
          principalId,
          authorityEpoch,
          textJson,
        );
      if (typeof row?.input_id !== "string") {
        throw new Error(
          "Hermes turn has a different input or identity, or an earlier turn is unresolved",
        );
      }
      if (image && inserted.changes === 1) {
        this.reservePendingImage({ inputId: row.input_id, sessionId, ...image });
      }
      return { session_id: sessionId, input_id: row.input_id, text };
    });
  }

  getTextTurnSubmission(
    input: Omit<HermesThreadRecord, "requestId"> & {
      readonly runId: string;
      readonly attemptId: string;
    },
  ): { readonly session_id: string; readonly input_id: string; readonly text: string } | null {
    const row = this.db
      .prepare(
        `SELECT input_id, session_id, text_json FROM hermes_text_turns
         WHERE thread_id = ? AND run_id = ? AND attempt_id = ? AND session_id = ? AND profile_id = ?
           AND instance_id = ? AND principal_id = ? AND authority_epoch = ?`,
      )
      .get(
        input.threadId,
        input.runId,
        input.attemptId,
        input.sessionId,
        input.profileId,
        input.instanceId,
        input.principalId,
        input.authorityEpoch,
      ) as { input_id: string; session_id: string; text_json: string } | undefined;
    if (!row || typeof row.input_id !== "string") return null;
    const stored: unknown = JSON.parse(row.text_json);
    const text: unknown = Array.isArray(stored) ? stored[0] : stored;
    if (
      Array.isArray(stored) &&
      !this.getAttachedImage(row.input_id) &&
      !this.getPendingImage(row.input_id)
    ) {
      throw new Error("Hermes turn is missing its durable image record");
    }
    return typeof text === "string"
      ? { session_id: row.session_id, input_id: row.input_id, text }
      : null;
  }

  reservePendingImage(input: Omit<HermesPendingImage, "uploadClaimed">): HermesPendingImage {
    const existing = this.getPendingImage(input.inputId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.attachmentId !== input.attachmentId ||
        existing.filename !== input.filename ||
        existing.mime !== input.mime ||
        existing.contentBase64 !== input.contentBase64
      ) {
        throw new Error("Hermes pending image does not match the durable turn");
      }
      return existing;
    }
    this.db
      .prepare(
        `INSERT INTO hermes_pending_images
         (input_id, session_id, attachment_id, filename, content_base64, mime)
         SELECT ?, ?, ?, ?, ?, ? FROM hermes_text_turns
         WHERE input_id = ? AND session_id = ?`,
      )
      .run(
        input.inputId,
        input.sessionId,
        input.attachmentId,
        input.filename,
        input.contentBase64,
        input.mime,
        input.inputId,
        input.sessionId,
      );
    const stored = this.getPendingImage(input.inputId);
    if (!stored) throw new Error("Hermes image does not match the durable session");
    return stored;
  }

  claimPendingImage(inputId: string): void {
    const result = this.db
      .prepare(
        `UPDATE hermes_pending_images
         SET upload_claimed = 1, content_base64 = ''
         WHERE input_id = ? AND upload_claimed = 0 AND content_base64 <> ''`,
      )
      .run(inputId);
    if (result.changes !== 1) {
      throw new Error("Hermes image upload was already claimed or has no durable bytes");
    }
  }

  getPendingImage(inputId: string): HermesPendingImage | null {
    const row = this.db
      .prepare(
        `SELECT input_id, session_id, attachment_id, filename, content_base64, mime, upload_claimed
         FROM hermes_pending_images WHERE input_id = ?`,
      )
      .get(inputId) as Record<string, unknown> | undefined;
    return row
      ? {
          inputId: String(row.input_id),
          sessionId: String(row.session_id),
          attachmentId: String(row.attachment_id),
          filename: String(row.filename),
          contentBase64: String(row.content_base64),
          mime: String(row.mime) as HermesPendingImage["mime"],
          uploadClaimed: Number(row.upload_claimed) === 1,
        }
      : null;
  }

  recordAttachedImage(input: HermesAttachedImage): HermesAttachedImage {
    const pending = this.getPendingImage(input.inputId);
    if (!pending || pending.attachmentId !== input.attachmentId) {
      throw new Error("Hermes attached image has no matching durable payload");
    }
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO hermes_attached_images (input_id, attachment_id, path, mime, bytes)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (input_id) DO NOTHING`,
        )
        .run(input.inputId, input.attachmentId, input.path, input.mime, input.bytes);
      const stored = this.getAttachedImage(input.inputId);
      if (
        !stored ||
        stored.attachmentId !== input.attachmentId ||
        stored.path !== input.path ||
        stored.mime !== input.mime ||
        stored.bytes !== input.bytes
      ) {
        throw new Error("Hermes attached image identity is ambiguous");
      }
      this.db.prepare("DELETE FROM hermes_pending_images WHERE input_id = ?").run(input.inputId);
      return stored;
    });
  }

  getAttachedImage(inputId: string): HermesAttachedImage | null {
    const row = this.db
      .prepare(
        `SELECT input_id, attachment_id, path, mime, bytes
         FROM hermes_attached_images WHERE input_id = ?`,
      )
      .get(inputId) as Record<string, unknown> | undefined;
    return row
      ? {
          inputId: String(row.input_id),
          attachmentId: String(row.attachment_id),
          path: String(row.path),
          mime: String(row.mime) as HermesAttachedImage["mime"],
          bytes: Number(row.bytes),
        }
      : null;
  }

  clearPendingImage(inputId: string): void {
    this.db.prepare("DELETE FROM hermes_pending_images WHERE input_id = ?").run(inputId);
  }

  getUnresolvedTextTurns(input: {
    readonly threadId: string;
    readonly sessionId: string;
    readonly profileId: string;
    readonly principalId: string;
  }): ReadonlyArray<{ readonly inputId: string; readonly receipt: HermesTextTurnReceipt | null }> {
    const rows = this.db
      .prepare(
        `SELECT prior.input_id, receipt.receipt_json FROM hermes_text_turns prior
         LEFT JOIN hermes_text_receipts receipt ON receipt.input_id = prior.input_id
         WHERE prior.thread_id = ? AND prior.session_id = ? AND prior.profile_id = ?
           AND prior.principal_id = ? AND json_extract(receipt.receipt_json, '$.status') IS NOT 'terminal'`,
      )
      .all(input.threadId, input.sessionId, input.profileId, input.principalId) as Array<{
      input_id: string;
      receipt_json: string | null;
    }>;
    return rows.map((row) => ({
      inputId: row.input_id,
      receipt:
        row.receipt_json === null ? null : decodeTextTurnReceipt(JSON.parse(row.receipt_json)),
    }));
  }

  getTextTurnReceipt(inputId: string): typeof TextTurnReceipt.Type | null {
    const row = this.db
      .prepare("SELECT receipt_json FROM hermes_text_receipts WHERE input_id = ?")
      .get(inputId);
    return typeof row?.receipt_json === "string"
      ? decodeTextTurnReceipt(JSON.parse(row.receipt_json))
      : null;
  }

  /** Same-authority journal only. Call with a receipt from the verified, pinned connection. */
  recordTextTurnReceipt(inputId: string, raw: unknown): typeof TextTurnReceipt.Type {
    const receipt = decodeTextTurnReceipt(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.db
        .prepare(
          "SELECT session_id, profile_id, authority_epoch FROM hermes_text_turns WHERE input_id = ?",
        )
        .get(inputId);
      if (
        !turn ||
        turn.session_id !== receipt.ref.session_id ||
        turn.profile_id !== receipt.ref.profile_id ||
        turn.authority_epoch !== receipt.authority_epoch ||
        receipt.sequence < 0 ||
        (receipt.execution_generation === null
          ? receipt.status === "started" || receipt.status === "unknown"
          : receipt.execution_generation < 1)
      ) {
        throw new Error("Hermes receipt does not match the journaled turn identity");
      }

      const previous = this.getTextTurnReceipt(inputId);
      if (
        previous &&
        (previous.admission_id !== receipt.admission_id ||
          previous.sequence !== receipt.sequence ||
          (previous.execution_generation !== null &&
            previous.execution_generation !== receipt.execution_generation) ||
          (previous.status === "terminal" &&
            (receipt.status !== "terminal" ||
              previous.execution_generation !== receipt.execution_generation ||
              previous.outcome !== receipt.outcome)))
      ) {
        throw new Error("Hermes receipt conflicts with the journaled admission");
      }

      this.db
        .prepare(
          `INSERT INTO hermes_text_receipts (input_id, admission_id, receipt_json)
           VALUES (?, ?, ?) ON CONFLICT (input_id) DO UPDATE SET receipt_json = excluded.receipt_json`,
        )
        .run(inputId, receipt.admission_id, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Atomically journal restart settlement before permitting work on the later authority. */
  migrateTextTurnAuthority(
    input: {
      readonly threadId: string;
      readonly inputId: string;
      readonly profileId: string;
      readonly principalId: string;
      readonly instanceId: string;
      readonly authorityEpoch: number;
    },
    raw: unknown,
  ): typeof TextTurnReceipt.Type {
    const receipt = decodeTextTurnReceipt(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.db
        .prepare(
          `SELECT thread_id, session_id, profile_id, instance_id, principal_id, authority_epoch
           FROM hermes_text_turns WHERE input_id = ?`,
        )
        .get(input.inputId);
      const previous = this.getTextTurnReceipt(input.inputId);
      if (
        !turn ||
        turn.thread_id !== input.threadId ||
        turn.profile_id !== input.profileId ||
        turn.principal_id !== input.principalId ||
        !previous ||
        previous.status !== "started" ||
        previous.ref.session_id !== turn.session_id ||
        previous.ref.profile_id !== turn.profile_id ||
        previous.execution_generation === null ||
        previous.authority_epoch !== turn.authority_epoch ||
        input.authorityEpoch <= previous.authority_epoch ||
        typeof turn.instance_id !== "string" ||
        input.instanceId === turn.instance_id ||
        receipt.status !== "terminal" ||
        !receipt.outcome ||
        receipt.ref.session_id !== previous.ref.session_id ||
        receipt.ref.profile_id !== previous.ref.profile_id ||
        receipt.authority_epoch !== previous.authority_epoch ||
        receipt.admission_id !== previous.admission_id ||
        receipt.execution_generation !== previous.execution_generation ||
        receipt.sequence !== previous.sequence
      ) {
        throw new Error("Hermes restart settlement does not match the exact journaled admission");
      }
      const migrated = this.db
        .prepare(
          `UPDATE hermes_threads SET instance_id = ?, authority_epoch = ?
           WHERE thread_id = ? AND session_id = ? AND profile_id = ? AND principal_id = ?
             AND instance_id = ? AND authority_epoch = ?`,
        )
        .run(
          input.instanceId,
          input.authorityEpoch,
          input.threadId,
          turn.session_id,
          input.profileId,
          input.principalId,
          turn.instance_id,
          previous.authority_epoch,
        );
      if (migrated.changes !== 1)
        throw new Error("Hermes thread identity changed during migration");
      this.db
        .prepare(
          `INSERT INTO hermes_text_receipts (input_id, admission_id, receipt_json)
           VALUES (?, ?, ?) ON CONFLICT (input_id) DO UPDATE SET receipt_json = excluded.receipt_json`,
        )
        .run(input.inputId, receipt.admission_id, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Prompt identity only. Questions, commands, decisions and answers are never journaled. */
  recordTextTurnInteraction(
    inputId: string,
    admissionId: string,
    raw: unknown,
  ): { readonly promptId: string; readonly kind: "approval" | "clarify"; readonly state: string } {
    const kind = recordField(raw, "kind");
    const promptId = stringField(raw, "prompt_id");
    const generation = integerField(raw, "execution_generation");
    if ((kind !== "approval" && kind !== "clarify") || !promptId || generation === undefined) {
      throw new Error("Hermes prompt has no valid identity");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.getTextTurnReceipt(inputId);
      if (
        !receipt ||
        receipt.status !== "started" ||
        receipt.admission_id !== admissionId ||
        receipt.execution_generation !== generation
      ) {
        throw new Error("Hermes prompt does not match the started durable admission");
      }
      this.db
        .prepare(
          `INSERT INTO hermes_text_interactions (input_id, prompt_id, kind, state)
           VALUES (?, ?, ?, 'pending')
           ON CONFLICT (input_id, prompt_id) DO UPDATE SET prompt_id = excluded.prompt_id
           WHERE hermes_text_interactions.kind = excluded.kind
             AND hermes_text_interactions.state = 'pending'`,
        )
        .run(inputId, promptId, kind);
      const row = this.db
        .prepare(
          "SELECT prompt_id, kind, state FROM hermes_text_interactions WHERE input_id = ? AND prompt_id = ?",
        )
        .get(inputId, promptId);
      if (!row || row.kind !== kind)
        throw new Error("Hermes prompt conflicts with durable identity");
      this.db.exec("COMMIT");
      return { promptId, kind, state: String(row.state) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  settleTextTurnInteraction(
    inputId: string,
    promptId: string,
    state: "resolved" | "expired",
  ): "resolved" | "expired" {
    const result = this.db
      .prepare(
        `UPDATE hermes_text_interactions SET state = ?
         WHERE input_id = ? AND prompt_id = ? AND state = 'pending'`,
      )
      .run(state, inputId, promptId);
    if (result.changes === 1) return state;
    // A caller can retry after the commit succeeded but it saw an error.
    const row = this.db
      .prepare("SELECT state FROM hermes_text_interactions WHERE input_id = ? AND prompt_id = ?")
      .get(inputId, promptId);
    if (row?.state === "resolved") return "resolved";
    if (row?.state === "expired" && state === "expired") return "expired";
    throw new Error("Hermes prompt settlement is missing or contradicts durable state");
  }

  close(): void {
    this.db.close();
  }
}
