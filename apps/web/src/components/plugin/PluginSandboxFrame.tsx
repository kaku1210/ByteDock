// @effect-diagnostics cryptoRandomUUID:off -- Browser sandbox iframe mints per-mount session nonce synchronously at layout commit.
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  isValidSandboxEnvelope,
  type SandboxEnvelope,
  type SandboxMessageType,
} from "@bytedock/plugin-ui-renderer/sandboxBridge";

export interface PluginSandboxFrameProps {
  readonly pluginId: string;
  readonly title: string;
  readonly html: string;
  readonly allowPopups?: boolean | undefined;
  readonly initialPayload?: unknown;
  readonly onMessage?: ((envelope: SandboxEnvelope) => void) | undefined;
  readonly className?: string | undefined;
}

export interface SandboxValidationResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly envelope?: SandboxEnvelope | undefined;
}

/**
 * Pure 4-condition ADR-08 postMessage validator: verifies opaque origin "null",
 * exact iframe source window, active per-mount nonce, and closed message type enum.
 */
export function validateSandboxMessageEvent(input: {
  readonly origin: string;
  readonly source: unknown;
  readonly expectedSource: unknown;
  readonly data: unknown;
  readonly activeNonce: string | null;
}): SandboxValidationResult {
  if (input.activeNonce === null) {
    return { accepted: false, reason: "nonce-invalidated-after-unmount" };
  }
  if (input.origin !== "null") {
    return { accepted: false, reason: `unexpected-origin:${input.origin}` };
  }
  if (!input.expectedSource || input.source !== input.expectedSource) {
    return { accepted: false, reason: "source-window-mismatch" };
  }
  if (!isValidSandboxEnvelope(input.data, input.activeNonce)) {
    return { accepted: false, reason: "invalid-envelope-or-nonce" };
  }
  return {
    accepted: true,
    reason: "verified",
    envelope: input.data,
  };
}

/**
 * Pending-queue bootstrap script injected into Track-2 srcDoc frames.
 * Queues all outbound messages until host injects the session nonce via postMessage("init"),
 * ensuring zero dropped first packets and zero nonce leakage into URL/Referer.
 */
function createSandboxBridgeBootstrapScript(): string {
  return [
    "<script>",
    "(function(){",
    "  var nonce = null;",
    "  var pending = [];",
    "  function flush(){",
    "    if(!nonce) return;",
    "    while(pending.length > 0){",
    "      var msg = pending.shift();",
    "      window.parent.postMessage({ type: msg.type, nonce: nonce, requestId: msg.requestId, payload: msg.payload }, '*');",
    "    }",
    "  }",
    "  window.ByteDockSandbox = {",
    "    postHostMessage: function(type, payload, requestId){",
    "      pending.push({ type: type, payload: payload, requestId: requestId });",
    "      flush();",
    "    }",
    "  };",
    "  window.addEventListener('message', function(ev){",
    "    if(!ev.data || ev.data.type !== 'init' || typeof ev.data.nonce !== 'string') return;",
    "    nonce = ev.data.nonce;",
    "    if(typeof window.onHostInit === 'function'){ window.onHostInit(ev.data.payload); }",
    "    window.ByteDockSandbox.postHostMessage('ready', { ok: true });",
    "    flush();",
    "  });",
    "})();",
    "</script>",
  ].join("");
}

export function buildSandboxedPluginSrcDoc(innerHtml: string): string {
  const bootstrap = createSandboxBridgeBootstrapScript();
  if (innerHtml.includes("</head>")) {
    return innerHtml.replace("</head>", `${bootstrap}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8" />${bootstrap}</head><body>${innerHtml}</body></html>`;
}

/**
 * Track-2 sandboxed plugin iframe (Blueprint §6.2 / ADR-08):
 * - Strict sandbox="allow-scripts" (allow-forms and allow-same-origin are forbidden)
 * - Outbound postMessage targets opaque origin "null"
 * - Listener attaches in useLayoutEffect so no early frame message races passive effects
 */
export function PluginSandboxFrame({
  pluginId,
  title,
  html,
  allowPopups = false,
  initialPayload,
  onMessage,
  className,
}: PluginSandboxFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const handleEnvelope = useEffectEvent((envelope: SandboxEnvelope) => {
    onMessage?.(envelope);
  });
  const [frameHeight, setFrameHeight] = useState(320);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attaches window postMessage listener at layout commit so early iframe messages never race passive effects.
  useLayoutEffect(() => {
    const issued = crypto.randomUUID();
    nonceRef.current = issued;

    const handleWindowMessage = (event: MessageEvent) => {
      const verdict = validateSandboxMessageEvent({
        origin: event.origin,
        source: event.source,
        expectedSource: iframeRef.current?.contentWindow ?? null,
        data: event.data,
        activeNonce: nonceRef.current,
      });
      if (!verdict.accepted || !verdict.envelope) return;

      if (
        verdict.envelope.type === "height.report" &&
        typeof verdict.envelope.payload === "object" &&
        verdict.envelope.payload !== null &&
        "height" in verdict.envelope.payload
      ) {
        const nextHeight = Number((verdict.envelope.payload as { height: unknown }).height);
        if (Number.isFinite(nextHeight) && nextHeight >= 80 && nextHeight <= 4_000) {
          setFrameHeight(nextHeight);
        }
      }
      handleEnvelope(verdict.envelope);
    };

    window.addEventListener("message", handleWindowMessage);
    return () => {
      // Unmount invalidates nonce immediately so replayed frames are always rejected.
      nonceRef.current = null;
      window.removeEventListener("message", handleWindowMessage);
    };
  }, []);

  const handleLoad = () => {
    const frameWindow = iframeRef.current?.contentWindow;
    const nonce = nonceRef.current;
    if (!frameWindow || !nonce) return;
    const initEnvelope: {
      readonly type: SandboxMessageType;
      readonly nonce: string;
      readonly payload?: unknown;
    } = {
      type: "init",
      nonce,
      payload: initialPayload ?? { pluginId },
    };
    // Opaque sandboxed iframe has origin "null" (HTML spec rejects literal targetOrigin "null");
    // transfer a private MessagePort so only this mounted frame receives the channel.
    const channel = new MessageChannel();
    frameWindow.postMessage(initEnvelope, "*", [channel.port2]);
  };

  const sandboxTokens = allowPopups
    ? "allow-scripts allow-popups-to-escape-sandbox"
    : "allow-scripts";

  return (
    <iframe
      ref={iframeRef}
      title={title}
      data-bytedock-sandbox-plugin={pluginId}
      sandbox={sandboxTokens}
      srcDoc={buildSandboxedPluginSrcDoc(html)}
      onLoad={handleLoad}
      style={{ height: `${frameHeight}px` }}
      className={className ?? "w-full rounded-md border border-border bg-background"}
    />
  );
}
