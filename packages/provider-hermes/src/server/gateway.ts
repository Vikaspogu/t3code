// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off globalFetch:off globalTimers:off globalTimersInEffect:off processEnvInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

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

const isHermesGatewayError = Schema.is(HermesGatewayError);

const failure = (operation: string, cause: unknown) =>
  isHermesGatewayError(cause)
    ? cause
    : new HermesGatewayError({
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        ...(cause === undefined ? {} : { cause }),
      });

type Pending = {
  readonly resume: (effect: Effect.Effect<unknown, HermesGatewayError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** One scoped canonical listener with single-flight reconnects. */
export class HermesGateway {
  private readonly pending = new Map<string, Pending>();
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

  static connect(endpoint: string, token: string, origin: string) {
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
            process.env.HERMES_ALLOW_CLEARTEXT !== "1"
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
          throw new Error(`Hermes ticket exchange returned HTTP ${response.status}`);
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
        if (this.socket !== socket) return;
        this.socket = null;
        this.rejectAll(failure("socket", "Gateway connection closed"));
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
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (message.id == null) {
        if (message.error) {
          const error = failure(
            "rpc",
            message.error.message ?? "Uncorrelated Hermes JSON-RPC error",
          );
          this.rejectAll(error);
          this.socket?.close();
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
                "rpc",
                `${message.error.message ?? "Hermes JSON-RPC error"} (code ${message.error.code ?? "unknown"})`,
              ),
            )
          : Effect.succeed(message.result),
      );
    } catch (cause) {
      this.rejectAll(failure("decode", cause));
      this.socket?.close();
    }
  }

  request(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, HermesGatewayError> {
    return this.rpcLock.withPermits(1)(this.requestUnlocked(method, params));
  }

  private requestUnlocked(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, HermesGatewayError> {
    return Effect.tryPromise({
      try: () => this.ensureOpen(),
      catch: (cause) => failure(method, cause),
    }).pipe(
      Effect.andThen(
        Effect.callback<unknown, HermesGatewayError>((resume) => {
          const socket = this.socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            resume(Effect.fail(failure(method, "Gateway connection is not open")));
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
            this.rejectAll(failure("socket", "Gateway connection closed after RPC timeout"));
            if (this.socket === socket) {
              this.socket = null;
              socket.close();
            }
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
        }),
      ),
    );
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
    this.rejectAll(failure("close", "Gateway connection closed"));
    this.socket?.close();
    this.socket = null;
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

  constructor(path: string) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(path);
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

  close(): void {
    this.db.close();
  }
}
