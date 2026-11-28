import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_DENIED_DOMAINS } from "./egressGuard.ts";
import {
  assessConfigPatchPrivilege,
  buildEffectiveEgressPolicy,
  computePluginPermissionsFingerprint,
  findPlaintextSecretViolation,
  validatePluginConfig,
} from "./pluginConfigSchemas.ts";

describe("pluginConfigSchemas", () => {
  it("validates normal builtin plugin config updates and rejects out-of-range fields", () => {
    const validOpt = validatePluginConfig("builtin.token-optimizer", {
      cacheGuardActive: false,
      steadyStateTargetPct: 85,
      watchdogWarnAfterSec: 30,
      watchdogCriticalAfterSec: 90,
    });
    expect(validOpt.ok).toBe(true);
    if (validOpt.ok) {
      expect(validOpt.config.cacheGuardActive).toBe(false);
      expect(validOpt.config.steadyStateTargetPct).toBe(85);
      expect(validOpt.config.showStatusBarMetrics).toBe(true);
      expect(validOpt.config.watchdogEnabled).toBe(true);
      expect(validOpt.config.watchdogWarnAfterSec).toBe(30);
      expect(validOpt.config.watchdogCriticalAfterSec).toBe(90);
    }

    const badOpt = validatePluginConfig("builtin.token-optimizer", {
      steadyStateTargetPct: 120,
    });
    expect(badOpt.ok).toBe(false);

    const badWatchdogOrder = validatePluginConfig("builtin.token-optimizer", {
      watchdogWarnAfterSec: 120,
      watchdogCriticalAfterSec: 60,
    });
    expect(badWatchdogOrder.ok).toBe(false);

    const badNapcat = validatePluginConfig("community.napcat-qq", {
      rateLimitPerMin: 0,
    });
    expect(badNapcat.ok).toBe(false);

    const unknownField = validatePluginConfig("builtin.bots-core", {
      unknownSetting: true,
    });
    expect(unknownField.ok).toBe(false);
  });

  it("blocks plaintext secret keys and token-like values without echoing the secret", () => {
    const rawSecret = "sk-supersecretkey1234567890";
    const keyViolation = findPlaintextSecretViolation({ apiKey: "my-plain-secret" });
    expect(keyViolation).toBeDefined();
    expect(keyViolation).not.toContain("my-plain-secret");

    const valueViolation = validatePluginConfig("local.custom", { note: rawSecret });
    expect(valueViolation.ok).toBe(false);
    if (!valueViolation.ok) {
      expect(valueViolation.message).not.toContain(rawSecret);
    }

    const safeRef = validatePluginConfig("local.custom", {
      apiKey: "secret-ref:0123456789abcdef0123456789abcdef",
      tokenBudget: 8000,
    });
    expect(safeRef.ok).toBe(true);
  });

  it("preserves DEFAULT_DENIED_DOMAINS baseline even when deniedDomains is partially supplied", () => {
    const effective = buildEffectiveEgressPolicy({
      mode: "strict",
      allowedHosts: ["api.openai.com"],
      deniedDomains: ["evil.example.com"],
    });
    for (const domain of DEFAULT_DENIED_DOMAINS) {
      expect(effective.deniedDomains).toContain(domain);
    }
    expect(effective.deniedDomains).toContain("evil.example.com");
  });

  it("classifies firewall relaxations and sensitive permission expansions as high risk", () => {
    const modeRelax = assessConfigPatchPrivilege({
      pluginId: "builtin.egress-guard",
      prevConfig: { mode: "strict", allowedHosts: ["api.openai.com"] },
      nextConfig: { mode: "audit-only", allowedHosts: ["api.openai.com"] },
    });
    expect(modeRelax.requiresApproval).toBe(true);
    expect(modeRelax.riskLevel).toBe("high");

    const hostExpand = assessConfigPatchPrivilege({
      pluginId: "builtin.egress-guard",
      prevConfig: { mode: "strict", allowedHosts: ["api.openai.com"] },
      nextConfig: { mode: "strict", allowedHosts: ["api.openai.com", "api.example.com"] },
    });
    expect(hostExpand.requiresApproval).toBe(true);

    const napcatRate = assessConfigPatchPrivilege({
      pluginId: "community.napcat-qq",
      prevConfig: { rateLimitPerMin: 50, allowedHosts: ["127.0.0.1", "localhost"] },
      nextConfig: { rateLimitPerMin: 80, allowedHosts: ["127.0.0.1", "localhost"] },
    });
    expect(napcatRate.requiresApproval).toBe(false);

    const napcatHostExpand = assessConfigPatchPrivilege({
      pluginId: "community.napcat-qq",
      prevConfig: { rateLimitPerMin: 50, allowedHosts: ["127.0.0.1", "localhost"] },
      nextConfig: {
        rateLimitPerMin: 50,
        allowedHosts: ["127.0.0.1", "localhost", "10.0.0.5"],
      },
    });
    expect(napcatHostExpand.requiresApproval).toBe(true);

    const napcatAllowlistChange = assessConfigPatchPrivilege({
      pluginId: "community.napcat-qq",
      prevConfig: {
        oneBotBaseUrl: "http://127.0.0.1:3000",
        allowedUserIds: ["10001"],
        requireAtInGroup: true,
      },
      nextConfig: {
        oneBotBaseUrl: "http://127.0.0.1:3000",
        allowedUserIds: ["10001", "20002"],
        requireAtInGroup: true,
      },
    });
    expect(napcatAllowlistChange.requiresApproval).toBe(true);

    const napcatBaseUrlChange = assessConfigPatchPrivilege({
      pluginId: "community.napcat-qq",
      prevConfig: { oneBotBaseUrl: "http://127.0.0.1:3000" },
      nextConfig: { oneBotBaseUrl: "http://127.0.0.1:9999" },
    });
    expect(napcatBaseUrlChange.requiresApproval).toBe(true);

    const botsDisableSoul = assessConfigPatchPrivilege({
      pluginId: "builtin.bots-core",
      prevConfig: { soulPrefixGuard: true },
      nextConfig: { soulPrefixGuard: false },
    });
    expect(botsDisableSoul.requiresApproval).toBe(true);
  });

  it("validates NapCatQQ loopback URLs, namespace secretRefs, webhook routes, and legacy defaults", () => {
    const legacyMerged = validatePluginConfig("community.napcat-qq", {
      rateLimitPerMin: 60,
    });
    expect(legacyMerged.ok).toBe(true);
    if (legacyMerged.ok) {
      expect(legacyMerged.config.oneBotBaseUrl).toBe("http://127.0.0.1:3000");
      expect(legacyMerged.config.webhookAuthMode).toBe("onebot-hmac");
      expect(legacyMerged.config.tokenSecretRef).toBe("bytedock.napcat.webhook_token");
      expect(legacyMerged.config.allowedUserIds).toEqual([]);
      expect(legacyMerged.config.allowedHosts).toContain("::1");
    }

    const ipv6Valid = validatePluginConfig("community.napcat-qq", {
      oneBotBaseUrl: "http://[::1]:3000/",
      allowedUserIds: ["10001"],
      allowedGroupIds: ["90001"],
    });
    expect(ipv6Valid.ok).toBe(true);
    if (ipv6Valid.ok) {
      expect(ipv6Valid.config.oneBotBaseUrl).toBe("http://[::1]:3000");
    }

    expect(
      validatePluginConfig("community.napcat-qq", {
        oneBotBaseUrl: "https://evil.example/onebot",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        oneBotBaseUrl: "http://user:pass@127.0.0.1:3000",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        tokenSecretRef: "bytedock.other.token",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        tokenSecretRef: "bytedock.napcat.prod.token",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        webhookRoute: "/api/plugins/other/event",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        webhookRoute: "/api/plugins/community.napcat-qq/health",
      }).ok,
    ).toBe(false);
    expect(
      validatePluginConfig("community.napcat-qq", {
        allowedUserIds: ["not-a-qq-id"],
      }).ok,
    ).toBe(false);
  });

  it("produces deterministic permission fingerprints that change on permission escalation", () => {
    const fp1 = computePluginPermissionsFingerprint({
      id: "local.demo",
      name: "Demo",
      version: "0.1.0",
      apiVersion: "0.1",
      execution: "trusted-worker",
      trust: "local-dev",
      permissions: { networkHosts: ["127.0.0.1"], storage: "kv" },
    });
    const fp2 = computePluginPermissionsFingerprint({
      id: "local.demo",
      name: "Demo Renamed",
      version: "0.1.1",
      apiVersion: "0.1",
      execution: "trusted-worker",
      trust: "local-dev",
      permissions: { networkHosts: ["127.0.0.1"], storage: "kv" },
    });
    const fp3 = computePluginPermissionsFingerprint({
      id: "local.demo",
      name: "Demo",
      version: "0.1.1",
      apiVersion: "0.1",
      execution: "trusted-worker",
      trust: "local-dev",
      permissions: { networkHosts: ["127.0.0.1", "api.example.com"], storage: "kv" },
    });
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });
});
