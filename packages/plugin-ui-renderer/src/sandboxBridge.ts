/**
 * Track-2 sandbox-iframe postMessage bridge protocol (ADR-08):
 * - iframe uses sandbox="allow-scripts" (allow-forms and allow-same-origin are forbidden)
 * - host responds with targetOrigin "null"
 * - 4-condition validation: origin === "null" && source === frameWindow && nonce === issued && closed message type
 */
export const SANDBOX_MESSAGE_TYPES = [
  "init",
  "ready",
  "rpc.invoke",
  "rpc.result",
  "theme.sync",
  "height.report",
] as const;

export type SandboxMessageType = (typeof SANDBOX_MESSAGE_TYPES)[number];

export interface SandboxEnvelope {
  readonly type: SandboxMessageType;
  readonly nonce: string;
  readonly requestId?: string | undefined;
  readonly payload?: unknown;
}

export function isValidSandboxEnvelope(
  data: unknown,
  expectedNonce: string,
): data is SandboxEnvelope {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    (SANDBOX_MESSAGE_TYPES as ReadonlyArray<string>).includes(candidate.type) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce === expectedNonce
  );
}
