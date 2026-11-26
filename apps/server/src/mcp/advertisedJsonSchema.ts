import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const tagValuesOf = (branch: JsonObject, key: string): ReadonlyArray<string> | undefined => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  if (
    !Predicate.isObject(property) ||
    !Array.isArray(property.enum) ||
    property.enum.length === 0 ||
    !property.enum.every((item): item is string => typeof item === "string")
  ) {
    return undefined;
  }
  return property.enum;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const valueLists = objects.map((object) => tagValuesOf(object, key));
    if (!valueLists.every((values): values is ReadonlyArray<string> => values !== undefined)) {
      return false;
    }
    const allValues = valueLists.flat();
    return new Set(allValues).size === allValues.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: {
      type: "string",
      enum: objects.flatMap((object) => tagValuesOf(object, tag) ?? []),
    },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (Predicate.isObject(property) && Array.isArray(property.anyOf)) {
      const merged = mergeSimpleUnion(property.anyOf);
      if (merged !== undefined) {
        const { anyOf: _anyOf, ...rest } = property;
        properties[name] = { ...merged, ...rest };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const isSimpleNumericBranch = (value: Json, type: "integer" | "number"): value is JsonObject =>
  Predicate.isObject(value) &&
  value.type === type &&
  Object.keys(value).every((key) => key === "type" || key === "minimum" || key === "maximum");

const isKeyValueArrayBranch = (value: Json): boolean =>
  Predicate.isObject(value) &&
  value.type === "array" &&
  Predicate.isObject(value.items) &&
  value.items.type === "object" &&
  Predicate.isObject(value.items.properties) &&
  "id" in value.items.properties &&
  "value" in value.items.properties;

const isRecordObjectBranch = (value: Json): boolean =>
  Predicate.isObject(value) &&
  value.type === "object" &&
  value.additionalProperties !== undefined &&
  value.properties === undefined;

/** Collapses redundant primitive/range unions and dual array-or-record map unions. */
const mergeSimpleUnion = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  for (const numericType of ["integer", "number"] as const) {
    if (branches.every((branch) => isSimpleNumericBranch(branch, numericType))) {
      const numericBranches = branches as ReadonlyArray<JsonObject>;
      const mins = numericBranches
        .map((branch) => branch.minimum)
        .filter((value): value is number => typeof value === "number");
      const maxs = numericBranches
        .map((branch) => branch.maximum)
        .filter((value): value is number => typeof value === "number");
      return {
        type: numericType,
        ...(mins.length === numericBranches.length ? { minimum: Math.min(...mins) } : {}),
        ...(maxs.length === numericBranches.length ? { maximum: Math.max(...maxs) } : {}),
      };
    }
  }
  if (
    branches.every((branch) => Predicate.isObject(branch) && branch.type === "string") &&
    branches.some(
      (branch) =>
        Predicate.isObject(branch) &&
        Object.keys(branch).every((key) => key === "type" || key === "description"),
    )
  ) {
    return { type: "string" };
  }
  if (
    branches.length === 2 &&
    branches.some(isKeyValueArrayBranch) &&
    branches.some(isRecordObjectBranch)
  ) {
    return { type: "object" };
  }
  return undefined;
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (isNonStringEnum(key, value)) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only =
      branches.length === 1
        ? branches[0]
        : (mergeTaggedObjects(branches) ?? mergeSimpleUnion(branches));
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

const COMPACT_ADVERTISED_PROPERTIES: Readonly<
  Record<string, Readonly<Record<string, JsonObject>>>
> = {
  // Deeply nested webhook config and peer-forwarding metadata push these tools over ACP clients'
  // 2 KB per-tool schema cap; full decoding still validates the complete Effect Schema.
  schedule_task: {
    "schedule.signature": {
      type: "object",
      description:
        "HMAC-SHA256 check: {header, encoding:'hex'|'base64', prefix, secret|secretRef}. Omit for URL token only.",
    },
    "schedule.dedupe": {
      type: "object",
      description: "Webhook {replayKey?, coalesceKey?, coalesceWindowSeconds?(10-3600, def 120)}.",
    },
    "schedule.filters": {
      type: "array",
      items: { type: "object" },
      description:
        "Webhook filters (max 16, all must match; []: clear): [{path, op:'equals'|'notEquals'|'startsWith'|'in'|'exists', value?}].",
    },
  },
  t3_thread_launch: {
    delegatedFrom: { type: "object" },
    workflowRun: { type: "object" },
    modelSelection: {
      type: "object",
      description: "{model, provider?, instanceId?, options?}",
    },
    "workspaceStrategy.repositories": {
      type: "array",
      items: { type: "object" },
      description: "Tracked Git folders [{path}]. Default: all (or none >8).",
    },
    attachments: {
      type: "array",
      items: { type: "object" },
      maxItems: 8,
      description: "Uploaded [{type:'image'|'file', id, name, mimeType, sizeBytes}].",
    },
  },
};

const applyCompactOverrides = (
  schema: Json,
  overrides: Readonly<Record<string, JsonObject>>,
  prefix = "",
): Json => {
  if (!Predicate.isObject(schema) || !Predicate.isObject(schema.properties)) return schema;
  const nextProperties: JsonObject = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    const override = overrides[path];
    nextProperties[name] =
      override !== undefined ? override : applyCompactOverrides(property, overrides, path);
  }
  return { ...schema, properties: nextProperties };
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, nested `anyOf`, JSON-string fallbacks, and
 * the `null` branch of optional properties. A tagged union of objects becomes one object.
 * Decoding still uses the full schema, so each tag's own required fields still apply.
 */
export const advertisedJsonSchema = (tool: Tool.Any) => {
  const compacted = compact(Tool.getJsonSchema(tool), false);
  const overrides = COMPACT_ADVERTISED_PROPERTIES[tool.name];
  return (
    overrides === undefined ? compacted : applyCompactOverrides(compacted, overrides)
  ) as ReturnType<typeof Tool.getJsonSchema>;
};
