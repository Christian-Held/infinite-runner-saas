import Phaser from 'phaser';

import { LevelDefinition, RUNNER_CONSTANTS, RectangleSpec } from '../types/game';

const LEVEL_DATA: LevelDefinition = {
  name: 'Demo-01',
  world: { width: 4000, height: 720 },
  groundY: 620,
  platforms: [
    { x: 0, y: 620, w: 1200, h: 40 },
    { x: 1350, y: 560, w: 220, h: 24 },
    { x: 1700, y: 520, w: 220, h: 24 },
    { x: 2050, y: 480, w: 220, h: 24 },
    { x: 2500, y: 620, w: 800, h: 40 },
    { x: 3450, y: 560, w: 220, h: 24 },
  ],
  hazards: [
    { x: 1200, y: 600, w: 120, h: 20 },
    { x: 3300, y: 600, w: 120, h: 20 },
  ],
  exit: { x: 3800, y: 560, w: 40, h: 80 },
};

type StaticSprite = Phaser.Physics.Arcade.Sprite & {
  body: Phaser.Physics.Arcade.StaticBody;
};

type DynamicSprite = Phaser.Physics.Arcade.Sprite & {
  body: Phaser.Physics.Arcade.Body;
};

export class GameScene extends Phaser.Scene {
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

  constructor() {
    super('game');
  }

  create(): void {
    this.setupInput();
    this.setupLevel();
    this.setupPlayer();
    this.setupCamera();
    this.setupHud();

    this.levelStartTime = this.time.now;
    this.pauseStartedAt = 0;
    this.accumulatedPauseTime = 0;
    this.isPaused = false;
  }

  update(time: number): void {
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
    const { world } = LEVEL_DATA;
    this.physics.world.setBounds(0, 0, world.width, world.height);
    this.physics.world.setBoundsCollision(true, true, true, false);

    this.platforms = this.physics.add.staticGroup();
    LEVEL_DATA.platforms.forEach((platform) => this.spawnStaticTile(platform, 'platform', this.platforms));

    this.hazards = this.physics.add.staticGroup();
    LEVEL_DATA.hazards.forEach((hazard) => this.spawnStaticTile(hazard, 'hazard', this.hazards));

    const { exit } = LEVEL_DATA;
    const exitSprite = this.physics.add.staticSprite(exit.x + exit.w / 2, exit.y + exit.h / 2, 'exit');
    exitSprite.setDisplaySize(exit.w, exit.h).refreshBody();
    this.exitZone = exitSprite as StaticSprite;
  }

  private setupPlayer(): void {
    const startX = 120;
    const startY = LEVEL_DATA.groundY - 140;

    const player = this.physics.add.sprite(startX, startY, 'player');
    player.setBounce(0);
    player.setCollideWorldBounds(true);
    player.setDepth(5);
    player.setDragX(1200);
    player.setMaxVelocity(RUNNER_CONSTANTS.moveSpeed, Math.abs(RUNNER_CONSTANTS.jumpVelocity) * 1.5);

    const body = player.body as Phaser.Physics.Arcade.Body;
    body.setSize(player.width * 0.6, player.height);
    body.setOffset(player.width * 0.2, 0);

    this.player = player as DynamicSprite;

    this.physics.add.collider(this.player, this.platforms);
    this.physics.add.overlap(this.player, this.hazards, () => this.restartLevel(), undefined, this);
    this.physics.add.overlap(this.player, this.exitZone, () => this.completeLevel(), undefined, this);
  }

  private setupCamera(): void {
    const camera = this.cameras.main;
    const { width, height } = LEVEL_DATA.world;

    camera.setBounds(0, 0, width, height);
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
    if (this.player.y > LEVEL_DATA.world.height + 200) {
      this.restartLevel();
    }
  }

  private restartLevel(): void {
    this.scene.restart();
  }

  private completeLevel(): void {
    const elapsed = this.getElapsedSeconds(this.time.now);
    // eslint-disable-next-line no-console
    console.info(`Level geschafft in ${elapsed.toFixed(2)}s`);
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
    this.hudText.setText(`Level: ${LEVEL_DATA.name}\nTime: ${elapsed.toFixed(2)}s`);
  }

  private getElapsedSeconds(time: number): number {
    if (this.isPaused) {
      const pauseEffectiveStart = this.pauseStartedAt || time;
      return (pauseEffectiveStart - this.levelStartTime - this.accumulatedPauseTime) / 1000;
    }

    return (time - this.levelStartTime - this.accumulatedPauseTime) / 1000;
  }

  private spawnStaticTile(
    spec: RectangleSpec,
    texture: string,
    group: Phaser.Physics.Arcade.StaticGroup,
  ): void {
    const sprite = group.create(spec.x + spec.w / 2, spec.y + spec.h / 2, texture) as StaticSprite;
    sprite.setDisplaySize(spec.w, spec.h);
    sprite.refreshBody();
  }
}
