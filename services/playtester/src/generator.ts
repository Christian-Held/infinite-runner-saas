import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  Ability,
  Level,
  getBiome,
  getLevelPlan,
  type Biome,
  type BiomeParams,
} from '@ir/game-spec';
import stringify from 'fast-json-stable-stringify';
import seedrandom from 'seedrandom';
import { z } from 'zod';

import type { Logger } from '@ir/logger';

import { getOpenAIClient, getRedisClient, closeClients, getModel } from './clients';
import { trackAndCheck } from './costguard';
import { scoreLevel, withinBand } from './scoring';
import { cfg } from './config';

const GEN_MAX_ATTEMPTS = Number(process.env.GEN_MAX_ATTEMPTS ?? '3');
const GEN_SIMHASH_TTL_SEC = Number(process.env.GEN_SIMHASH_TTL_SEC ?? '604800');

export interface GenerationConstraints {
  gravityY: number;
  moveSpeed: number;
  jumpVelocity: number;
  maxGapPX: number;
  minPlatformWidthPX: number;
  maxStepUpPX: number;
  targetDurationSec: number;
}

export const DEFAULT_CONSTRAINTS: GenerationConstraints = {
  gravityY: 1200,
  moveSpeed: 180,
  jumpVelocity: -520,
  maxGapPX: 140,
  minPlatformWidthPX: 48,
  maxStepUpPX: 96,
  targetDurationSec: 60,
};

const AbilitySchema = Ability;

interface PromptFragments {
  system: string;
  user: string;
}

class ParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

type EnemyPattern = 'patrol' | 'chase' | 'projectile';

interface HazardWindowConfig {
  minOpenMs: number;
  periodRange: [number, number];
}

function formatColorHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function allowedEnemyPatternsForLevel(levelNumber: number): EnemyPattern[] {
  if (levelNumber >= 35) {
    return ['patrol', 'chase', 'projectile'];
  }
  if (levelNumber >= 20) {
    return ['patrol', 'chase'];
  }
  return ['patrol'];
}

function hazardWindowForLevel(levelNumber: number): HazardWindowConfig {
  const t = Math.min(Math.max((levelNumber - 1) / 99, 0), 1);
  const interpolated = 320 - (320 - 180) * t;
  const minOpenMs = Math.max(180, Math.round(interpolated));
  return { minOpenMs, periodRange: [800, 2200] };
}

function describeBiome(name: Biome, params: BiomeParams): string[] {
  const palette = params.palette;
  return [
    `Biome: ${name}`,
    `Palette BG ${formatColorHex(palette.bg)}, Plattform ${formatColorHex(palette.platform)}, Hazard ${formatColorHex(palette.hazard)}, Akzent ${formatColorHex(palette.accent)}`,
    `Hinweise: Bodenreibung ${params.friction.toFixed(2)}, Hazard-Bias ${params.ambientHazardBias.toFixed(2)}, Moving-Bias ${params.movingBias.toFixed(2)}`,
  ];
}

function buildMiniExample(
  seed: string,
  difficulty: number,
  abilities: AbilityT,
  constraints: GenerationConstraints,
): string {
  const rng = seedrandom(`${seed}|${difficulty}`);
  const baseY = Math.round(rng() * 100) + 240;
  const platformWidth = constraints.minPlatformWidthPX + Math.round(rng() * 32);
  const gap = Math.min(constraints.maxGapPX - 10, Math.round(rng() * constraints.maxGapPX * 0.6));
  const secondHeight = baseY - Math.round(rng() * (constraints.maxStepUpPX - 12));

  const tiles = [
    {
      x: 0,
      y: baseY,
      w: platformWidth,
      h: 24,
      type: 'ground',
    },
    {
      x: platformWidth + gap,
      y: secondHeight,
      w: platformWidth + 16,
      h: 20,
      type: 'platform',
    },
  ];

  const exit = {
    x: tiles[1].x + tiles[1].w - 24,
    y: tiles[1].y - 48,
  };

  const extras: string[] = [];
  if (abilities.jetpack) {
    extras.push('Ein Jetpack-Fuel-Item in mittlerer Höhe.');
  } else if (abilities.shortFly) {
    extras.push('Optionaler kurzer Luftpfad mit schwebenden Plattformen.');
  } else {
    extras.push('Füge sichere Plattformen ohne Fluganforderungen hinzu.');
  }

  return [
    'Beispielauszug (nur Teilstruktur, nicht vollständiges Level):',
    JSON.stringify({ tiles, exit }, null, 2),
    `Hinweis: ${extras.join(' ')}`,
  ].join('\n');
}

