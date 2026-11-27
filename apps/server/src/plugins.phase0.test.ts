import { assert, describe, it } from "@effect/vitest";
import * as PluginKernel from "@bytedock/plugin-kernel";
import { WS_METHODS } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { RPC_REQUIRED_SCOPES } from "./auth/RpcAuthorization.ts";
import {
  layerPluginNotificationHub,
  PluginNotificationHub,
} from "./orchestration-v2/EffectWorker.ts";
import { migrationManifest, runMigrations } from "./persistence/Migrations.ts";
import { registerPluginScheduledJob } from "./scheduledTasks/ScheduledTaskService.ts";
import { Scheduler } from "./scheduling/Scheduler.ts";
import { assertPluginSecretRefAllowed } from "./secrets/SecretResolver.ts";

describe("ByteDock Phase 0 server seam integration", () => {
  it.effect(
    "keeps Migration #124 (PluginKv) as the final migration and enforces SQLite 64KB CHECK constraint",
    () =>
      Effect.gen(function* () {
        const last = migrationManifest.at(-1);
        assert.deepStrictEqual(last, [124, "PluginKv"]);

        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO plugin_kv (plugin_id, ns, key, json_value, expires_at)
          VALUES ('builtin.egress-guard', 'state', 'cfg', '{"ok":true}', NULL)
        `;
        const rows = yield* sql<{ readonly json_value: string }>`
          SELECT json_value FROM plugin_kv WHERE plugin_id = 'builtin.egress-guard'
        `;
        assert.strictEqual(rows[0]?.json_value, '{"ok":true}');

        const oversized = "x".repeat(65_537);
        const failExit = yield* Effect.exit(
          sql`
            INSERT INTO plugin_kv (plugin_id, ns, key, json_value, expires_at)
            VALUES ('builtin.egress-guard', 'state', 'too_big', ${oversized}, NULL)
          `,
        );
        assert.isTrue(Exit.isFailure(failExit));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "wires RPC scopes, PluginKernelLive, SecretNamespaceBroker, NotificationHub, and Schedule bridge",
    () =>
      Effect.gen(function* () {
        assert.isDefined(RPC_REQUIRED_SCOPES[WS_METHODS.pluginsList]);
        assert.isDefined(RPC_REQUIRED_SCOPES[WS_METHODS.pluginsReload]);
        assert.isDefined(RPC_REQUIRED_SCOPES[WS_METHODS.pluginsInvoke]);
        assert.isDefined(RPC_REQUIRED_SCOPES[WS_METHODS.pluginsSubscribe]);

        const kernel = yield* PluginKernel.PluginKernel;
        const active = yield* kernel.revisions.active();
        assert.strictEqual(active.rev, 1);

        const secretOk = yield* assertPluginSecretRefAllowed({
          pluginId: "channel.napcat-qq",
          declaredNamespaces: ["napcat"],
          secretRef: "napcat.webhook_token",
        });
        assert.deepStrictEqual(secretOk, { namespace: "napcat", key: "webhook_token" });

        const secretDenied = yield* Effect.exit(
          assertPluginSecretRefAllowed({
            pluginId: "channel.napcat-qq",
            declaredNamespaces: ["napcat"],
            secretRef: "github.pat_token",
          }),
        );
        assert.isTrue(Exit.isFailure(secretDenied));

        const hub = yield* PluginNotificationHub;
        yield* hub.enqueue({
          pluginId: "builtin.egress-guard",
          notificationId: "n-1",
          severity: "warning",
          title: "Blocked telemetry",
          body: "Denied outbound connection to us.i.posthog.com",
        });
        const drained = yield* hub.drainPending();
        assert.strictEqual(drained.length, 1);

        let unregistered = false;
        const revScope = yield* Scope.make();
        const key = yield* registerPluginScheduledJob(
          {
            pluginId: "builtin.upstream-radar",
            jobId: "daily-scan",
            run: Effect.void,
          },
          revScope,
        ).pipe(
          Effect.provideService(Scheduler, {
            register: (_name, _work) =>
              Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  unregistered = true;
                }),
              ),
          }),
        );
        assert.strictEqual(key, "plugin:builtin.upstream-radar:daily-scan");
        assert.isFalse(unregistered);
        yield* Scope.close(revScope, Exit.void);
        assert.isTrue(unregistered);
      }).pipe(
        Effect.provide(Layer.merge(PluginKernel.PluginKernelLive, layerPluginNotificationHub)),
      ),
  );
});
