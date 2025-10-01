import Phaser from 'phaser';

import { LevelT } from '@ir/game-spec';

import { RUNNER_CONSTANTS } from '../types/game';
import { fetchLevel } from '../level/loader';

const DEFAULT_WORLD_HEIGHT = 720;
const EXIT_WIDTH = 40;
const EXIT_HEIGHT = 80;
const PLAYER_START_OFFSET_Y = 140;

type StaticSprite = Phaser.Physics.Arcade.Sprite & {
  body: Phaser.Physics.Arcade.StaticBody;
};

type DynamicSprite = Phaser.Physics.Arcade.Sprite & {
  body: Phaser.Physics.Arcade.Body;
};

export class GameScene extends Phaser.Scene {
  private levelData!: LevelT;
  private worldWidth = 0;
  private worldHeight = DEFAULT_WORLD_HEIGHT;

  private player!: DynamicSprite;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private exitZone!: StaticSprite;

  private hudText!: Phaser.GameObjects.Text;
  private pauseOverlay!: Phaser.GameObjects.Text;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private spaceKey!: Phaser.Input.Keyboard.Key;
  private pauseKey!: Phaser.Input.Keyboard.Key;
  private jumpKeys: Phaser.Input.Keyboard.Key[] = [];

  private lastGroundedAt = Number.NEGATIVE_INFINITY;
  private jumpBufferedAt = Number.NEGATIVE_INFINITY;

  private levelStartTime = 0;
  private pauseStartedAt = 0;
  private accumulatedPauseTime = 0;
  private isPaused = false;
  private isLevelReady = false;

  constructor() {
    super('game');
  }

  create(): void {
    this.isLevelReady = false;
    void this.initializeLevel();
  }

  private async initializeLevel(): Promise<void> {
    try {
      this.levelData = await fetchLevel('demo');

      this.setupInput();
      this.setupLevel();
      this.setupPlayer();
      this.setupCamera();
      this.setupHud();

      this.levelStartTime = this.time.now;
      this.pauseStartedAt = 0;
      this.accumulatedPauseTime = 0;
      this.isPaused = false;
      this.isLevelReady = true;
    } catch (error) {
      console.error('Level konnte nicht geladen werden:', error);
      this.isLevelReady = false;
    }
  }

  update(time: number): void {
    if (!this.isLevelReady) {
      return;
    }

    this.handlePauseToggle(time);
    this.updateHud(time);

    if (this.isPaused) {
      return;
    }

    this.processMovement(time);
    this.checkFailState();
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyA = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.pauseKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

    const maybeKeys: Array<Phaser.Input.Keyboard.Key | undefined> = [
      this.cursors.up,
      this.spaceKey,
    ];

    this.jumpKeys = maybeKeys.filter((key): key is Phaser.Input.Keyboard.Key => key !== undefined);
  }

  private setupLevel(): void {
    const { width, height } = this.computeWorldDimensions(this.levelData);
    this.worldWidth = width;
    this.worldHeight = height;

    this.physics.world.setBounds(0, 0, width, height);
    this.physics.world.setBoundsCollision(true, true, true, false);

    this.platforms = this.physics.add.staticGroup();
    this.hazards = this.physics.add.staticGroup();

    this.levelData.tiles.forEach((tile) => {
      if (tile.type === 'ground' || tile.type === 'platform') {
        this.spawnStaticTile(tile, 'platform', this.platforms);
      }

      if (tile.type === 'hazard') {
        this.spawnStaticTile(tile, 'hazard', this.hazards);
      }
    });

    const { exit } = this.levelData;
    const exitSprite = this.physics.add.staticSprite(
      exit.x + EXIT_WIDTH / 2,
      exit.y + EXIT_HEIGHT / 2,
      'exit',
    );
    exitSprite.setDisplaySize(EXIT_WIDTH, EXIT_HEIGHT).refreshBody();
    this.exitZone = exitSprite as StaticSprite;
  }

  private setupPlayer(): void {
    const startX = 120;
    const startY = this.getGroundBaselineY() - PLAYER_START_OFFSET_Y;

    const player = this.physics.add.sprite(startX, startY, 'player');
    player.setBounce(0);
    player.setCollideWorldBounds(true);
    player.setDepth(5);
    player.setDragX(1200);
    player.setMaxVelocity(
      RUNNER_CONSTANTS.moveSpeed,
      Math.abs(RUNNER_CONSTANTS.jumpVelocity) * 1.5,
    );

    const body = player.body as Phaser.Physics.Arcade.Body;
    body.setSize(player.width * 0.6, player.height);
    body.setOffset(player.width * 0.2, 0);

    this.player = player as DynamicSprite;

    this.physics.add.collider(this.player, this.platforms);
    this.physics.add.overlap(this.player, this.hazards, () => this.restartLevel(), undefined, this);
    this.physics.add.overlap(
      this.player,
      this.exitZone,
      () => this.completeLevel(),
      undefined,
      this,
    );
  }

