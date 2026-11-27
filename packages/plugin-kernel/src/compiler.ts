// @effect-diagnostics nodeBuiltinImport:off -- Build-time/dev-time plugin compiler uses esbuild and node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as esbuild from "esbuild";

import type { CompiledPluginArtifact, HostModuleRegistryService } from "./hostModules.ts";

export class PluginCompileError extends Schema.TaggedError<PluginCompileError>()(
  "PluginCompileError",
  {
    pluginId: Schema.String,
    file: Schema.String,
    line: Schema.Number,
    column: Schema.Number,
    message: Schema.String,
    reason: Schema.Literals(["SubpathNotWhitelisted", "Syntax", "BoundaryViolation"]),
  },
) {}

export class EsmTlaRejectedError extends Schema.TaggedError<EsmTlaRejectedError>()(
  "EsmTlaRejectedError",
  {
    pluginId: Schema.String,
    dependency: Schema.String,
  },
) {}

export interface CompilePluginSourceInput {
  readonly pluginId: string;
  readonly rev: number;
  readonly entryPath: string;
  /** Optional in-memory source override for single-file tests and dev probes. */
  readonly inlineSource?: string | undefined;
  readonly allowScopedFs?: boolean | undefined;
  readonly registry: HostModuleRegistryService;
}

/**
 * Compiles a plugin server entry into a single CJS bundle with inline sourcemap.
 * Enforces the HostModuleRegistry subpath whitelist and node:* allowlist at compile time.
 */
export const compilePluginServer = Effect.fn("pluginKernel.compilePluginServer")(function* (
  input: CompilePluginSourceInput,
) {
  const { registry, pluginId, rev, entryPath, inlineSource, allowScopedFs } = input;
  let whitelistViolation:
    | {
        readonly subpath: string;
        readonly file: string;
        readonly line: number;
        readonly column: number;
      }
    | undefined;

  const whitelistPlugin: esbuild.Plugin = {
    name: "bytedock-host-module-whitelist",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        // Relative imports stay bundled inside the single-file CJS artifact.
        if (args.path.startsWith(".") || NodePath.isAbsolute(args.path)) {
          return undefined;
        }
        const isEffect = args.path === "effect" || args.path.startsWith("effect/");
        const isSdk =
          args.path === "@bytedock/plugin-sdk" ||
          args.path.startsWith("@bytedock/plugin-sdk/") ||
          args.path.startsWith("@bytedock/plugin-ui-renderer/");
        const isNode = args.path.startsWith("node:");

        if (isNode) {
          if (args.path === "node:fs/promises" && allowScopedFs) {
            return { path: args.path, external: true };
          }
          if (registry.has(args.path)) {
            return { path: args.path, external: true };
          }
          whitelistViolation = {
            subpath: args.path,
            file: args.importer || entryPath,
            line: 1,
            column: 1,
          };
          return {
            errors: [
              {
                text: `Node builtin "${args.path}" is forbidden in ByteDock v0.1 plugins (Scheme alpha minimal node:* allowlist).`,
              },
            ],
          };
        }

        if (isEffect || isSdk) {
          if (registry.subpathWhitelist.has(args.path)) {
            return { path: args.path, external: true };
          }
          whitelistViolation = {
            subpath: args.path,
            file: args.importer || entryPath,
            line: 1,
            column: 1,
          };
          return {
            errors: [
              {
                text: `Subpath "${args.path}" is not in HostModuleRegistry whitelist; export it via @bytedock/plugin-sdk or request kernel whitelist update.`,
              },
            ],
          };
        }

        return undefined;
      });
    },
  };

  const result = yield* Effect.tryPromise({
    try: () =>
      esbuild.build({
        bundle: true,
        write: false,
        format: "cjs",
        platform: "node",
        target: "node22",
        sourcemap: "inline",
        plugins: [whitelistPlugin],
        ...(inlineSource !== undefined
          ? {
              stdin: {
                contents: inlineSource,
                resolveDir: NodePath.dirname(entryPath),
                sourcefile: entryPath,
                loader: "ts",
              },
            }
          : { entryPoints: [entryPath] }),
      }),
    catch: (error: unknown) => {
      const esbuildErr = error as {
        errors?: ReadonlyArray<{
          text?: string;
          location?: { file?: string; line?: number; column?: number } | null;
        }>;
      };
      const first = esbuildErr.errors?.[0];
      const text = first?.text ?? (error instanceof Error ? error.message : String(error));
      if (
        text.includes('Top-level await is currently not supported with the "cjs" output format')
      ) {
        return new EsmTlaRejectedError({
          pluginId,
          dependency: first?.location?.file ?? entryPath,
        });
      }
      if (whitelistViolation) {
        return new PluginCompileError({
          pluginId,
          file: first?.location?.file ?? whitelistViolation.file,
          line: first?.location?.line ?? whitelistViolation.line,
          column: first?.location?.column ?? whitelistViolation.column,
          message: text,
          reason: "SubpathNotWhitelisted",
        });
      }
      return new PluginCompileError({
        pluginId,
        file: first?.location?.file ?? entryPath,
        line: first?.location?.line ?? 1,
        column: first?.location?.column ?? 1,
        message: text,
        reason: "Syntax",
      });
    },
  });

  const code = result.outputFiles?.[0]?.text ?? "";
  const contentHash = NodeCrypto.createHash("sha256").update(code).digest("hex");

  return {
    pluginId,
    rev,
    filename: entryPath,
    code,
    contentHash,
  } satisfies CompiledPluginArtifact;
});
