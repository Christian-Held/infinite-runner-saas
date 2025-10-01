import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Ability, Level } from '@ir/game-spec';
import stringify from 'fast-json-stable-stringify';
import IORedis from 'ioredis';
import OpenAI from 'openai';
import seedrandom from 'seedrandom';
import { z } from 'zod';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_REQ_TIMEOUT_MS = Number(process.env.OPENAI_REQ_TIMEOUT_MS ?? '20000');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const GEN_MAX_ATTEMPTS = Number(process.env.GEN_MAX_ATTEMPTS ?? '3');
const GEN_SIMHASH_TTL_SEC = Number(process.env.GEN_SIMHASH_TTL_SEC ?? '604800');

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set');
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: OPENAI_REQ_TIMEOUT_MS,
});

const redis = new IORedis(REDIS_URL, {
  enableOfflineQueue: false,
});

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
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'ParseError';
  }
}

function buildMiniExample(seed: string, difficulty: number, abilities: AbilityT): string {
  const rng = seedrandom(`${seed}|${difficulty}`);
  const baseY = Math.round(rng() * 100) + 240;
  const platformWidth = DEFAULT_CONSTRAINTS.minPlatformWidthPX +
    Math.round(rng() * 32);
  const gap = Math.min(
    DEFAULT_CONSTRAINTS.maxGapPX - 10,
    Math.round(rng() * DEFAULT_CONSTRAINTS.maxGapPX * 0.6),
  );
  const secondHeight = baseY - Math.round(rng() * (DEFAULT_CONSTRAINTS.maxStepUpPX - 12));

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

  const example = buildMiniExample(seed, difficulty, abilities);

  const userParts = [
    `Seed: ${seed}`,
    `Schwierigkeit: ${difficulty}`,
    `Abilities: ${abilitySummary}`,
    'Constraints:',
    ...constraintLines,
    example,
  ];

  if (extraGuidance.trim().length > 0) {
    userParts.push('Feedback aus letzter Runde:', extraGuidance.trim());
  }

  return {
    system: 'Antworte ausschließlich mit JSON, exakt nach Level-Schema. Keine Kommentare, kein Markdown.',
    user: userParts.join('\n'),
  };
}

function extractJson(text: string): string | null {
  try {
    JSON.parse(text);
    return text;
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch (error_) {
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
  const existing = await redis.get(key);
  return Boolean(existing);
}

async function rememberSignature(signature: string, levelId: string): Promise<void> {
  const key = `sig:level:${signature}`;
  await redis.set(key, levelId, 'EX', GEN_SIMHASH_TTL_SEC);
}

async function callModel(prompt: PromptFragments) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
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
    console.info('[generator] usage', {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    });
  }
  return text;
}

export async function generateLevel(
  seed: string,
  difficulty: number,
  abilities: AbilityT,
): Promise<LevelShape> {
  const parsedAbilities = AbilitySchema.parse(abilities);
  let guidance = '';

  for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS; attempt += 1) {
    const attemptSeed = attempt === 0 ? seed : `${seed}-${attempt}`;
    const prompt = makePrompt(attemptSeed, difficulty, parsedAbilities, DEFAULT_CONSTRAINTS, guidance);

    try {
      const raw = await callModel(prompt);
      const candidateJson = extractJson(raw);
      if (!candidateJson) {
        throw new ParseError('Antwort konnte nicht als JSON extrahiert werden.', raw);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(candidateJson);
      } catch (error) {
        throw new ParseError('Antwort enthielt ungültiges JSON.', candidateJson);
      }

      const parsedObject =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

      const candidateLevel = Level.parse({
        ...parsedObject,
        id: `lvl-${attemptSeed}-${Date.now()}`,
        seed: attemptSeed,
        rules: {
          duration_target_s: DEFAULT_CONSTRAINTS.targetDurationSec,
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
      candidateLevel.rules.duration_target_s = DEFAULT_CONSTRAINTS.targetDurationSec;
      candidateLevel.seed = attemptSeed;

      const signature = createSignature(candidateLevel);
      if (await isDuplicate(signature)) {
        guidance = 'Vorherige Ausgabe duplizierte ein existierendes Layout. Variiere Struktur und Plattform-Anordnung.';
        continue;
      }

      await rememberSignature(signature, candidateLevel.id);
      return candidateLevel;
    } catch (error) {
      if (error instanceof ParseError) {
        guidance = 'Die letzte Antwort war kein gültiges JSON. Gib ausschließlich gültiges JSON zurück.';
        await delay(250);
        continue;
      }
      if (error instanceof z.ZodError) {
        guidance = `Schema-Fehler: ${error.issues.map((issue) => issue.message).join('; ')}`;
        await delay(250);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Keine gültige Level-Antwort nach maximalen Versuchen erhalten');
}

export async function closeGenerator(): Promise<void> {
  try {
    await redis.quit();
  } catch (error) {
    redis.disconnect();
  }
}
