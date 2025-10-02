import Phaser from 'phaser';

import { fetchApproved, type LevelSummary } from '../level/loader';
import { loadProgress, type LevelProgress } from '../level/progress';
import type { GameSceneParams } from './GameScene';

interface ButtonConfig {
  label: string;
  action: () => void;
}

export class StartScene extends Phaser.Scene {
  private buttons: Phaser.GameObjects.Text[] = [];
  private continueButton: Phaser.GameObjects.Text | null = null;
  private approvedContainer!: Phaser.GameObjects.Container;
  private approvedEntries: LevelSummary[] = [];
  private progress: LevelProgress | null = null;

  constructor() {
    super('start');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x0f172a);
    this.progress = loadProgress();

    this.add
      .text(this.scale.width / 2, 120, 'Infinite Runner — Season 1', {
        fontSize: '42px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.add
      .text(this.scale.width / 2, 176, 'Trainiere & veröffentliche deine besten Runs', {
        fontSize: '20px',
        fontFamily: 'system-ui, sans-serif',
        color: '#cbd5f5',
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
    const button = this.add
      .text(x, y, label, {
        fontSize: '28px',
        fontFamily: 'system-ui, sans-serif',
        color: '#0f172a',
        backgroundColor: '#38bdf8',
        padding: { x: 32, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    button.on('pointerover', () => {
      if (!button.input?.enabled) {
        return;
      }
      button.setStyle({ backgroundColor: '#0ea5e9', color: '#f8fafc' });
    });
    button.on('pointerout', () => {
      if (!button.input?.enabled) {
        return;
      }
      button.setStyle({ backgroundColor: '#38bdf8', color: '#0f172a' });
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

    if (!available) {
      this.continueButton.setStyle({ backgroundColor: '#475569', color: '#cbd5f5' });
    } else {
      this.continueButton.setStyle({ backgroundColor: '#38bdf8', color: '#0f172a' });
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
        color: '#f8fafc',
        backgroundColor: '#334155',
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
        color: '#f8fafc',
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
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0);

    this.approvedContainer.add(title);

    const spacing = 32;
    this.approvedEntries.slice(0, 8).forEach((entry, index) => {
      const button = this.add
        .text(0, (index + 1) * spacing + 8, `${entry.title}`, {
          fontSize: '18px',
          fontFamily: 'system-ui, sans-serif',
          color: '#cbd5f5',
          backgroundColor: '#1e293b',
          padding: { x: 12, y: 6 },
        })
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });

      button.on('pointerover', () => button.setStyle({ backgroundColor: '#334155' }));
      button.on('pointerout', () => button.setStyle({ backgroundColor: '#1e293b' }));
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
