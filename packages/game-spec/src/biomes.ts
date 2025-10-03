export type Biome = 'meadow' | 'cave' | 'factory' | 'lava' | 'sky';

export interface BiomeParams {
  palette: {
    bg: number;
    platform: number;
    hazard: number;
    accent: number;
  };
  friction: number;
  ambientHazardBias: number;
  movingBias: number;
}

interface BiomeEntry {
  biome: Biome;
  params: BiomeParams;
}

const BIOME_SEQUENCE: BiomeEntry[] = [
  {
    biome: 'meadow',
    params: {
      palette: {
        bg: 0xbfe4ff,
        platform: 0x347355,
        hazard: 0xf97316,
        accent: 0x1d4ed8,
      },
      friction: 0.4,
      ambientHazardBias: 0.2,
      movingBias: 0.15,
    },
  },
  {
    biome: 'cave',
    params: {
      palette: {
        bg: 0x1f2933,
        platform: 0x475569,
        hazard: 0x9333ea,
        accent: 0x22d3ee,
      },
      friction: 0.6,
      ambientHazardBias: 0.35,
      movingBias: 0.25,
    },
  },
  {
    biome: 'factory',
    params: {
      palette: {
        bg: 0x2d3036,
        platform: 0x6b7280,
        hazard: 0xf59e0b,
        accent: 0x0ea5e9,
      },
      friction: 0.5,
      ambientHazardBias: 0.45,
      movingBias: 0.4,
    },
  },
  {
    biome: 'lava',
    params: {
      palette: {
        bg: 0x2c0f16,
        platform: 0x7c2d12,
        hazard: 0xef4444,
        accent: 0xf97316,
      },
      friction: 0.3,
      ambientHazardBias: 0.55,
      movingBias: 0.5,
    },
  },
  {
    biome: 'sky',
    params: {
      palette: {
        bg: 0xdbeafe,
        platform: 0x0ea5e9,
        hazard: 0xf472b6,
        accent: 0x818cf8,
      },
      friction: 0.2,
      ambientHazardBias: 0.25,
      movingBias: 0.35,
    },
  },
];

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 1;
  }
  return Math.max(1, Math.round(level));
}

export function getBiome(level: number): BiomeEntry {
  const normalized = clampLevel(level);
  const index = (normalized - 1) % BIOME_SEQUENCE.length;
  const entry = BIOME_SEQUENCE[index];
  return {
    biome: entry.biome,
    params: {
      palette: { ...entry.params.palette },
      friction: entry.params.friction,
      ambientHazardBias: entry.params.ambientHazardBias,
      movingBias: entry.params.movingBias,
    },
  };
}

export function getBiomeByName(name: Biome): BiomeEntry {
  const entry = BIOME_SEQUENCE.find((candidate) => candidate.biome === name);
  if (entry) {
    return {
      biome: entry.biome,
      params: {
        palette: { ...entry.params.palette },
        friction: entry.params.friction,
        ambientHazardBias: entry.params.ambientHazardBias,
        movingBias: entry.params.movingBias,
      },
    };
  }
  return getBiome(1);
}

export function listBiomes(): BiomeEntry[] {
  return BIOME_SEQUENCE.map((entry) => ({
    biome: entry.biome,
    params: {
      palette: { ...entry.params.palette },
      friction: entry.params.friction,
      ambientHazardBias: entry.params.ambientHazardBias,
      movingBias: entry.params.movingBias,
    },
  }));
}
