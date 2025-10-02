import Phaser from 'phaser';

import { LevelT } from '@ir/game-spec';

import { playGhost, type GhostPlayback } from '../game/Ghost';
import {
  fetchApproved,
  fetchLevel,
  fetchLevelPath,
  fetchSeasonLevels,
  type InputCmd,
  type LevelSummary,
  type SeasonLevelEntry,
} from '../level/loader';
import { clearProgress, saveProgress } from '../level/progress';
import { RUNNER_CONSTANTS } from '../types/game';

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

interface LevelTarget {
  levelNumber: number;
  levelId: string;
  title: string;
}

export interface GameSceneParams {
  levelNumber?: number;
  levelId?: string | null;
  seasonId?: string;
}

export class GameScene extends Phaser.Scene {
  private seasonId = 'season-1';
  private totalLevels = 100;
  private currentLevelNumber = 1;
  private currentLevelId: string | null = null;
  private currentLevelTitle = '';

  private levelData!: LevelT;
  private worldWidth = 0;
  private worldHeight = DEFAULT_WORLD_HEIGHT;

  private seasonEntries: SeasonLevelEntry[] = [];
  private approvedLevels: LevelSummary[] = [];
  private preloadedLevels = new Map<string, LevelT>();
  private pendingNextLevel: LevelTarget | null = null;

  private player!: DynamicSprite;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private exitZone!: StaticSprite;

  private platformCollider: Phaser.Physics.Arcade.Collider | null = null;
  private hazardOverlap: Phaser.Physics.Arcade.Collider | null = null;
  private exitOverlap: Phaser.Physics.Arcade.Collider | null = null;

  private ghostPlayback: GhostPlayback | null = null;
  private ghostCollider: Phaser.Physics.Arcade.Collider | null = null;

  private hudLevelText!: Phaser.GameObjects.Text;
  private hudTimerText!: Phaser.GameObjects.Text;
  private hudAbilitiesText!: Phaser.GameObjects.Text;
  private hudRetryText!: Phaser.GameObjects.Text;
  private loadingText!: Phaser.GameObjects.Text;
  private pauseOverlay!: Phaser.GameObjects.Container;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private spaceKey!: Phaser.Input.Keyboard.Key;
  private keyR!: Phaser.Input.Keyboard.Key;
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

  init(data: GameSceneParams): void {
    if (typeof data.seasonId === 'string' && data.seasonId.length > 0) {
      this.seasonId = data.seasonId;
    }

    if (typeof data.levelNumber === 'number' && Number.isFinite(data.levelNumber)) {
      this.currentLevelNumber = Math.max(1, Math.round(data.levelNumber));
    }

    if (typeof data.levelId === 'string') {
      this.currentLevelId = data.levelId;
    } else if (data.levelId === null) {
      this.currentLevelId = null;
    }
  }

  create(): void {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.dispose, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.dispose, this);

    this.setupInput();
    this.createHud();
    this.createPauseMenu();

    this.physics.world.setBoundsCollision(true, true, true, false);

