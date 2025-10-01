import Phaser from 'phaser';

import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { RUNNER_CONSTANTS } from './types/game';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 960,
    height: 540,
  },
  pixelArt: true,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: RUNNER_CONSTANTS.gravityY },
      debug: false,
    },
  },
  fps: {
    target: 60,
    forceSetTimeOut: true,
    smoothStep: true,
  },
  scene: [BootScene, GameScene],
};

// eslint-disable-next-line no-new
new Phaser.Game(config);
