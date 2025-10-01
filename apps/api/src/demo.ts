import { Ability, LevelT } from '@ir/game-spec';
import { z } from 'zod';

const BASE_TILES = [
  { x: 0, y: 620, w: 1200, h: 40, type: 'ground' as const },
  { x: 1350, y: 560, w: 220, h: 24, type: 'platform' as const },
  { x: 1700, y: 520, w: 220, h: 24, type: 'platform' as const },
  { x: 2050, y: 480, w: 220, h: 24, type: 'platform' as const },
  { x: 2500, y: 620, w: 800, h: 40, type: 'ground' as const },
  { x: 3450, y: 560, w: 220, h: 24, type: 'platform' as const },
  { x: 1200, y: 600, w: 120, h: 20, type: 'hazard' as const },
  { x: 3300, y: 600, w: 120, h: 20, type: 'hazard' as const },
];

type AbilityInput = z.input<typeof Ability>;

export function demoLevel(
  difficulty: number,
  seed: string,
  abilities: AbilityInput = { run: true, jump: true },
): LevelT {
  const parsedAbilities = Ability.parse(abilities);

  return {
    id: 'demo-template',
    seed,
    rules: {
      abilities: parsedAbilities,
      duration_target_s: 60,
      difficulty,
    },
    tiles: BASE_TILES,
    moving: [],
    items: [],
    enemies: [],
    checkpoints: [],
    exit: { x: 3800, y: 560 },
  };
}
