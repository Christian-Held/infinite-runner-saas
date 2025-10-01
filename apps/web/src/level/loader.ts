import { Level, LevelT } from '@ir/game-spec';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const LOCAL_DEMO_LEVEL: LevelT = {
  id: 'demo-01',
  seed: 'demo',
  rules: {
    abilities: {
      run: true,
      jump: true,
    },
    duration_target_s: 60,
    difficulty: 1,
  },
  tiles: [
    { x: 0, y: 620, w: 1200, h: 40, type: 'ground' },
    { x: 1350, y: 560, w: 220, h: 24, type: 'platform' },
    { x: 1700, y: 520, w: 220, h: 24, type: 'platform' },
    { x: 2050, y: 480, w: 220, h: 24, type: 'platform' },
    { x: 2500, y: 620, w: 800, h: 40, type: 'ground' },
    { x: 3450, y: 560, w: 220, h: 24, type: 'platform' },
    { x: 1200, y: 600, w: 120, h: 20, type: 'hazard' },
    { x: 3300, y: 600, w: 120, h: 20, type: 'hazard' },
  ],
  moving: [],
  items: [],
  enemies: [],
  checkpoints: [],
  exit: { x: 3800, y: 560 },
};

export async function fetchLevel(id: string): Promise<LevelT> {
  const url = `${API_BASE_URL}/levels/${id}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load level: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const level = Level.parse(payload);
    console.info(`Level validiert: ${level.id}`);
    return level;
  } catch (error) {
    console.warn(`Konnte Level ${id} nicht laden, verwende Fallback.`, error);
    const level = Level.parse(LOCAL_DEMO_LEVEL);
    console.info(`Level validiert: ${level.id}`);
    return level;
  }
}
