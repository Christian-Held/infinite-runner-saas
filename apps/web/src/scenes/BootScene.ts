import Phaser from 'phaser';

const TEXTURES: Array<{ key: string; width: number; height: number; color: number }> = [
  { key: 'player', width: 48, height: 64, color: 0xffffff },
  { key: 'platform', width: 64, height: 16, color: 0xffffff },
  { key: 'hazard', width: 64, height: 16, color: 0xffffff },
  { key: 'exit', width: 32, height: 64, color: 0xffffff },
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

    this.scene.start('start');
  }
}
