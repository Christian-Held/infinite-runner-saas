import Phaser from 'phaser';

interface TransitionData {
  from?: string;
  target: string;
  payload?: unknown;
  duration?: number;
}

export class TransitionScene extends Phaser.Scene {
  constructor() {
    super('transition');
  }

  create(data: TransitionData): void {
    const { from, target, payload, duration = 220 } = data ?? {};
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x020617);
    camera.fadeOut(duration, 0, 0, 0);

    camera.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (from && this.scene.isActive(from)) {
        this.scene.stop(from);
      }

      if (this.scene.isActive(target)) {
        this.scene.stop(target);
      }

      this.scene.launch(target, payload);
      camera.fadeIn(duration, 0, 0, 0);
    });

    camera.once(Phaser.Cameras.Scene2D.Events.FADE_IN_COMPLETE, () => {
      this.scene.stop();
    });
  }
}
