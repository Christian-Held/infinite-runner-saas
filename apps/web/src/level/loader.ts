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

export interface LevelSummary {
  id: string;
  title: string;
  seasonId: string | null;
  levelNumber: number | null;
}

export type InputCmd = {
  t: number;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  fly?: boolean;
  thrust?: boolean;
};

export interface SeasonLevelEntry {
  seasonId: string;
  levelNumber: number;
  status: string;
  levelId: string | null;
  published: boolean;
  score: number | null;
}

function logLoaderError(message: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(message, error.message);
    return;
  }
  console.error(message, error);
}

function parseLevelSummary(raw: unknown): LevelSummary | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const idCandidate = data.id ?? data.levelId ?? data.level_id;
  if (typeof idCandidate !== 'string' || idCandidate.length === 0) {
    return null;
  }

  const nameCandidate = data.title ?? data.name ?? data.slug ?? `Level ${idCandidate}`;
  const title = typeof nameCandidate === 'string' ? nameCandidate : `Level ${idCandidate}`;

  const rawSeason = data.seasonId ?? data.season_id ?? null;
  const seasonId = typeof rawSeason === 'string' ? rawSeason : null;

  const rawNumber = data.levelNumber ?? data.level_number ?? null;
  const levelNumber =
    typeof rawNumber === 'number' && Number.isFinite(rawNumber)
      ? Math.max(1, Math.round(rawNumber))
      : null;

  return { id: idCandidate, title, seasonId, levelNumber } satisfies LevelSummary;
}

export async function fetchApproved(
  options: { limit?: number; offset?: number } = {},
): Promise<LevelSummary[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('published', 'true');
  if (typeof options.limit === 'number') {
    searchParams.set('limit', String(Math.max(1, Math.floor(options.limit))));
  }
  if (typeof options.offset === 'number') {
    searchParams.set('offset', String(Math.max(0, Math.floor(options.offset))));
  }

  const url = `${API_BASE_URL}/levels?${searchParams.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const list: unknown[] = Array.isArray(payload?.levels)
      ? (payload.levels as unknown[])
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];

    const parsed = list
      .map((entry) => parseLevelSummary(entry))
      .filter((entry): entry is LevelSummary => entry !== null);

    if (parsed.length === 0) {
      return [
        { id: LOCAL_DEMO_LEVEL.id, title: 'Demo Level', seasonId: 'demo', levelNumber: 1 },
      ];
    }

    return parsed;
  } catch (error) {
    logLoaderError('Konnte Approved-Levels nicht laden, verwende Fallback.', error);
    return [{ id: LOCAL_DEMO_LEVEL.id, title: 'Demo Level', seasonId: 'demo', levelNumber: 1 }];
  }
}

export async function fetchLevel(id: string): Promise<LevelT> {
  const url = `${API_BASE_URL}/levels/${id}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const level = Level.parse(payload);
    console.info(`Level validiert: ${level.id}`);
    return level;
  } catch (error) {
    logLoaderError(`Konnte Level ${id} nicht laden, verwende Fallback.`, error);
    const level = Level.parse(LOCAL_DEMO_LEVEL);
    console.info(`Level validiert: ${level.id}`);
    return level;
  }
}

export async function fetchLevelPath(id: string): Promise<InputCmd[] | null> {
  const url = `${API_BASE_URL}/levels/${id}/path`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed with ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { path?: unknown };
    if (!Array.isArray(payload.path)) {
      return null;
    }

    return payload.path
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const t = Number(record.t);
        if (!Number.isFinite(t)) {
          return null;
        }
        const cmd: InputCmd = { t: Math.max(0, Math.round(t)) };
        if (typeof record.left === 'boolean') cmd.left = record.left;
        if (typeof record.right === 'boolean') cmd.right = record.right;
        if (typeof record.jump === 'boolean') cmd.jump = record.jump;
        if (typeof record.fly === 'boolean') cmd.fly = record.fly;
        if (typeof record.thrust === 'boolean') cmd.thrust = record.thrust;
        return cmd;
      })
      .filter((cmd): cmd is InputCmd => cmd !== null);
  } catch (error) {
    logLoaderError(`Konnte Ghost-Path für Level ${id} nicht laden.`, error);
    return null;
  }
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
      throw new Error(`Failed with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.levels)) {
      return [];
    }

    return (payload.levels as unknown[])
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const rawLevelNumber = Number(record.levelNumber ?? record.level_number ?? 0);
        const levelNumber = Number.isFinite(rawLevelNumber)
          ? Math.max(1, Math.round(rawLevelNumber))
          : 1;

        const levelIdCandidate =
          typeof record.levelId === 'string'
            ? record.levelId
            : typeof record.level_id === 'string'
              ? record.level_id
              : null;

        return {
          seasonId: typeof payload.seasonId === 'string' ? payload.seasonId : seasonId,
          levelNumber,
          status: String(record.status ?? 'queued'),
          levelId: levelIdCandidate,
          published: Boolean(record.published),
          score: typeof record.score === 'number' ? record.score : null,
        } satisfies SeasonLevelEntry;
      })
      .filter((entry): entry is SeasonLevelEntry => entry !== null);
  } catch (error) {
    logLoaderError(`Konnte Season-Level-Liste für ${seasonId} nicht laden.`, error);
    return [];
  }
}