type AbilityT = z.infer<typeof AbilitySchema>;
type LevelShape = z.infer<typeof Level>;

export function makePrompt(
  seed: string,
  difficulty: number,
  abilities: AbilityT,
  constraints: GenerationConstraints,
  extraGuidance = '',
  planDetails?: {
    levelNumber: number;
    difficultyTarget: number;
    difficultyBand: [number, number];
    limits: {
      movingMax?: number;
      enemyMax?: number;
      hazardMax?: number;
      jetpack?: { fuel: number; thrust: number } | undefined;
    };
    seasonId?: string;
    biome?: { name: Biome; params: BiomeParams };
    enemyPatterns?: EnemyPattern[];
    hazardWindow?: HazardWindowConfig;
  },
): PromptFragments {
  const abilitySummary = JSON.stringify(abilities);
  const constraintLines = [
    `- Gravitation Y: ${constraints.gravityY} px/s^2`,
    `- Laufgeschwindigkeit: ${constraints.moveSpeed} px/s`,
    `- Absprunggeschwindigkeit: ${constraints.jumpVelocity} px/s`,
    `- Maximale sichere Lücke: ${constraints.maxGapPX} px`,
    `- Minimale Plattformbreite: ${constraints.minPlatformWidthPX} px`,
    `- Maximale Stufenhöhe: ${constraints.maxStepUpPX} px`,
    `- Ziel-Leveldauer: ${constraints.targetDurationSec} Sekunden`,
    '- Weltkoordinaten in Pixel, Ursprung links oben.',
    '- Keine überlappenden Tiles, Hazard nur auf betretbarer Höhe, Ausgang erreichbar.',
    '- Abilities definieren erlaubte Elemente (keine Flugobjekte ohne passende Fähigkeit).',
  ];

  const example = buildMiniExample(seed, difficulty, abilities, constraints);

  const userParts = [
    `Seed: ${seed}`,
    `Schwierigkeit: ${difficulty}`,
    `Abilities: ${abilitySummary}`,
  ];

  if (planDetails) {
    const [bandMin, bandMax] = planDetails.difficultyBand;
    const limits = planDetails.limits;
    const limitLines = [
      `- Bewegliche Plattformen max.: ${typeof limits.movingMax === 'number' ? limits.movingMax : 'frei'}`,
      `- Gegner max.: ${typeof limits.enemyMax === 'number' ? limits.enemyMax : 'frei'}`,
      `- Gefahren max.: ${typeof limits.hazardMax === 'number' ? limits.hazardMax : 'sparsam'}`,
    ];
    if (limits.jetpack) {
      limitLines.push(`- Jetpack-Fuel: ${limits.jetpack.fuel} (Thrust ${limits.jetpack.thrust})`);
    }
    const biomeLines = planDetails.biome ? describeBiome(planDetails.biome.name, planDetails.biome.params) : [];
    const patternLine = planDetails.enemyPatterns?.length
      ? [`Erlaubte Gegner-Muster: ${planDetails.enemyPatterns.join(', ')}`]
      : [];
    const hazardWindowLine = planDetails.hazardWindow
      ? [
          `Bewegende Gefahren: period_ms ${planDetails.hazardWindow.periodRange[0]}-${planDetails.hazardWindow.periodRange[1]} und offene Fenster >= ${planDetails.hazardWindow.minOpenMs} ms (Nutze open_ms für das Fenster).`,
        ]
      : [];
    userParts.push(
      `Level-Nummer: ${planDetails.levelNumber} / 100`,
      `Season: ${planDetails.seasonId ?? 'standalone'}`,
      `Ziel-Schwierigkeitsscore: ${planDetails.difficultyTarget} (Band ${bandMin}-${bandMax})`,
      'Grenzwerte für Inhalte:',
      ...limitLines,
      ...biomeLines,
      ...patternLine,
      ...hazardWindowLine,
    );
  }

  userParts.push('Constraints:', ...constraintLines, example);

  if (extraGuidance.trim().length > 0) {
    userParts.push('Feedback aus letzter Runde:', extraGuidance.trim());
  }

  return {
    system:
      'Antworte ausschließlich mit JSON, exakt nach Level-Schema. Keine Kommentare, kein Markdown.',
    user: userParts.join('\n'),
  };
}

