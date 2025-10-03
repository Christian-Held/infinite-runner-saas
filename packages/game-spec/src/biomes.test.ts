import { describe, expect, it } from 'vitest';

import { getBiome, getBiomeByName, listBiomes } from './biomes';

describe('biomes', () => {
  it('cycles through biomes by level number', () => {
    expect(getBiome(1).biome).toBe('meadow');
    expect(getBiome(6).biome).toBe('meadow');
    expect(getBiome(Number.POSITIVE_INFINITY).biome).toBe('meadow');
  });

  it('looks up biomes by name with defensive copies', () => {
    const sky = getBiomeByName('sky');
    expect(sky.biome).toBe('sky');
    sky.params.palette.bg = 0x000000;
    const original = getBiomeByName('sky');
    expect(original.params.palette.bg).not.toBe(0x000000);
  });

  it('lists all biomes without sharing references', () => {
    const firstList = listBiomes();
    firstList[0].params.palette.bg = 0x111111;
    const secondList = listBiomes();
    expect(secondList[0].params.palette.bg).not.toBe(0x111111);
    expect(secondList).toHaveLength(firstList.length);
  });
});
