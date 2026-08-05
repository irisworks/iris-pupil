import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { z, type ZodError } from "zod";
import { PupilError } from "./types.js";

const DEFAULT_CONFIG_FILE = "pupil.config.yaml";

type EnvSource = Record<string, string | undefined>;

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  profile?: string;
  env?: EnvSource;
}

const driverConfigSchema = z
  .object({
    type: z.string().min(1).default("rest"),
    preset: z.string().optional(),
    config: z.record(z.unknown()).default({}),
  })
  .strict()
  .default({ type: "rest", config: {} });

const profileDriverConfigSchema = z
  .object({
    type: z.string().min(1).optional(),
    preset: z.string().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

const historyConfigSchema = z
  .object({
    dir: z.string().min(1).default(".pupil"),
  })
  .strict()
  .default({ dir: ".pupil" });

const profileHistoryConfigSchema = z
  .object({
    dir: z.string().min(1).optional(),
  })
  .strict();

const langfuseConfigSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).default("auto"),
    host: z.string().optional(),
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    waitMs: z.coerce.number().int().nonnegative().optional(),
    timeoutMs: z.coerce.number().int().positive().optional(),
    initialDelayMs: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .default({ enabled: "auto" });

const profileLangfuseConfigSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    host: z.string().optional(),
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    waitMs: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const profileConfigSchema = z
  .object({
    scenarios: z.union([z.string(), z.array(z.string())]).optional(),
    driver: profileDriverConfigSchema.optional(),
    history: profileHistoryConfigSchema.optional(),
    langfuse: profileLangfuseConfigSchema.optional(),
  })
  .strict();

const pupilConfigSchema = z
  .object({
    scenarios: z.union([z.string(), z.array(z.string())]).default("examples/scenarios"),
    driver: driverConfigSchema,
    history: historyConfigSchema,
    langfuse: langfuseConfigSchema,
    profiles: z.record(profileConfigSchema).default({}),
  })
  .strict();

export type PupilConfig = z.infer<typeof pupilConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return merged as T;
}

function applyProfile(
  config: Record<string, unknown>,
  profile: string | undefined,
  file: string,
): Record<string, unknown> {
  if (!profile) return config;
  const profiles = isRecord(config.profiles) ? config.profiles : {};
  const selected = profiles[profile];
  if (!selected) {
    throw new PupilError(`Pupil config profile does not exist: ${profile}`, {
      file,
      path: "profiles",
    });
  }

  return deepMerge(config, selected as Record<string, unknown>);
}

function formatConfigValidationError(error: ZodError, file: string): PupilError {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${file}:${path}: ${issue.message}`;
    })
    .join("\n");

  return new PupilError(`Invalid Pupil config in ${file}\n${details}`, { file });
}

function resolveEnvString(value: string, env: EnvSource, file: string, path: string): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)(:-([^}]*))?\}/gi,
    (_match, name: string, _fallbackPart, fallback: string | undefined) => {
      const envValue = env[name];
      const hasFallback = fallback !== undefined;

      // ${VAR:-fallback} matches bash `:-`: falls back when VAR is unset OR empty.
      if (hasFallback) {
        return envValue ? envValue : fallback;
      }

      // Plain ${VAR} matches bash `$VAR`: a set-but-empty value substitutes
      // as an empty string; only a genuinely unset variable is an error.
      if (envValue !== undefined) return envValue;
      throw new PupilError(`Missing environment variable ${name} referenced by ${file}:${path}`, {
        file,
        path,
      });
    },
  );
}

function resolveEnvRefs(value: unknown, env: EnvSource, file: string, path = "<root>"): unknown {
  if (typeof value === "string") {
    return resolveEnvString(value, env, file, path);
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => resolveEnvRefs(entry, env, file, `${path}.${index}`));
  }

  if (value && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveEnvRefs(entry, env, file, path === "<root>" ? key : `${path}.${key}`);
    }
    return resolved;
  }

  return value;
}

export async function loadPupilConfig(options: LoadConfigOptions = {}): Promise<PupilConfig> {
  const cwd = options.cwd ?? process.cwd();
  const hasExplicitConfigPath = options.configPath !== undefined;
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_CONFIG_FILE);

  if (!existsSync(configPath)) {
    if (hasExplicitConfigPath) {
      throw new PupilError(`Pupil config file does not exist: ${configPath}`, {
        file: configPath,
      });
    }
    const defaults = pupilConfigSchema.parse({});
    const profiled = applyProfile(defaults, options.profile, configPath);
    return pupilConfigSchema.parse(profiled);
  }

  const source = await readFile(configPath, "utf-8");
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("\n");
    throw new PupilError(`Invalid YAML in ${configPath}\n${message}`, { file: configPath });
  }

  const rawConfig = (document.toJSON() ?? {}) as Record<string, unknown>;

  // Profile selection and merging happen on the raw document, before schema
  // validation: numeric fields may still hold unresolved ${VAR:-default}
  // templates at this point, which z.coerce.number() can't parse yet.
  const profiled = applyProfile(rawConfig, options.profile, configPath);
  const { profiles: _profiles, ...selectedConfig } = profiled;
  const resolvedConfig = resolveEnvRefs(selectedConfig, options.env ?? process.env, configPath);
  const parsed = pupilConfigSchema.safeParse(resolvedConfig);
  if (!parsed.success) {
    throw formatConfigValidationError(parsed.error, configPath);
  }

  return parsed.data;
}
