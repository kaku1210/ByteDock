import { AuthAccessReadScope } from "@t3tools/contracts";
import { AlertTriangleIcon, RefreshCwIcon, Settings2Icon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useGT, useMessages } from "gt-react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/**
 * Persistent, non-auto-dismissing global banner surfaced whenever the managed
 * external tunnel reports a failure (e.g. VPS hy2 password/port mismatch,
 * unexpected exit, AV block, or failed health probe).
 */
export function ExternalTunnelAlertBanner() {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const [busyAction, setBusyAction] = useState<"restart" | "ack" | null>(null);
  const runTunnelAction = useAtomCommand(serverEnvironment.externalTunnelAction, {
    reportFailure: false,
  });

  const query = useEnvironmentQuery(
    environmentId === null || !canReadAccess
      ? null
      : serverEnvironment.externalTunnelStatus({ environmentId, input: {} }),
    resolve,
  );

  const alert = query.data?.alert ?? null;
  if (environmentId === null || alert === null || alert.acknowledgedAt !== null) {
    return null;
  }

  const handleRestart = async () => {
    setBusyAction("restart");
    try {
      await runTunnelAction({ environmentId, input: { action: "restart" } });
    } catch {
      // Updated status / error stays visible in the banner and Settings -> Tunnel.
    } finally {
      setBusyAction(null);
    }
  };

  const handleAcknowledge = async () => {
    setBusyAction("ack");
    try {
      await runTunnelAction({ environmentId, input: { action: "acknowledgeAlert" } });
    } catch {
      // Ignore transient errors; banner stays visible until acknowledged.
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-3 z-100 flex justify-center px-4"
    >
      <div className="pointer-events-auto w-full max-w-2xl shadow-lg [-webkit-app-region:no-drag]">
        <Alert variant="error" surface="glass" controlAlignment="first-line">
          <AlertTriangleIcon aria-hidden className="size-4 shrink-0" />
          <AlertTitle>{alert.title}</AlertTitle>
          <AlertDescription>
            <div className="space-y-1 text-xs leading-relaxed">
              {alert.detail ? (
                <p className="font-mono break-all opacity-90">{alert.detail}</p>
              ) : null}
              <p>{alert.hint}</p>
            </div>
          </AlertDescription>
          <AlertAction>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void handleRestart()}
              >
                <RefreshCwIcon aria-hidden className="size-3.5" />
                {gt("Restart")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/tunnel" })}
              >
                <Settings2Icon aria-hidden className="size-3.5" />
                {gt("Tunnel settings")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busyAction !== null}
                aria-label={gt("Acknowledge alert")}
                onClick={() => void handleAcknowledge()}
              >
                <XIcon aria-hidden className="size-3.5" />
                {gt("Acknowledge")}
              </Button>
            </div>
          </AlertAction>
        </Alert>
      </div>
    </div>
  );
}
