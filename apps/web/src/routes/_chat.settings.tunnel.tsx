import { createFileRoute } from "@tanstack/react-router";
import { ExternalTunnelSettings } from "../components/settings/ExternalTunnelSettings";

export const Route = createFileRoute("/_chat/settings/tunnel")({
  component: ExternalTunnelSettings,
});
