import Phaser from 'phaser';

import { getBiome, type BiomeParams } from '@ir/game-spec';

import { fetchApproved, type LevelSummary } from '../level/loader';
import { loadProgress, type LevelProgress } from '../level/progress';
import type { GameSceneParams } from './GameScene';

interface ButtonConfig {
  label: string;
  action: () => void;
}

function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function mixColor(base: number, target: number, t: number): string {
  const from = Phaser.Display.Color.IntegerToRGB(base);
  const to = Phaser.Display.Color.IntegerToRGB(target);
  const clamped = Phaser.Math.Clamp(t, 0, 1);
  const r = Math.round(Phaser.Math.Linear(from.r, to.r, clamped));
  const g = Math.round(Phaser.Math.Linear(from.g, to.g, clamped));
  const b = Math.round(Phaser.Math.Linear(from.b, to.b, clamped));
  return toCss(Phaser.Display.Color.GetColor(r, g, b));
}

export class StartScene extends Phaser.Scene {
  private buttons: Phaser.GameObjects.Text[] = [];
  private continueButton: Phaser.GameObjects.Text | null = null;
  private approvedContainer!: Phaser.GameObjects.Container;
  private approvedEntries: LevelSummary[] = [];
  private progress: LevelProgress | null = null;
  private startPalette: BiomeParams['palette'] | null = null;
  private startBiomeName: string = 'meadow';
  private biomeText!: Phaser.GameObjects.Text;

  constructor() {
    super('start');
  }

  create(): void {
    this.progress = loadProgress();

    const nextLevelNumber = this.progress?.levelNumber ?? 1;
    const biomeInfo = getBiome(nextLevelNumber);
    this.startPalette = biomeInfo.params.palette;
    this.startBiomeName = biomeInfo.biome;
    this.cameras.main.setBackgroundColor(this.startPalette.bg);

    const headingColor = mixColor(this.startPalette.accent, 0xffffff, 0.25);
    const subHeadingColor = mixColor(this.startPalette.platform, 0xffffff, 0.4);

    this.add
      .text(this.scale.width / 2, 120, 'Infinite Runner — Season 1', {
        fontSize: '42px',
        fontFamily: 'system-ui, sans-serif',
        color: headingColor,
      })
      .setOrigin(0.5);

    this.add
      .text(this.scale.width / 2, 176, 'Trainiere & veröffentliche deine besten Runs', {
        fontSize: '20px',
        fontFamily: 'system-ui, sans-serif',
        color: subHeadingColor,
      })
      .setOrigin(0.5);

    this.biomeText = this.add
      .text(this.scale.width / 2, 212, `Biome: ${this.startBiomeName}`, {
        fontSize: '18px',
        fontFamily: 'system-ui, sans-serif',
        color: mixColor(this.startPalette.accent, 0xffffff, 0.45),
      })
      .setOrigin(0.5);

    this.createButtons();
    this.createApprovedFeed();
    void this.loadApprovedLevels();
  }

  private createButtons(): void {
    const configs: ButtonConfig[] = [
      {
        label: 'Play Season-1',
        action: () => this.startGame({ seasonId: 'season-1', levelNumber: 1 }),
      },
      {
        label: 'Continue',
        action: () => this.continueProgress(),
      },
      {
        label: 'Settings',
        action: () => this.showSettingsNotice(),
      },
    ];

    const startY = 260;
    const spacing = 70;

    configs.forEach((config, index) => {
      const button = this.createButton(this.scale.width / 2, startY + spacing * index, config.label);
      button.on('pointerdown', config.action);
      this.buttons.push(button);

      if (config.label === 'Continue') {
        this.continueButton = button;
      }
    });

    this.updateContinueState();
  }

