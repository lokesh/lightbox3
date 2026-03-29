export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface SpringState {
  position: number;
  velocity: number;
}

export interface SpringStepResult extends SpringState {
  settled: boolean;
}

const POSITION_THRESHOLD = 0.01;
const VELOCITY_THRESHOLD = 0.01;
const MAX_DT = 0.02;
const SUB_STEP_DT = 0.008;

export function springStep(
  config: SpringConfig,
  state: SpringState,
  target: number,
  dt: number,
): SpringStepResult {
  const { stiffness: k, damping: c, mass: m } = config;

  if (dt > MAX_DT) {
    let current: SpringState = { ...state };
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(remaining, SUB_STEP_DT);
      const result = springStepSingle(k, c, m, current, target, step);
      if (result.settled) return result;
      current = result;
      remaining -= step;
    }
    return { ...current, settled: false };
  }

  return springStepSingle(k, c, m, state, target, dt);
}

function springStepSingle(
  k: number,
  c: number,
  m: number,
  state: SpringState,
  target: number,
  dt: number,
): SpringStepResult {
  const displacement = state.position - target;
  const springForce = -k * displacement;
  const dampingForce = -c * state.velocity;
  const acceleration = (springForce + dampingForce) / m;

  const newVelocity = state.velocity + acceleration * dt;
  const newPosition = state.position + newVelocity * dt;

  const settled =
    Math.abs(newPosition - target) < POSITION_THRESHOLD &&
    Math.abs(newVelocity) < VELOCITY_THRESHOLD;

  return {
    position: settled ? target : newPosition,
    velocity: settled ? 0 : newVelocity,
    settled,
  };
}

// Presets — tuned for Motion.dev-style feel
export const SPRING_OPEN: SpringConfig = { stiffness: 170, damping: 20, mass: 1 };
export const SPRING_CLOSE: SpringConfig = { stiffness: 400, damping: 35, mass: 1 };
