import { z, type ZodError } from "zod";
import type { InvariantCheck, Scenario } from "../core/types.js";
import { PupilError } from "../core/types.js";

const metadataSchema = z.record(z.unknown()).default({});

const driverSchema = z
  .object({
    type: z.string().min(1, "driver.type is required").default("rest"),
    preset: z.string().optional(),
    config: metadataSchema.optional(),
  })
  .strict()
  .default({ type: "rest", config: {} });

/**
 * One schema per text-assertion `type` literal (rather than a single schema
 * with `type: z.enum([...])`) so every variant can sit directly in the flat
 * `z.discriminatedUnion` below. A shared enum field can't serve as a
 * discriminated union's discriminant because each branch of a discriminated
 * union must carry its own single literal value.
 */
function textAssertionVariant<T extends string>(type: T) {
  return z
    .object({
      type: z.literal(type),
      target: z.string().min(1).default("response.text"),
      value: z.string(),
      caseSensitive: z.boolean().default(false),
    })
    .strict();
}

const containsSchema = textAssertionVariant("contains");
const notContainsSchema = textAssertionVariant("not_contains");
const equalsSchema = textAssertionVariant("equals");
const regexSchema = textAssertionVariant("regex");

// No `.refine()` here (that would produce a `ZodEffects`, which
// `z.discriminatedUnion` can't accept as a branch) - the equals/exists
// requirement is enforced by the `superRefine` on `assertionSchema` below.
const jsonPathAssertionSchema = z
  .object({
    type: z.literal("jsonpath"),
    target: z.string().min(1).default("response.raw"),
    path: z.string().min(1, "jsonpath assertion requires path"),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
  })
  .strict();

const toolNameMatchSchema = z.enum(["exact", "glob"]).default("exact");

const toolCalledSchema = z
  .object({
    type: z.literal("tool_called"),
    tool: z.string().min(1, "tool_called requires tool"),
    match: toolNameMatchSchema,
    times: z.number().int().nonnegative().optional(),
  })
  .strict();

const toolNotCalledSchema = z
  .object({
    type: z.literal("tool_not_called"),
    tool: z.string().min(1, "tool_not_called requires tool"),
    match: toolNameMatchSchema,
  })
  .strict();

// Same reasoning as `jsonPathAssertionSchema`: the min/max requirement moves
// to the outer `superRefine` so this stays a plain object schema.
const toolCallCountSchema = z
  .object({
    type: z.literal("tool_call_count"),
    tool: z.string().min(1).optional(),
    match: toolNameMatchSchema,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .strict();

const toolOrderSchema = z
  .object({
    type: z.literal("tool_order"),
    tools: z.array(z.string().min(1)).min(1, "tool_order requires at least one tool"),
    match: toolNameMatchSchema,
  })
  .strict();

const toolArgsSchema = z
  .object({
    type: z.literal("tool_args"),
    tool: z.string().min(1, "tool_args requires tool"),
    match: toolNameMatchSchema,
    equals: z.record(z.unknown()),
  })
  .strict();

// Shared branch lists, reused by both the scenario-level and turn-level
// discriminated unions below so the individual branch schemas are defined
// exactly once.
const nonToolAssertionBranches = [
  containsSchema,
  notContainsSchema,
  equalsSchema,
  regexSchema,
  jsonPathAssertionSchema,
] as const;

const toolAssertionBranches = [
  toolCalledSchema,
  toolNotCalledSchema,
  toolCallCountSchema,
  toolOrderSchema,
  toolArgsSchema,
] as const;

function withAssertionRefinements<T extends z.ZodDiscriminatedUnion<"type", any>>(union: T) {
  return union.superRefine((value, ctx) => {
    if (value.type === "jsonpath" && value.equals === undefined && value.exists === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "jsonpath assertion requires equals or exists",
      });
    }
    if (value.type === "tool_call_count" && value.min === undefined && value.max === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool_call_count requires at least one of min or max",
      });
    }
  });
}

/**
 * A single flat `z.discriminatedUnion` over all ten `type` literals (the
 * seven assertion shapes, with the four text-assertion types counted once
 * each). Zod resolves a discriminated union by reading `type` and parsing
 * only the matching branch, so a malformed assertion produces exactly the
 * issues from the branch the author meant - never noise from unrelated
 * branches, and never the opaque `invalid_union` wrapper a plain `z.union`
 * (or a discriminated union nested inside one) would produce instead.
 *
 * Scenario-scoped only. Used at the top-level `expect:`/`assertions:`.
 */
const assertionSchema = withAssertionRefinements(
  z.discriminatedUnion("type", [...nonToolAssertionBranches, ...toolAssertionBranches]),
);

/**
 * Same branches minus the five tool-assertion types. Enrichment that
 * populates `trajectory.toolCalls` runs once per scenario after all turns
 * finish (see design decision 2), so there is no reliable way to attribute a
 * tool call to a specific turn. A per-turn tool assertion would otherwise
 * silently skip forever - or, under `--require-trace`, falsely fail with a
 * misleading "no trace evidence" reason even though scenario-level trace
 * evidence exists. Reject it at schema validation time instead.
 */
const turnAssertionSchema = withAssertionRefinements(
  z.discriminatedUnion("type", [...nonToolAssertionBranches]),
);

const turnSchema = z
  .object({
    user: z.string().min(1, "turn.user is required"),
    expect: z.array(turnAssertionSchema).default([]),
  })
  .strict();

