import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

it("merges multi-value disjoint tagged unions and redundant primitive/range unions", () => {
  const tool = Tool.make("filter_example", {
    parameters: Schema.Struct({
      filter: Schema.Union([
        Schema.Struct({
          op: Schema.Literals(["equals", "startsWith"]),
          path: Schema.String,
          value: Schema.String,
        }),
        Schema.Struct({
          op: Schema.Literal("exists"),
          path: Schema.String,
        }),
      ]),
      sizeBytes: Schema.Union([
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
      ]),
      mimeType: Schema.Union([Schema.Literals(["image/png", "image/jpeg"]), Schema.String]),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["equals", "startsWith", "exists"] },
          path: { type: "string" },
          value: { type: "string" },
        },
        required: ["op", "path"],
      },
      sizeBytes: { type: "integer", minimum: 0, maximum: 50 },
      mimeType: { type: "string" },
    },
    required: ["filter", "sizeBytes", "mimeType"],
  });
});

it("keeps schedule_task, t3_thread_launch, and delegate_task under 2 KB without anyOf", () => {
  const tools = [
    OrchestratorToolkit.tools.schedule_task,
    ProjectToolkit.tools.t3_thread_launch,
    OrchestratorToolkit.tools.delegate_task,
  ];
  for (const tool of tools) {
    const schema = advertisedJsonSchema(tool);
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: schema,
    });
    expect(
      Buffer.byteLength(serialized, "utf8"),
      `${tool.name} (${serialized.length}B)`,
    ).toBeLessThan(2048);
    expect(serialized, tool.name).not.toContain('"anyOf"');
  }
});
