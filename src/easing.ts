import { springStep } from './physics/spring';
import type { SpringConfig, SpringState } from './physics/spring';

const SIM_DT = 1 / 240;
const SETTLE_EPSILON = 0.001;
const MAX_SIM_TIME = 5;

function simulateSpring(config: SpringConfig): { positions: number[]; settleTime: number } {
  let state: SpringState = { position: 0, velocity: 0 };
  const positions: number[] = [0];
  let t = 0;

  while (t < MAX_SIM_TIME) {
    const result = springStep(config, state, 1, SIM_DT);
    t += SIM_DT;
    positions.push(result.position);

    if (
      Math.abs(result.position - 1) < SETTLE_EPSILON &&
      Math.abs(result.velocity) < SETTLE_EPSILON
    ) {
      break;
    }

    state = result;
  }

  return { positions, settleTime: t };
}

function resample(positions: number[], count: number): number[] {
  const result: number[] = [];
  const lastIndex = positions.length - 1;

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * lastIndex;
    const low = Math.floor(t);
    const high = Math.min(low + 1, lastIndex);
    const frac = t - low;
    result.push(positions[low] + (positions[high] - positions[low]) * frac);
  }

  return result;
}

export interface SpringEasing {
  css: string;
  duration: number;
}

/**
 * Generate a CSS `linear()` easing from spring physics.
 */
export function springEasing(config: SpringConfig, sampleCount = 32): SpringEasing {
  const { positions, settleTime } = simulateSpring(config);
  const samples = resample(positions, sampleCount);
  const rounded = samples.map((v) => Math.round(v * 1000) / 1000);

  return {
    css: `linear(${rounded.join(', ')})`,
    duration: Math.round(settleTime * 1000),
  };
}