    void this.initializeLevel();
  }

  update(time: number): void {
    if (!this.isLevelReady) {
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyR)) {
      this.restartLevel();
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

  private async initializeLevel(): Promise<void> {
    this.isLevelReady = false;
    this.showLoadingState(true);
    this.disposeLevelObjects();

    try {
      const target = await this.resolveCurrentLevelTarget();
      this.currentLevelNumber = target.levelNumber;
      const level = await this.obtainLevel(target.levelId);
      this.levelData = level;
      this.currentLevelId = target.levelId;
      this.currentLevelTitle = target.title;

      this.setupLevel();
      this.setupPlayer();
      this.setupCamera();

      this.levelStartTime = this.time.now;
      this.pauseStartedAt = 0;
      this.accumulatedPauseTime = 0;
      this.isPaused = false;
      this.isLevelReady = true;

      const ghostPromise = fetchLevelPath(level.id);
      void this.prefetchNextLevel(target.levelNumber);

      const path = await ghostPromise;
      this.startGhost(path);
    } catch (error) {
      console.error('Level konnte nicht geladen werden:', error);
      this.isLevelReady = false;
    } finally {
      this.showLoadingState(false);
    }
  }

  private dispose(): void {
    this.disposeLevelObjects();
    this.preloadedLevels.clear();
  }

  private disposeLevelObjects(): void {
    this.stopGhost();

    if (this.platformCollider) {
      this.platformCollider.destroy();
      this.platformCollider = null;
    }

    if (this.hazardOverlap) {
      this.hazardOverlap.destroy();
      this.hazardOverlap = null;
    }

    if (this.exitOverlap) {
      this.exitOverlap.destroy();
      this.exitOverlap = null;
    }

    if (this.ghostCollider) {
      this.ghostCollider.destroy();
      this.ghostCollider = null;
    }

    if (this.player) {
      this.player.destroy();
    }

    if (this.platforms) {
      this.platforms.clear(true, true);
      this.platforms.destroy(true);
    }

    if (this.hazards) {
      this.hazards.clear(true, true);
      this.hazards.destroy(true);
    }

    if (this.exitZone) {
      this.exitZone.destroy();
    }
  }

  private async resolveCurrentLevelTarget(): Promise<LevelTarget> {
    await this.ensureCatalogs();
    const desiredNumber = Math.max(1, this.currentLevelNumber);

    if (this.currentLevelId) {
      const title = this.findTitleForLevel(this.currentLevelId) ?? `Level ${desiredNumber}`;
      return { levelNumber: desiredNumber, levelId: this.currentLevelId, title };
    }

    const candidate = await this.resolveLevelTargetForNumber(desiredNumber);
    if (candidate) {
      return candidate;
    }

    return {
      levelNumber: desiredNumber,
      levelId: 'demo-01',
      title: 'Demo Level',
    };
  }

  private async resolveLevelTargetForNumber(levelNumber: number): Promise<LevelTarget | null> {
    await this.ensureCatalogs();

    const seasonCandidate = this.seasonEntries.find(
      (entry) => entry.levelNumber === levelNumber && typeof entry.levelId === 'string',
    );
    if (seasonCandidate?.levelId) {
      return {
        levelNumber,
        levelId: seasonCandidate.levelId,
        title: `Level ${seasonCandidate.levelNumber}`,
      };
    }

    const approvedCandidate = this.approvedLevels[levelNumber - 1] ?? this.approvedLevels[0];
    if (approvedCandidate) {
      return {
        levelNumber,
        levelId: approvedCandidate.id,
        title: approvedCandidate.title,
      };
    }

    return null;
  }

  private async ensureCatalogs(): Promise<void> {
    if (this.seasonEntries.length === 0) {
      const published = await fetchSeasonLevels(this.seasonId, { published: true });
      if (published.length > 0) {
        this.seasonEntries = published;
      }
    }

    if (this.approvedLevels.length === 0) {
      const approved = await fetchApproved({ limit: 100, offset: 0 });
      this.approvedLevels = approved;
    }
  }

  private findTitleForLevel(levelId: string): string | null {
    const approved = this.approvedLevels.find((entry) => entry.id === levelId);
    if (approved) {
      return approved.title;
    }
    return null;
  }

  private async obtainLevel(levelId: string): Promise<LevelT> {
    const cached = this.preloadedLevels.get(levelId);
    if (cached) {
      return cached;
    }

    const level = await fetchLevel(levelId);
    this.preloadedLevels.set(levelId, level);
    this.preloadedLevels.set(level.id, level);
    return level;
  }

  private async prefetchNextLevel(currentNumber: number): Promise<void> {
    const nextNumber = currentNumber + 1;
    const candidate = await this.resolveLevelTargetForNumber(nextNumber);
    if (!candidate) {
      this.pendingNextLevel = null;
      return;
    }

    this.pendingNextLevel = candidate;
    if (this.preloadedLevels.has(candidate.levelId)) {
      return;
    }

    try {
      const level = await fetchLevel(candidate.levelId);
      this.preloadedLevels.set(candidate.levelId, level);
      this.preloadedLevels.set(level.id, level);
    } catch (error) {
      console.warn('Konnte nächstes Level nicht vorladen.', error);
    }
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyA = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
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

    this.platformCollider = this.physics.add.collider(this.player, this.platforms);
    this.hazardOverlap = this.physics.add.overlap(
      this.player,
      this.hazards,
      () => this.restartLevel(),
      undefined,
      this,
    );
    this.exitOverlap = this.physics.add.overlap(
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

  private startGhost(path: InputCmd[] | null): void {
    this.stopGhost();
    if (!path || path.length === 0) {
      return;
    }

    const playback = playGhost(this, this.player, path);
    if (!playback) {
      return;
    }

    this.ghostPlayback = playback;
    this.ghostCollider = this.physics.add.collider(playback.sprite, this.platforms);
  }

  private stopGhost(): void {
    if (this.ghostCollider) {
      this.ghostCollider.destroy();
      this.ghostCollider = null;
    }

    if (this.ghostPlayback) {
      this.ghostPlayback.stop();
      this.ghostPlayback = null;
    }
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
    if (!this.scene.isActive()) {
      return;
    }

    this.isLevelReady = false;
    this.pendingNextLevel = null;
    this.scene.restart({
      seasonId: this.seasonId,
      levelNumber: this.currentLevelNumber,
      levelId: this.currentLevelId,
    });
  }

  private completeLevel(): void {
    const elapsed = this.getElapsedSeconds(this.time.now);
    console.info(`Level geschafft in ${elapsed.toFixed(2)}s`);
    this.isLevelReady = false;

    const next = this.pendingNextLevel;
    if (next) {
      saveProgress({ levelNumber: next.levelNumber, levelId: next.levelId });
      this.scene.launch('transition', {
        from: 'game',
        target: 'game',
        payload: {
          seasonId: this.seasonId,
          levelNumber: next.levelNumber,
          levelId: next.levelId,
        } satisfies GameSceneParams,
      });
    } else {
      clearProgress();
      this.scene.launch('transition', {
        from: 'game',
        target: 'start',
      });
    }
  }

  private handlePauseToggle(time: number): void {
    if (!Phaser.Input.Keyboard.JustDown(this.pauseKey)) {
      return;
    }

    this.isPaused = !this.isPaused;

    if (this.isPaused) {
      this.pauseStartedAt = time;
      this.physics.world.pause();
      this.pauseOverlay.setVisible(true);
    } else {
      this.accumulatedPauseTime += time - this.pauseStartedAt;
      this.physics.world.resume();
      this.pauseOverlay.setVisible(false);
    }
  }

  private resumeGame(): void {
    if (!this.isPaused) {
      return;
    }

    this.isPaused = false;
    this.physics.world.resume();
    this.accumulatedPauseTime += this.time.now - this.pauseStartedAt;
    this.pauseOverlay.setVisible(false);
  }

  private quitToMenu(): void {
    this.isLevelReady = false;
    this.physics.world.resume();
    this.pauseOverlay.setVisible(false);
    this.scene.launch('transition', {
      from: 'game',
      target: 'start',
    });
  }

  private createHud(): void {
    this.hudLevelText = this.add
      .text(16, 16, '', {
        fontSize: '18px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setScrollFactor(0)
      .setDepth(100);

    this.hudTimerText = this.add
      .text(this.scale.width - 16, 16, '', {
        fontSize: '18px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(100);

    this.hudAbilitiesText = this.add
      .text(16, 48, '', {
        fontSize: '16px',
        fontFamily: 'system-ui, sans-serif',
        color: '#e2e8f0',
      })
      .setScrollFactor(0)
      .setDepth(100);

    this.hudRetryText = this.add
      .text(16, this.scale.height - 32, '[R] Neustart  ·  [Esc] Pause', {
        fontSize: '16px',
        fontFamily: 'system-ui, sans-serif',
        color: '#94a3b8',
      })
      .setScrollFactor(0)
      .setDepth(100);

    this.loadingText = this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'Lade Level …', {
        fontSize: '24px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(300)
      .setVisible(false);
  }

  private createPauseMenu(): void {
    const width = this.scale.width;
    const height = this.scale.height;

    const background = this.add
      .rectangle(0, 0, width, height, 0x020617, 0.85)
      .setOrigin(0.5);

    const resumeButton = this.createPauseButton('Resume', -40, () => this.resumeGame());
    const retryButton = this.createPauseButton('Retry', 20, () => this.restartLevel());
    const quitButton = this.createPauseButton('Quit', 80, () => this.quitToMenu());

    this.pauseOverlay = this.add
      .container(width / 2, height / 2, [background, resumeButton, retryButton, quitButton])
      .setDepth(400)
      .setScrollFactor(0)
      .setVisible(false);
  }

  private createPauseButton(
    label: string,
    offsetY: number,
    onClick: () => void,
  ): Phaser.GameObjects.Text {
    const button = this.add
      .text(0, offsetY, label, {
        fontSize: '24px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
        backgroundColor: '#1e293b',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    button.on('pointerdown', onClick);
    button.on('pointerover', () => button.setStyle({ backgroundColor: '#334155' }));
    button.on('pointerout', () => button.setStyle({ backgroundColor: '#1e293b' }));

    return button;
  }

  private updateHud(time: number): void {
    const elapsed = this.getElapsedSeconds(time);
    this.hudLevelText.setText(
      `${this.formatSeasonLabel()}\n${this.currentLevelTitle}`,
    );
    this.hudTimerText.setText(`Zeit: ${elapsed.toFixed(2)}s`);
    this.hudAbilitiesText.setText(`Abilities: ${this.formatAbilities()}`);
  }

  private formatSeasonLabel(): string {
    return `${this.seasonId.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())} — Level ${this.currentLevelNumber}/${this.totalLevels}`;
  }

  private showLoadingState(isLoading: boolean): void {
    this.loadingText.setVisible(isLoading);
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

  private formatAbilities(): string {
    const abilities = this.levelData.rules.abilities;
    const entries: string[] = ['Jump'];
    if (abilities.highJump) {
      entries.push('HighJump');
    }
    if (abilities.shortFly) {
      entries.push('Fly');
    }
    if (abilities.jetpack) {
      entries.push(`Jetpack(${abilities.jetpack.fuel})`);
    }
    return entries.join(' · ');
  }
}
