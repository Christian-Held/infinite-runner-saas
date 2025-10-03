import Phaser from 'phaser';

import { RUNNER_CONSTANTS } from '../types/game';
import type { InputCmd } from '../level/loader';

type GhostSprite = Phaser.Physics.Arcade.Sprite & {
  body: Phaser.Physics.Arcade.Body;
};

interface GhostState {
  left: boolean;
  right: boolean;
  jump: boolean;
  fly: boolean;
  thrust: boolean;
}

export interface GhostPlayback {
  sprite: GhostSprite;
  stop(): void;
}

export function playGhost(
  scene: Phaser.Scene,
  playerSprite: Phaser.Physics.Arcade.Sprite,
  path: InputCmd[] | null,
): GhostPlayback | null {
  if (!Array.isArray(path) || path.length === 0) {
    return null;
  }

  const commands = [...path].sort((a, b) => a.t - b.t);
  const ghost = scene.physics.add.sprite(
    playerSprite.x,
    playerSprite.y,
    playerSprite.texture.key,
  ) as GhostSprite;

  ghost.setDepth(Math.max(0, playerSprite.depth - 1));
  ghost.setAlpha(0.4);
  ghost.setTint(0xffffff);
  ghost.setCollideWorldBounds(true);
  ghost.body.allowGravity = true;
  ghost.body.setAllowGravity(true);
  ghost.body.setImmovable(false);
  ghost.body.checkCollision.up = true;
  ghost.body.checkCollision.down = true;
  ghost.body.checkCollision.left = true;
  ghost.body.checkCollision.right = true;

  const playerBody = playerSprite.body as Phaser.Physics.Arcade.Body | null;
  if (playerBody) {
    ghost.body.setSize(playerBody.width, playerBody.height);
    ghost.body.setOffset(playerBody.offset.x, playerBody.offset.y);
  }

  const state: GhostState = {
    left: false,
    right: false,
    jump: false,
    fly: false,
    thrust: false,
  };

  let timer: Phaser.Time.TimerEvent | null = null;
  let tick = 0;
  let commandIndex = 0;
  let wasJumping = false;
  const lastTick = commands[commands.length - 1]?.t ?? 0;

  const applyState = () => {
    const body = ghost.body;
    if (!body) {
      return;
    }

    if (state.left && !state.right) {
      body.setVelocityX(-RUNNER_CONSTANTS.moveSpeed);
      ghost.setFlipX(true);
    } else if (state.right && !state.left) {
      body.setVelocityX(RUNNER_CONSTANTS.moveSpeed);
      ghost.setFlipX(false);
    } else {
      body.setVelocityX(0);
    }

    const wantsJump = state.jump || state.fly || state.thrust;
    const grounded = body.blocked.down || body.touching.down;
    if (wantsJump && grounded && !wasJumping) {
      body.setVelocityY(RUNNER_CONSTANTS.jumpVelocity);
    }
    wasJumping = wantsJump;
  };

  const step = () => {
    while (commandIndex < commands.length && commands[commandIndex].t <= tick) {
      const command = commands[commandIndex];
      if (typeof command.left === 'boolean') {
        state.left = command.left;
      }
      if (typeof command.right === 'boolean') {
        state.right = command.right;
      }
      if (typeof command.jump === 'boolean') {
        state.jump = command.jump;
      }
      if (typeof command.fly === 'boolean') {
        state.fly = command.fly;
      }
      if (typeof command.thrust === 'boolean') {
        state.thrust = command.thrust;
      }
      commandIndex += 1;
    }

    applyState();
    tick += 1;

    if (tick > lastTick + 120) {
      stop();
    }
  };

  const stop = () => {
    if (timer) {
      timer.remove(false);
      timer = null;
    }
    if (!ghost.scene) {
      return;
    }
    ghost.destroy();
  };

  scene.time.delayedCall(500, () => {
    if (!ghost.active) {
      return;
    }
    timer = scene.time.addEvent({
      delay: 1000 / 30,
      loop: true,
      callback: step,
    });
  });

  return {
    sprite: ghost,
    stop,
  };
}
