import { z, type ZodError } from "zod";
import type { Scenario } from "../core/types.js";
import { PupilError } from "../core/types.js";

const metadataSchema = z.record(z.unknown()).default({});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]).default("user"),
  content: z.string().min(1, "message content is required"),
  name: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const driverSchema = z
  .object({
    type: z.string().min(1, "driver.type is required").default("rest"),
    preset: z.string().optional(),
    config: metadataSchema.optional(),
  })
  .default({ type: "rest", config: {} });

const assertionSchema = z
  .object({
    type: z.enum(["contains", "not_contains", "equals", "regex"]),
    target: z.string().min(1).default("response.text"),
    value: z.string(),
    caseSensitive: z.boolean().default(false),
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
    turns: z.array(messageSchema).optional(),
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
  });

export type RawScenario = z.infer<typeof rawScenarioSchema>;

function normalizeInput(input: unknown): Scenario["turns"] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  const objectInput = z
    .object({
      text: z.string().optional(),
      message: z.string().optional(),
      messages: z.array(messageSchema).optional(),
    })
    .strict()
    .parse(input);

  if (objectInput.messages) {
    return objectInput.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name !== undefined && { name: message.name }),
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    }));
  }

  const content = objectInput.text ?? objectInput.message;
  if (content) {
    return [{ role: "user", content }];
  }

  throw new PupilError("input requires a string, text, message, or messages");
}

export function normalizeScenario(raw: unknown, sourceFile?: string): Scenario {
  const parsed = rawScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatScenarioValidationError(parsed.error, sourceFile);
  }

  const scenario = parsed.data;
  const turns = scenario.turns ?? normalizeInput(scenario.input);
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

export function formatScenarioValidationError(error: ZodError, file?: string): PupilError {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${file ? `${file}:` : ""}${path}: ${issue.message}`;
    })
    .join("\n");

  return new PupilError(`Invalid scenario${file ? ` in ${file}` : ""}\n${details}`, {
    file,
  });
}
