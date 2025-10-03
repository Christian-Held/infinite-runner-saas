import { z } from 'zod';

const Jetpack = z.object({
  fuel: z.number().int().min(0),
  thrust: z.number().gt(0),
});

export const Ability = z.object({
  run: z.literal(true),
  jump: z.literal(true),
  highJump: z.boolean().optional(),
  shortFly: z.boolean().optional(),
  jetpack: Jetpack.optional(),
});

const Tile = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().gt(0),
  h: z.number().gt(0),
  type: z.enum(['ground', 'platform', 'hazard', 'moving', 'enemy_spawner']),
});

const MovingPlatform = z.object({
  id: z.string(),
  from: z.tuple([z.number(), z.number()]),
  to: z.tuple([z.number(), z.number()]),
  period_ms: z.number().int().gt(0),
  phase: z.number().min(0).max(1),
  open_ms: z.number().int().gt(0).optional(),
});

const Item = z.object({
  x: z.number(),
  y: z.number(),
  kind: z.enum(['coin', 'fuel', 'key']),
});

const Enemy = z.object({
  x: z.number(),
  y: z.number(),
  pattern: z.enum(['patrol', 'chase', 'projectile']),
  speed: z.number().gt(0),
});

const Checkpoint = z.object({
  x: z.number(),
  y: z.number(),
});

const Exit = z.object({
  x: z.number(),
  y: z.number(),
});

export const Level = z.object({
  id: z.string(),
  seed: z.string(),
  rules: z.object({
    abilities: Ability,
    duration_target_s: z.number().int().gt(0),
    difficulty: z.number().int().gt(0),
  }),
  tiles: z.array(Tile),
  moving: z.array(MovingPlatform).default([]),
  items: z.array(Item).default([]),
  enemies: z.array(Enemy).default([]),
  checkpoints: z.array(Checkpoint).default([]),
  exit: Exit,
});

export type AbilityT = z.infer<typeof Ability>;
export type LevelT = z.infer<typeof Level>;

export * from './progression';
export * from './biomes';
