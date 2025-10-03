import { beforeEach, describe, expect, it, vi } from 'vitest';

const progressMocks = vi.hoisted(() => ({
  saveProgress: vi.fn(),
  clearProgress: vi.fn(),
}));

const { saveProgress, clearProgress } = progressMocks;

vi.mock('../level/progress', () => progressMocks);

vi.mock('../level/loader', () => ({
  fetchApproved: vi.fn(),
  fetchLevel: vi.fn(),
  fetchLevelMeta: vi.fn(),
  fetchLevelPath: vi.fn(),
  fetchSeasonLevels: vi.fn(),
}));

const PhaserStub = vi.hoisted(() => {
  class Scene {
    scene = {
      restart: vi.fn(),
      launch: vi.fn(),
      isActive: vi.fn(() => true),
    };
    physics = {
      world: { setBoundsCollision: vi.fn(), pause: vi.fn(), resume: vi.fn() },
      add: {
        overlap: vi.fn(),
        collider: vi.fn(),
        staticGroup: vi.fn(() => ({ create: vi.fn() })),
        staticSprite: vi.fn(() => ({ setDisplaySize: vi.fn().mockReturnThis(), refreshBody: vi.fn(), setTint: vi.fn() })),
      },
    };
    time = { now: 0 };
    cameras = {
      main: {
        setBounds: vi.fn(),
        setBackgroundColor: vi.fn(),
        startFollow: vi.fn(),
        setDeadzone: vi.fn(),
        setRoundPixels: vi.fn(),
      },
    };
    add = {
      text: vi.fn(() => ({
        setScrollFactor: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setOrigin: vi.fn().mockReturnThis(),
        setVisible: vi.fn().mockReturnThis(),
        setText: vi.fn().mockReturnThis(),
      })),
      rectangle: vi.fn(() => ({
        setScrollFactor: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setFillStyle: vi.fn().mockReturnThis(),
        setVisible: vi.fn().mockReturnThis(),
      })),
      container: vi.fn(() => ({
        setScrollFactor: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setVisible: vi.fn().mockReturnThis(),
        add: vi.fn(),
      })),
    };
    input = {
      keyboard: {
        createCursorKeys: vi.fn(() => ({})),
        addKey: vi.fn(() => ({ isDown: false })),
      },
    };
    events = { once: vi.fn() };
  }

  const Math = {
    Clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    Linear: (start: number, end: number, t: number) => start + (end - start) * t,
  };

  const Display = {
    Color: {
      IntegerToRGB: (color: number) => ({
        r: (color >> 16) & 0xff,
        g: (color >> 8) & 0xff,
        b: color & 0xff,
      }),
      GetColor: (r: number, g: number, b: number) => (r << 16) | (g << 8) | b,
    },
  };

  const Input = { Keyboard: { JustDown: () => false } };

  const Physics = {
    Arcade: {
      StaticGroup: class {},
      Sprite: class {},
      StaticBody: class {},
      Body: class {},
    },
  };

  const Types = { Input: { Keyboard: {} } };
  const Scenes = { Events: { SHUTDOWN: 'shutdown', DESTROY: 'destroy' } };

  const stub = { Scene, Math, Display, Input, Physics, Types, Scenes };
  return stub;
});

vi.mock('phaser', () => ({ default: PhaserStub, ...PhaserStub }));

import { GameScene } from './GameScene';

describe('GameScene completion', () => {
  beforeEach(() => {
    saveProgress.mockClear();
    clearProgress.mockClear();
  });

  it('saves progress and does not restart after completion', () => {
    const scene = new GameScene();
    const hazardDestroy = vi.fn();

    // @ts-expect-error - accessing private fields for testing
    scene.pendingNextLevel = { levelNumber: 2, levelId: 'lvl-2', title: 'Next' };
    // @ts-expect-error - testing internal state
    scene.hazardOverlap = { destroy: hazardDestroy };
    // @ts-expect-error - testing internal state
    scene.time.now = 5000;
    // @ts-expect-error - testing internal state
    scene.levelStartTime = 0;
    // @ts-expect-error - testing internal state
    scene.accumulatedPauseTime = 0;
    // @ts-expect-error - testing internal state
    scene.isPaused = false;

    scene['completeLevel']();

    const launchMock = scene.scene.launch as ReturnType<typeof vi.fn>;
    const restartMock = scene.scene.restart as ReturnType<typeof vi.fn>;

    expect(scene['completed']).toBe(true);
    expect(hazardDestroy).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith({ levelNumber: 2, levelId: 'lvl-2' });
    expect(launchMock).toHaveBeenCalledTimes(1);

    scene['restartLevel']();
    expect(restartMock).not.toHaveBeenCalled();

    scene['completeLevel']();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
