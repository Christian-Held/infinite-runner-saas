import Phaser from 'phaser';

const TEXTURES: Array<{ key: string; width: number; height: number; color: number }> = [
  { key: 'player', width: 48, height: 64, color: 0x38bdf8 },
  { key: 'platform', width: 64, height: 16, color: 0x1e293b },
  { key: 'hazard', width: 64, height: 16, color: 0xef4444 },
  { key: 'exit', width: 32, height: 64, color: 0x22c55e },
];

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    TEXTURES.forEach((texture) => {
      if (this.textures.exists(texture.key)) {
        return;
      }

      const graphics = this.add.graphics();
      graphics.fillStyle(texture.color, 1);
      graphics.fillRect(0, 0, texture.width, texture.height);
      graphics.generateTexture(texture.key, texture.width, texture.height);
      graphics.destroy();
    });

    const message = this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'Season-1 starten\n<SPACE> drücken', {
        fontSize: '32px',
        fontFamily: 'system-ui, sans-serif',
        color: '#f8fafc',
        align: 'center',
      })
      .setOrigin(0.5);

    const startSeason = () => {
      message.destroy();
      this.scene.start('game');
    };

    this.input.keyboard.once('keydown-SPACE', startSeason);
    this.input.keyboard.once('keydown-ENTER', startSeason);
    this.input.once('pointerdown', startSeason);
  }
}
