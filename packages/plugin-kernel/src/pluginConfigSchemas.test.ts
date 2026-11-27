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
    });
    expect(validOpt.ok).toBe(true);
    if (validOpt.ok) {
      expect(validOpt.config.cacheGuardActive).toBe(false);
      expect(validOpt.config.steadyStateTargetPct).toBe(85);
    }

    const badOpt = validatePluginConfig("builtin.token-optimizer", {
      steadyStateTargetPct: 120,
    });
    expect(badOpt.ok).toBe(false);

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