const thresholdSchema = z
  .object({
    metric: z.string().min(1),
    max: z.number().optional(),
    min: z.number().optional(),
  })
  .strict()
  .refine((value) => value.max !== undefined || value.min !== undefined, {
    message: "threshold requires at least one of min or max",
  });

const invariantCheckSchema = z
  .object({
    assertion: assertionSchema.optional(),
    threshold: thresholdSchema.optional(),
    maxViolationRate: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.assertion === undefined) === (value.threshold === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invariant requires exactly one of assertion or threshold",
      });
    }
  });

const manualSchema = z
  .object({
    required: z.boolean().default(true),
    criteria: z.array(z.string().min(1)).default(["overall"]),
    prompt: z.string().optional(),
    rubric: z.array(z.string()).default([]),
  })
  .strict();

const judgeSchema = z
  .object({
    enabled: z.boolean().default(true),
    prompt: z.string().optional(),
    rubric: z.array(z.string()).default([]),
    model: z.string().optional(),
  })
  .strict();

const expectSchema = z
  .object({
    assertions: z.array(assertionSchema).default([]),
    thresholds: z.array(thresholdSchema).default([]),
    manual: manualSchema.optional(),
    judge: judgeSchema.optional(),
  })
  .strict()
  .default({ assertions: [], thresholds: [] });

const rawScenarioSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    metadata: metadataSchema.optional(),
    driver: driverSchema.optional(),
    input: z.unknown().optional(),
    turns: z.array(turnSchema).min(1, "scenario requires at least one turn").optional(),
    expect: expectSchema.optional(),
    assertions: z.array(assertionSchema).optional(),
    thresholds: z.array(thresholdSchema).optional(),
    manual: manualSchema.optional(),
    judge: judgeSchema.optional(),
    invariants: z.array(invariantCheckSchema).default([]),
  })
  .strict()
  .refine((value) => value.input !== undefined || value.turns !== undefined, {
    message: "scenario requires input or turns",
    path: ["input"],
  })
  .refine((value) => !(value.input !== undefined && value.turns !== undefined), {
    message: "scenario cannot define both input and turns",
    path: ["turns"],
  });

const inputObjectSchema = z
  .object({
    text: z.string().optional(),
    message: z.string().optional(),
    user: z.string().optional(),
  })
  .strict();

export type RawScenario = z.infer<typeof rawScenarioSchema>;

/** Normalize invariant wrappers for scenario YAML and repository policy files. */
export function normalizeInvariantChecks(
  raw: unknown,
  sourceFile?: string,
  pathPrefix: string[] = ["invariants"],
): InvariantCheck[] {
  const parsed = z.array(invariantCheckSchema).safeParse(raw);
  if (!parsed.success) {
    throw formatScenarioValidationError(parsed.error, sourceFile, pathPrefix);
  }
  return parsed.data as InvariantCheck[];
}

function normalizeInput(input: unknown, sourceFile?: string): Scenario["turns"] {
  if (typeof input === "string") {
    return [{ user: input, expect: [] }];
  }

  const parsedInput = inputObjectSchema.safeParse(input);
  if (!parsedInput.success) {
    throw formatScenarioValidationError(parsedInput.error, sourceFile, ["input"]);
  }

  const objectInput = parsedInput.data;
  const user = objectInput.user ?? objectInput.text ?? objectInput.message;
  if (user) {
    return [{ user, expect: [] }];
  }

  throw new PupilError("input requires a string, text, message, or user", {
    file: sourceFile,
    path: "input",
  });
}

export function normalizeScenario(raw: unknown, sourceFile?: string): Scenario {
  const parsed = rawScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatScenarioValidationError(parsed.error, sourceFile);
  }

  const scenario = parsed.data;
  const turns = scenario.turns ?? normalizeInput(scenario.input, sourceFile);
  const expectations = scenario.expect ?? { assertions: [], thresholds: [] };

  return {
    id: scenario.id,
    name: scenario.name ?? scenario.id,
    ...(scenario.description !== undefined && { description: scenario.description }),
    tags: scenario.tags,
    metadata: scenario.metadata ?? {},
    driver: {
      type: scenario.driver?.type ?? "rest",
      ...(scenario.driver?.preset !== undefined && { preset: scenario.driver.preset }),
      config: scenario.driver?.config ?? {},
    },
    turns,
    expect: {
      assertions: [...expectations.assertions, ...(scenario.assertions ?? [])],
      thresholds: [...expectations.thresholds, ...(scenario.thresholds ?? [])],
      manual: scenario.manual ?? expectations.manual,
      judge: scenario.judge ?? expectations.judge,
    },
    invariants: scenario.invariants as InvariantCheck[],
    ...(sourceFile !== undefined && { sourceFile }),
  };
}

export function formatScenarioValidationError(
  error: ZodError,
  file?: string,
  pathPrefix: string[] = [],
): PupilError {
  const details = error.issues
    .map((issue) => {
      const fullPath = [...pathPrefix, ...issue.path];
      const path = fullPath.length > 0 ? fullPath.join(".") : "<root>";
      return `${file ? `${file}:` : ""}${path}: ${issue.message}`;
    })
    .join("\n");

  return new PupilError(`Invalid scenario${file ? ` in ${file}` : ""}\n${details}`, {
    file,
  });
}
