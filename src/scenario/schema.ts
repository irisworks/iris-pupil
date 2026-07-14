import { z, type ZodError } from "zod";
import type { Scenario } from "../core/types.js";
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

const textAssertionSchema = z
  .object({
    type: z.enum(["contains", "not_contains", "equals", "regex"]),
    target: z.string().min(1).default("response.text"),
    value: z.string(),
    caseSensitive: z.boolean().default(false),
  })
  .strict();

const jsonPathAssertionSchema = z
  .object({
    type: z.literal("jsonpath"),
    target: z.string().min(1).default("response.raw"),
    path: z.string().min(1, "jsonpath assertion requires path"),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.equals !== undefined || value.exists !== undefined, {
    message: "jsonpath assertion requires equals or exists",
  });

const assertionSchema = z.union([textAssertionSchema, jsonPathAssertionSchema]);

const turnSchema = z
  .object({
    user: z.string().min(1, "turn.user is required"),
    expect: z.array(assertionSchema).default([]),
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

const manualSchema = z
  .object({
    required: z.boolean().default(true),
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