function extractJson(text: string): string | null {
  try {
    JSON.parse(text);
    return text;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function createSignature(level: LevelShape): string {
  const core = stringify({
    tiles: level.tiles,
    moving: level.moving ?? [],
    enemies: level.enemies ?? [],
    exit: level.exit,
  });
  const hash = createHash('sha1');
  hash.update(core);
  return hash.digest('hex');
}

async function isDuplicate(signature: string): Promise<boolean> {
  const key = `sig:level:${signature}`;
  const redis = getRedisClient();
  const existing = await redis.get(key);
  return Boolean(existing);
}

async function rememberSignature(signature: string, levelId: string): Promise<void> {
  const key = `sig:level:${signature}`;
  const redis = getRedisClient();
  await redis.set(key, levelId, 'EX', GEN_SIMHASH_TTL_SEC);
}

async function callModel(prompt: PromptFragments, logger: Logger) {
  const openai = getOpenAIClient();
  const response = await openai.responses.create({
    model: getModel(),
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: prompt.system }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt.user }],
      },
    ],
    temperature: 0.35,
    max_output_tokens: 2048,
  });

  const text = response.output_text ?? '';
  const usage = response.usage ?? undefined;
  if (usage) {
    const guardResult = await trackAndCheck({
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
    logger.info(
      {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        remainingUsd: Number(guardResult.remainingUsd.toFixed(4)),
      },
      'OpenAI usage recorded',
    );
    if (!guardResult.ok) {
      throw new Error('budget_exceeded');
    }
  }
  return text;
}

export async function generateLevel(
  seed: string,
  difficulty: number,
  abilities: AbilityT | undefined,
  logger: Logger,
  levelNumber?: number,
  seasonId?: string,
): Promise<LevelShape> {
  if (!cfg.openaiKey) {
    const error = new Error('missing_openai_key');
    (error as Error & { code?: string }).code = 'missing_openai_key';
    throw error;
  }

  const plan = getLevelPlan(levelNumber ?? 1);
  const parsedAbilities = AbilitySchema.parse(abilities ?? plan.abilities);
  const planConstraints: GenerationConstraints = {
    ...DEFAULT_CONSTRAINTS,
    maxGapPX: plan.constraints.maxGapPX,
    minPlatformWidthPX: plan.constraints.minPlatformWidthPX,
    maxStepUpPX: plan.constraints.maxStepUpPX,
  };
  const { biome, params: biomeParams } = getBiome(plan.levelNumber);
  const allowedPatterns = allowedEnemyPatternsForLevel(plan.levelNumber);
  const hazardWindow = hazardWindowForLevel(plan.levelNumber);
  let guidance = '';

  for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS; attempt += 1) {
    const attemptSeed = attempt === 0 ? seed : `${seed}-${attempt}`;
    const prompt = makePrompt(attemptSeed, difficulty, parsedAbilities, planConstraints, guidance, {
      levelNumber: plan.levelNumber,
      difficultyTarget: plan.difficultyTarget,
      difficultyBand: plan.difficultyBand,
      limits: {
        movingMax: plan.constraints.movingMax,
        enemyMax: plan.constraints.enemyMax,
        hazardMax: plan.constraints.hazardMax,
        jetpack: plan.constraints.jetpack,
      },
      seasonId,
      biome: { name: biome, params: biomeParams },
      enemyPatterns: allowedPatterns,
      hazardWindow,
    });

    try {
      logger.debug({ attempt: attempt + 1, seed: attemptSeed }, 'Generating level from model');
      const raw = await callModel(prompt, logger);
      const candidateJson = extractJson(raw);
      if (!candidateJson) {
        throw new ParseError('Antwort konnte nicht als JSON extrahiert werden.', raw);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(candidateJson);
      } catch {
        throw new ParseError('Antwort enthielt ungültiges JSON.', candidateJson);
      }

      const parsedObject =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

      const candidateLevel = Level.parse({
        ...parsedObject,
        id: `lvl-${attemptSeed}-${Date.now()}`,
        seed: attemptSeed,
        rules: {
          duration_target_s: planConstraints.targetDurationSec,
          difficulty,
          abilities: parsedAbilities,
          ...(typeof parsedObject.rules === 'object' && parsedObject.rules !== null
            ? (parsedObject.rules as Record<string, unknown>)
            : {}),
        },
      });

      if (candidateLevel.rules.difficulty !== difficulty) {
        candidateLevel.rules.difficulty = difficulty;
      }
      candidateLevel.rules.abilities = parsedAbilities;
      candidateLevel.rules.duration_target_s = planConstraints.targetDurationSec;
      candidateLevel.seed = attemptSeed;

      const enemyCount = candidateLevel.enemies?.length ?? 0;
      if (
        typeof plan.constraints.enemyMax === 'number' &&
        enemyCount > plan.constraints.enemyMax
      ) {
        guidance = `Zu viele Gegner (${enemyCount}) gegenüber Maximum ${plan.constraints.enemyMax}. Reduziere die Anzahl.`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const disallowedPatterns = (candidateLevel.enemies ?? []).filter(
        (enemy) => !allowedPatterns.includes(enemy.pattern as EnemyPattern),
      );
      if (disallowedPatterns.length > 0) {
        const used = Array.from(new Set(disallowedPatterns.map((enemy) => enemy.pattern)));
        guidance = `Unzulässige Gegner-Muster gefunden (${used.join(', ')}). Erlaubt sind: ${allowedPatterns.join(', ')}.`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const hazardCount = candidateLevel.tiles.filter((tile) => tile.type === 'hazard').length;
      if (
        typeof plan.constraints.hazardMax === 'number' &&
        hazardCount > plan.constraints.hazardMax
      ) {
        guidance = `Gefahren überschreiten das Limit (${hazardCount} > ${plan.constraints.hazardMax}). Bitte reduzieren.`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const movingCount = candidateLevel.moving?.length ?? 0;
      if (
        typeof plan.constraints.movingMax === 'number' &&
        movingCount > plan.constraints.movingMax
      ) {
        guidance = `Zu viele bewegliche Elemente (${movingCount} > ${plan.constraints.movingMax}).`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const invalidWindow = (candidateLevel.moving ?? []).find((entry) => {
        if (typeof entry.open_ms !== 'number') {
          return false;
        }
        if (entry.open_ms < hazardWindow.minOpenMs) {
          return true;
        }
        const [minPeriod, maxPeriod] = hazardWindow.periodRange;
        return entry.period_ms < minPeriod || entry.period_ms > maxPeriod;
      });

      if (invalidWindow) {
        const [minPeriod, maxPeriod] = hazardWindow.periodRange;
        guidance = `Hazard-Fenster zu knapp oder period_ms außerhalb Range. Stelle open_ms >= ${hazardWindow.minOpenMs} und period_ms ${minPeriod}-${maxPeriod} sicher.`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const score = scoreLevel(candidateLevel);
      if (!withinBand(score, plan.difficultyBand)) {
        const direction = score < plan.difficultyTarget ? 'erhöhe' : 'reduziere';
        guidance = `Schwierigkeitsscore ${score.toFixed(1)} außerhalb Zielband ${plan.difficultyBand[0]}-${plan.difficultyBand[1]} (Ziel ${plan.difficultyTarget}). Bitte ${direction} die Schwierigkeit durch Anpassungen an Lücken, Gegnern, beweglichen Plattformen oder Gefahren.`;
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        await delay(250);
        continue;
      }

      const signature = createSignature(candidateLevel);
      if (await isDuplicate(signature)) {
        guidance =
          'Vorherige Ausgabe duplizierte ein existierendes Layout. Variiere Struktur und Plattform-Anordnung.';
        logger.debug({ attempt: attempt + 1, guidance }, 'Guidance issued');
        continue;
      }

      await rememberSignature(signature, candidateLevel.id);
      logger.info({ attempt: attempt + 1, levelId: candidateLevel.id }, 'Generated level candidate');
      return candidateLevel;
    } catch (error) {
      if (error instanceof ParseError) {
        guidance =
          'Die letzte Antwort war kein gültiges JSON. Gib ausschließlich gültiges JSON zurück.';
        logger.warn({ attempt: attempt + 1, guidance }, 'Parse error guidance issued');
        await delay(250);
        continue;
      }
      if (error instanceof z.ZodError) {
        guidance = `Schema-Fehler: ${error.issues.map((issue) => issue.message).join('; ')}`;
        logger.warn({ attempt: attempt + 1, guidance }, 'Schema validation failed');
        await delay(250);
        continue;
      }
      throw error;
    }
  }

  logger.error({ attempts: GEN_MAX_ATTEMPTS, seed, difficulty }, 'Exhausted generation attempts');
  throw new Error('Keine gültige Level-Antwort nach maximalen Versuchen erhalten');
}

export async function closeGenerator(): Promise<void> {
  await closeClients();
}
