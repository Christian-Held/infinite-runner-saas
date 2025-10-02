export interface LevelProgress {
  levelNumber: number;
  levelId: string | null;
}

const STORAGE_KEY = 'ir:season1:progress';

export function loadProgress(): LevelProgress | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const levelNumber = Number(record.levelNumber ?? record.level_number);
    if (!Number.isFinite(levelNumber)) {
      return null;
    }

    const levelIdValue = record.levelId ?? record.level_id;
    const levelId = typeof levelIdValue === 'string' ? levelIdValue : null;

    return {
      levelNumber: Math.max(1, Math.round(levelNumber)),
      levelId,
    } satisfies LevelProgress;
  } catch (error) {
    console.warn('Konnte Spielfortschritt nicht laden.', error);
    return null;
  }
}

export function saveProgress(progress: LevelProgress): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const payload = JSON.stringify(progress);
    window.localStorage.setItem(STORAGE_KEY, payload);
  } catch (error) {
    console.warn('Konnte Spielfortschritt nicht speichern.', error);
  }
}

export function clearProgress(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Konnte Spielfortschritt nicht zurücksetzen.', error);
  }
}