  private createButton(x: number, y: number, label: string): Phaser.GameObjects.Text {
    const palette = this.startPalette;
    const baseColor = palette ? mixColor(palette.accent, 0xffffff, 0.05) : '#38bdf8';
    const hoverColor = palette ? mixColor(palette.accent, 0xffffff, 0.25) : '#0ea5e9';
    const textColor = palette ? mixColor(palette.bg, 0x000000, 0.7) : '#0f172a';

    const button = this.add
      .text(x, y, label, {
        fontSize: '28px',
        fontFamily: 'system-ui, sans-serif',
        color: textColor,
        backgroundColor: baseColor,
        padding: { x: 32, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    button.setData('baseColor', baseColor);
    button.setData('hoverColor', hoverColor);
    button.setData('textColor', textColor);
    button.on('pointerover', () => {
      if (!button.input?.enabled) {
        return;
      }
      const hover = button.getData('hoverColor') as string | undefined;
      button.setStyle({ backgroundColor: hover ?? hoverColor, color: '#f8fafc' });
    });
    button.on('pointerout', () => {
      if (!button.input?.enabled) {
        return;
      }
      const base = button.getData('baseColor') as string | undefined;
      const text = button.getData('textColor') as string | undefined;
      button.setStyle({ backgroundColor: base ?? baseColor, color: text ?? textColor });
    });

    return button;
  }

  private updateContinueState(): void {
    if (!this.continueButton) {
      return;
    }

    const available = Boolean(this.progress);
    this.continueButton.input?.setEnable(available);
    this.continueButton.setAlpha(available ? 1 : 0.5);

    const palette = this.startPalette;
    const disabledBg = palette ? mixColor(palette.platform, 0x000000, 0.45) : '#475569';
    const disabledText = palette ? mixColor(palette.bg, 0xffffff, 0.6) : '#cbd5f5';
    const baseColor = (this.continueButton.getData('baseColor') as string | undefined) ?? '#38bdf8';
    const textColor = (this.continueButton.getData('textColor') as string | undefined) ?? '#0f172a';

    if (!available) {
      this.continueButton.setStyle({ backgroundColor: disabledBg, color: disabledText });
    } else {
      this.continueButton.setStyle({ backgroundColor: baseColor, color: textColor });
    }
  }

  private continueProgress(): void {
    if (!this.progress) {
      return;
    }

    this.startGame({
      seasonId: 'season-1',
      levelNumber: this.progress.levelNumber,
      levelId: this.progress.levelId ?? undefined,
    });
  }

  private showSettingsNotice(): void {
    const notice = this.add
      .text(this.scale.width / 2, this.scale.height - 80, 'Settings coming soon', {
        fontSize: '18px',
        fontFamily: 'system-ui, sans-serif',
        color: mixColor(this.startPalette.bg, 0xffffff, 0.85),
        backgroundColor: mixColor(this.startPalette.platform, 0x000000, 0.45),
        padding: { x: 12, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(200)
      .setAlpha(0);

    this.tweens.add({
      targets: notice,
      alpha: 1,
      duration: 200,
      yoyo: true,
      hold: 1200,
      onComplete: () => notice.destroy(),
    });
  }

  private createApprovedFeed(): void {
    const width = this.scale.width;
    const listX = width * 0.75;

    const container = this.add.container(listX, 260);
    const title = this.add
      .text(0, 0, 'Latest Approved', {
        fontSize: '24px',
        fontFamily: 'system-ui, sans-serif',
        color: mixColor(this.startPalette.accent, 0xffffff, 0.35),
      })
      .setOrigin(0.5, 0);

    container.add(title);
    this.approvedContainer = container;
  }

  private async loadApprovedLevels(): Promise<void> {
    const levels = await fetchApproved({ limit: 10, offset: 0 });
    this.approvedEntries = levels;
    this.renderApprovedFeed();
  }

  private renderApprovedFeed(): void {
    this.approvedContainer.removeAll(true);

    const title = this.add
      .text(0, 0, 'Latest Approved', {
        fontSize: '24px',
        fontFamily: 'system-ui, sans-serif',
        color: mixColor(this.startPalette.accent, 0xffffff, 0.35),
      })
      .setOrigin(0.5, 0);

    this.approvedContainer.add(title);

    const spacing = 32;
    this.approvedEntries.slice(0, 8).forEach((entry, index) => {
      const button = this.add
        .text(0, (index + 1) * spacing + 8, `${entry.title}`, {
          fontSize: '18px',
          fontFamily: 'system-ui, sans-serif',
          color: mixColor(this.startPalette.bg, 0xffffff, 0.82),
          backgroundColor: mixColor(this.startPalette.platform, 0x000000, 0.45),
          padding: { x: 12, y: 6 },
        })
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });

      button.on('pointerover', () =>
        button.setStyle({ backgroundColor: mixColor(this.startPalette.accent, 0xffffff, 0.25) }),
      );
      button.on('pointerout', () =>
        button.setStyle({ backgroundColor: mixColor(this.startPalette.platform, 0x000000, 0.45) }),
      );
      button.on('pointerdown', () => {
        const levelNumber = entry.levelNumber ?? 1;
        this.startGame({
          seasonId: entry.seasonId ?? 'season-1',
          levelNumber,
          levelId: entry.id,
        });
      });

      this.approvedContainer.add(button);
    });
  }

  private startGame(params: GameSceneParams): void {
    this.scene.launch('transition', {
      from: 'start',
      target: 'game',
      payload: params,
    });
  }
}
