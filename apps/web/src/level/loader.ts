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

export interface SeasonLevelEntry {
  seasonId: string;
  levelNumber: number;
  status: string;
  levelId: string | null;
  published: boolean;
  score: number | null;
}

export async function fetchSeasonLevels(
  seasonId: string,
  options: { published?: boolean } = {},
): Promise<SeasonLevelEntry[]> {
  const searchParams = new URLSearchParams();
  if (typeof options.published === 'boolean') {
    searchParams.set('published', options.published ? 'true' : 'false');
  }

  const query = searchParams.toString();
  const url = `${API_BASE_URL}/seasons/${seasonId}/levels${query ? `?${query}` : ''}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load season levels: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.levels)) {
      return [];
    }

    return (payload.levels as unknown[]).map((entry) => {
      const record = entry as Record<string, unknown>;
      const rawLevelNumber = Number(record.levelNumber ?? record.level_number ?? 0);
      const levelNumber = Number.isFinite(rawLevelNumber)
        ? Math.max(1, Math.round(rawLevelNumber))
        : 1;

      const levelId =
        typeof record.levelId === 'string'
          ? (record.levelId as string)
          : typeof record.level_id === 'string'
            ? (record.level_id as string)
            : null;

      return {
        seasonId: typeof payload.seasonId === 'string' ? payload.seasonId : seasonId,
        levelNumber,
        status: String(record.status ?? 'queued'),
        levelId,
        published: Boolean(record.published),
        score: typeof record.score === 'number' ? (record.score as number) : null,
      } satisfies SeasonLevelEntry;
    });
  } catch (error) {
    console.warn(`Konnte Season-Level-Liste für ${seasonId} nicht laden.`, error);
    return [];
  }
}

export interface LevelPathEntry {
  t: number;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  fly?: boolean;
  thrust?: boolean;
}

export async function fetchLevelPath(id: string): Promise<LevelPathEntry[] | null> {
  const url = `${API_BASE_URL}/levels/${id}/path`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to load level path: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.path)) {
      return null;
    }
    return payload.path as LevelPathEntry[];
  } catch (error) {
    console.warn(`Konnte Ghost-Path für Level ${id} nicht laden.`, error);
    return null;
  }
}
