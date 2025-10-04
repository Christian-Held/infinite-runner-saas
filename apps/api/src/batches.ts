import { Ability, getLevelPlan, type AbilityT } from '@ir/game-spec';
import { z } from 'zod';

import type { AppConfig } from './config';

const AbilityOverrideSchema = z
  .object({
    run: z.literal(true).optional(),
    jump: z.literal(true).optional(),
    highJump: z.boolean().optional(),
    shortFly: z.boolean().optional(),
    jetpack: Ability.shape.jetpack.optional(),
  })
  .partial();

const DifficultyRampSchema = z
  .object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    steps: z.union([z.literal('auto'), z.number().int().min(2)]).default('auto'),
  })
  .refine((value) => value.to >= value.from, {
    message: 'invalid_ramp',
    path: ['to'],
  });

const ConstraintsSchema = z
  .object({
    max_moving_platforms: z.number().int().min(0).optional(),
    max_enemies: z.number().int().min(0).optional(),
    max_hazards: z.number().int().min(0).optional(),
  })
  .partial();

export interface NormalizedBatchRequest {
  count: number;
  startLevel: number;
  seedPrefix: string;
  season?: string | null;
  difficultyMode: 'fixed' | 'ramp';
  difficultyFixed?: number;
  difficultyRamp?: { from: number; to: number; steps: number };
  abilitiesOverride?: z.infer<typeof AbilityOverrideSchema>;
  constraints?: z.infer<typeof ConstraintsSchema>;
  idempotencyKey?: string;
  fingerprint: string;
}

export interface BatchJobPlan {
  index: number;
  seed: string;
  levelNumber: number;
  difficulty: number;
  abilities: AbilityT;
}

export interface BatchRequestParseResult {
  normalized: NormalizedBatchRequest;
  plans: BatchJobPlan[];
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableClone(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const result: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      result[key] = stableClone(val);
    }
    return result;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function createBatchSchema(countMax: number) {
  return z
    .object({
      count: z.number().int().min(1).max(countMax),
      start_level: z.number().int().min(1).default(1),
      seed_prefix: z.string().trim().min(1).max(128).default('seed'),
      season: z.string().trim().min(1).max(128).optional(),
      difficulty_mode: z.enum(['fixed', 'ramp']).default('fixed'),
      difficulty_fixed: z.number().int().min(1).max(100).optional(),
      difficulty_ramp: DifficultyRampSchema.optional(),
      abilities: AbilityOverrideSchema.optional(),
      constraints: ConstraintsSchema.optional(),
      idempotency_key: z.string().trim().min(1).max(200).optional(),
    })
    .refine(
      (value) => {
        if (value.difficulty_mode === 'fixed') {
          return true;
        }
        return value.difficulty_ramp !== undefined;
      },
      {
        message: 'missing_ramp',
        path: ['difficulty_ramp'],
      },
    );
}

function mergeAbilities(
  base: AbilityT,
  override?: z.infer<typeof AbilityOverrideSchema>,
): AbilityT {
  if (!override) {
    return Ability.parse(base);
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = value;
  }
  if (merged.run !== true) {
    merged.run = true;
  }
  if (merged.jump !== true) {
    merged.jump = true;
  }
  return Ability.parse(merged);
}

function resolveRampValue(
  index: number,
  params: { from: number; to: number; steps: number },
): number {
  const steps = Math.max(1, params.steps);
  if (steps === 1) {
    return params.to;
  }
  const clampedIndex = Math.min(index, steps - 1);
  const ratio = clampedIndex / (steps - 1);
  const raw = params.from + (params.to - params.from) * ratio;
  return Math.max(1, Math.round(raw));
}

export function parseBatchRequest(payload: unknown, config: AppConfig): BatchRequestParseResult {
  const schema = createBatchSchema(config.batch.countMax);
  const parsed = schema.parse(payload ?? {});

  const count = parsed.count;

  const startLevel = parsed.start_level ?? 1;
  const seedPrefix = parsed.seed_prefix ?? 'seed';
  const season = parsed.season?.length ? parsed.season : undefined;
  const difficultyMode = parsed.difficulty_mode ?? 'fixed';

  const ramp =
    difficultyMode === 'ramp'
      ? {
          from: parsed.difficulty_ramp?.from ?? 1,
          to: parsed.difficulty_ramp?.to ?? parsed.difficulty_ramp?.from ?? 1,
          steps:
            parsed.difficulty_ramp?.steps === 'auto'
              ? count
              : Math.max(2, parsed.difficulty_ramp?.steps ?? count),
        }
      : undefined;

  const difficultyFixed =
    difficultyMode === 'fixed' ? (parsed.difficulty_fixed ?? undefined) : undefined;

  const normalized: NormalizedBatchRequest = {
    count,
    startLevel,
    seedPrefix,
    season: season ?? null,
    difficultyMode,
    difficultyFixed,
    difficultyRamp: ramp,
    abilitiesOverride: parsed.abilities,
    constraints: parsed.constraints,
    idempotencyKey: parsed.idempotency_key,
    fingerprint: '',
  };

  const canonicalPayload = {
    count,
    start_level: startLevel,
    seed_prefix: seedPrefix,
    season: season ?? null,
    difficulty_mode: difficultyMode,
    difficulty_fixed: difficultyFixed ?? null,
    difficulty_ramp: ramp ?? null,
    abilities: parsed.abilities ?? null,
    constraints: parsed.constraints ?? null,
  };
  normalized.fingerprint = stableStringify(canonicalPayload);

  const plans: BatchJobPlan[] = [];
  for (let index = 0; index < count; index += 1) {
    const levelNumber = startLevel + index;
    const plan = getLevelPlan(levelNumber);
    const ability = mergeAbilities(plan.abilities, parsed.abilities);

    let difficulty: number;
    if (difficultyMode === 'fixed') {
      difficulty = difficultyFixed ?? plan.difficultyTarget;
    } else {
      difficulty = resolveRampValue(index, ramp!);
    }
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
      difficulty = Math.max(1, Math.round(plan.difficultyTarget));
    }

    const seed = `${seedPrefix}-${levelNumber}`;
    plans.push({ index, seed, levelNumber, difficulty, abilities: ability });
  }

  return { normalized, plans };
}