  private setupCamera(): void {
    const camera = this.cameras.main;
    camera.setBounds(0, 0, this.worldWidth, this.worldHeight);
    camera.setBackgroundColor(0x0f172a);
    camera.startFollow(this.player, true, 0.12, 0.12);
    camera.setDeadzone(200, 120);
    camera.setRoundPixels(true);
  }

  private setupHud(): void {
    this.hudText = this.add
      .text(16, 16, '', {
        fontSize: '20px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setScrollFactor(0)
      .setDepth(100);

    this.pauseOverlay = this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'PAUSE', {
        fontSize: '48px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(200)
      .setVisible(false);
  }

  private processMovement(time: number): void {
    const body = this.player.body;
    if (!body) {
      return;
    }

    this.captureJumpBuffer(time);

    const bodyCast = body as Phaser.Physics.Arcade.Body;
    const moveLeft = (this.cursors.left?.isDown ?? false) || this.keyA.isDown;
    const moveRight = (this.cursors.right?.isDown ?? false) || this.keyD.isDown;

    if (moveLeft && !moveRight) {
      bodyCast.setVelocityX(-RUNNER_CONSTANTS.moveSpeed);
      this.player.setFlipX(true);
    } else if (moveRight && !moveLeft) {
      bodyCast.setVelocityX(RUNNER_CONSTANTS.moveSpeed);
      this.player.setFlipX(false);
    } else {
      bodyCast.setVelocityX(0);
    }

    const onGround = bodyCast.blocked.down || bodyCast.touching.down;
    if (onGround) {
      this.lastGroundedAt = time;
    }

    const canCoyote = time - this.lastGroundedAt <= RUNNER_CONSTANTS.coyoteTimeMs;
    const jumpBuffered = time - this.jumpBufferedAt <= RUNNER_CONSTANTS.jumpBufferMs;

    if (jumpBuffered && (onGround || canCoyote)) {
      bodyCast.setVelocityY(RUNNER_CONSTANTS.jumpVelocity);
      this.jumpBufferedAt = Number.NEGATIVE_INFINITY;
      this.lastGroundedAt = Number.NEGATIVE_INFINITY;
    }
  }

  private captureJumpBuffer(time: number): void {
    for (const key of this.jumpKeys) {
      if (Phaser.Input.Keyboard.JustDown(key)) {
        this.jumpBufferedAt = time;
      }
    }
  }

  private checkFailState(): void {
    if (this.player.y > this.worldHeight + 200) {
      this.restartLevel();
    }
  }

  private restartLevel(): void {
    this.isLevelReady = false;
    this.scene.restart();
  }

  private completeLevel(): void {
    const elapsed = this.getElapsedSeconds(this.time.now);
    console.info(`Level geschafft in ${elapsed.toFixed(2)}s`);
    this.isLevelReady = false;
    this.scene.restart();
  }

  private handlePauseToggle(time: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.pauseKey)) {
      this.isPaused = !this.isPaused;

      if (this.isPaused) {
        this.pauseStartedAt = time;
        this.physics.world.pause();
      } else {
        this.accumulatedPauseTime += time - this.pauseStartedAt;
        this.physics.world.resume();
      }

      this.pauseOverlay.setVisible(this.isPaused);
    }
  }

  private updateHud(time: number): void {
    const elapsed = this.getElapsedSeconds(time);
    this.hudText.setText(`Level: ${this.levelData.id}\nTime: ${elapsed.toFixed(2)}s`);
  }

  private getElapsedSeconds(time: number): number {
    if (this.isPaused) {
      const pauseEffectiveStart = this.pauseStartedAt || time;
      return (pauseEffectiveStart - this.levelStartTime - this.accumulatedPauseTime) / 1000;
    }

    return (time - this.levelStartTime - this.accumulatedPauseTime) / 1000;
  }

  private computeWorldDimensions(level: LevelT): { width: number; height: number } {
    const maxTileX = level.tiles.reduce((max, tile) => Math.max(max, tile.x + tile.w), 0);
    const maxTileY = level.tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);

    const width = Math.max(maxTileX, level.exit.x + EXIT_WIDTH) + 200;
    const height = Math.max(DEFAULT_WORLD_HEIGHT, maxTileY + 100, level.exit.y + EXIT_HEIGHT + 100);

    return { width, height };
  }

  private getGroundBaselineY(): number {
    const groundTiles = this.levelData.tiles.filter((tile) => tile.type === 'ground');
    const tilesToConsider = groundTiles.length > 0 ? groundTiles : this.levelData.tiles;

    if (tilesToConsider.length === 0) {
      return DEFAULT_WORLD_HEIGHT - 100;
    }

    return tilesToConsider.reduce((maxY, tile) => Math.max(maxY, tile.y), tilesToConsider[0].y);
  }

  private spawnStaticTile(
    tile: LevelT['tiles'][number],
    texture: string,
    group: Phaser.Physics.Arcade.StaticGroup,
  ): void {
    const sprite = group.create(tile.x + tile.w / 2, tile.y + tile.h / 2, texture) as StaticSprite;
    sprite.setDisplaySize(tile.w, tile.h);
    sprite.refreshBody();
  }
}
