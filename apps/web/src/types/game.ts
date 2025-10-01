export interface RunnerConstants {
  gravityY: number;
  moveSpeed: number;
  jumpVelocity: number;
  coyoteTimeMs: number;
  jumpBufferMs: number;
}

export const RUNNER_CONSTANTS: RunnerConstants = {
  gravityY: 1200,
  moveSpeed: 180,
  jumpVelocity: -520,
  coyoteTimeMs: 90,
  jumpBufferMs: 100,
};
