import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client requires a newer server. Update T3 Code on ${descriptor.label} to connect.`,
        ...(canSelfUpdate(descriptor) ? { serverUpdateRequired: true } : {}),
      });
}

function canSelfUpdate(descriptor: ExecutionEnvironmentDescriptor): boolean {
  const { serverSelfUpdate, desktopAppUpdate } = descriptor.capabilities;
  return (
    serverSelfUpdate !== undefined &&
    (serverSelfUpdate !== "desktop-managed" || desktopAppUpdate === true)
  );
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

/**
 * Rewrites a prepared /ws socket URL into the POST /rpc HTTP fallback
 * endpoint: same host, same query params (auth ticket, client metadata,
 * orchestration protocol), new scheme and path. Used only when the client
 * selects the HTTP transport (Android Prisma never completes a WebSocket
 * upgrade but streams HTTPS responses fine).
 */
export function httpRpcUrlFromSocketUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    // Fail loudly rather than silently downgrading (or upgrading) an
    // unexpected scheme — the input contract is a prepared socket URL.
    throw new Error(`Not a socket URL: ${socketUrl}`);
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/rpc";
  } else {
    url.pathname = url.pathname.replace(/\/ws$/, "/rpc");
  }
  return url.toString();
}
