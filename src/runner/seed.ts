import {
  PupilError,
  type Scenario,
  type SeedStrategy,
  type SeedTurn,
  type ToolCall,
  type TurnRecord,
} from "../core/types.js";
import type { RestConversation, RestDriverResponse, SeedHistoryEntry } from "../driver/index.js";

/**
 * Deliberately narrower than the runner's `RunnerDriver` and defined locally
 * rather than imported from `./index.js` - `index.ts` imports from this
 * module, so importing `RunnerDriver` back would create a circular import.
 * `RunnerDriver` structurally satisfies this shape, so no cast is needed at
 * call sites.
 */
export interface SeedCapableDriver {
  createConversation(
    context?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<RestConversation>;
  send(conversation: RestConversation, message: string): Promise<RestDriverResponse>;
  supportsSeedStrategy?(strategy: SeedStrategy): boolean;
  fork?(conversation: RestConversation): Promise<RestConversation>;
  inject?(
    history: readonly SeedHistoryEntry[],
    context?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<RestConversation>;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Thrown when the seed phase fails after already creating a conversation and/or
 * replaying some seed turns - carries what actually happened so `executeAttempt`
 * can still close the session and report the partial turns, instead of losing
 * both to a bare propagated error.
 */
export class SeedPhaseError extends Error {
  constructor(
    readonly cause: unknown,
    readonly conversation: RestConversation,
    readonly turns: TurnRecord[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SeedPhaseError";
  }
}

/**
 * `replay` needs no capability check - it is just `send()` calls, which
 * every driver already supports. Only `fork`/`inject` can be unsupported.
 */
export function assertSeedCapability(scenario: Scenario, driver: SeedCapableDriver): void {
  const strategy = scenario.seed?.strategy;
  if (strategy === undefined || strategy === "replay") return;

  const supported =
    driver.supportsSeedStrategy?.(strategy) ??
    (strategy === "fork" ? driver.fork !== undefined : driver.inject !== undefined);
  if (!supported) {
    throw new PupilError(
      `scenario '${scenario.id}' requests seed.strategy: ${strategy}, but the driver does not support it`,
    );
  }
}

export function seedTurnsToHistory(turns: readonly SeedTurn[]): SeedHistoryEntry[] {
  return turns.map((turn) => ({ role: "user" as const, content: turn.user }));
}

export interface SeedPhaseResult {
  conversation: RestConversation;
  turns: TurnRecord[];
  seedCompletedAt?: string;
  /** Set only for `fork`: the pre-fork session, which also needs closing. */
  sourceConversation?: RestConversation;
}

async function replaySeedTurns(
  seedTurns: readonly SeedTurn[],
  driver: SeedCapableDriver,
  conversation: RestConversation,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  for (const [index, turn] of seedTurns.entries()) {
    const startedAt = now();
    try {
      const response = await driver.send(conversation, turn.user);
      const completedAt = now();
      records.push({
        index,
        user: turn.user,
        startedAt,
        completedAt,
        latencyMs: Date.parse(completedAt) - Date.parse(startedAt),
        response: { text: response.text, raw: response.raw },
        assertions: [],
        isSeed: true,
      });
    } catch (error) {
      const completedAt = now();
      records.push({
        index,
        user: turn.user,
        startedAt,
        completedAt,
        latencyMs: Date.parse(completedAt) - Date.parse(startedAt),
        error: error instanceof Error ? error.message : String(error),
        assertions: [],
        isSeed: true,
      });
      throw new SeedPhaseError(error, conversation, records);
    }
  }
  return records;
}

/**
 * Produces the conversation the asserted turns should run against, plus any
 * seed `TurnRecord`s that happened along the way. Called once, before the
 * asserted turn loop, from `executeAttempt`.
 */
export async function runSeedPhase(
  scenario: Scenario,
  driver: SeedCapableDriver,
  createContext: Record<string, string | number | boolean | null | undefined>,
): Promise<SeedPhaseResult> {
  const seed = scenario.seed;

  if (seed?.strategy === "inject") {
    if (!driver.inject) {
      throw new PupilError(
        `scenario '${scenario.id}' requests seed.strategy: inject, but the driver does not implement inject`,
      );
    }
    const conversation = await driver.inject(seedTurnsToHistory(seed.turns), createContext);
    return { conversation, turns: [] };
  }

  const conversation = await driver.createConversation(createContext);

  if (seed === undefined) {
    return { conversation, turns: [] };
  }

  const seedTurns = await replaySeedTurns(seed.turns, driver, conversation);

  if (seed.strategy === "fork") {
    if (!driver.fork) {
      throw new SeedPhaseError(
        new PupilError(
          `scenario '${scenario.id}' requests seed.strategy: fork, but the driver does not implement fork`,
        ),
        conversation,
        seedTurns,
      );
    }
    try {
      const forked = await driver.fork(conversation);
      return {
        conversation: forked,
        turns: seedTurns,
        seedCompletedAt: now(),
        sourceConversation: conversation,
      };
    } catch (error) {
      throw new SeedPhaseError(error, conversation, seedTurns);
    }
  }

  return { conversation, turns: seedTurns, seedCompletedAt: now() };
}

/**
 * `replay`/`fork` make real driver calls during the seed phase, so a tool
 * triggered while seeding is otherwise indistinguishable - in Langfuse's
 * session-level trace - from one triggered during the asserted turns. Drops
 * anything timestamped before the seed phase finished; keeps anything with no
 * timestamp at all, since we cannot prove those were seed-phase and this
 * codebase's existing bias is to risk extra evidence over silently discarding
 * real evidence.
 */
export function filterSeedPhaseToolCalls(
  calls: readonly ToolCall[] | undefined,
  seedCompletedAt: string | undefined,
): readonly ToolCall[] | undefined {
  if (calls === undefined || seedCompletedAt === undefined) return calls;
  const boundaryMs = Date.parse(seedCompletedAt);
  return calls.filter(
    (call) => call.startedAt === undefined || Date.parse(call.startedAt) >= boundaryMs,
  );
}
