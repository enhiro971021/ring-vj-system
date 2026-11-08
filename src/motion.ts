import type { AudioFeatures } from './audio.ts';

export type MotionFrame = {
  /** Bounded, shaped controls. Low/mid share a deformation budget; high is independent. */
  audio: AudioFeatures;
  /** Continuous seconds-like phase clocks: travel, flow, and fine detail. */
  phases: [number, number, number];
  /** Overall activity for light or material emphasis, not an extra geometry displacement. */
  energy: number;
  /** Independent, bounded shape controls, kept separate from the five legacy controls. */
  spectrum: number[];
};

type Spring = { value: number; velocity: number };
type ScalarFeatures = Omit<AudioFeatures, 'spectrum' | 'raw'>;
const KEYS = ['level', 'low', 'mid', 'high', 'pulse'] as const;
const ZERO: ScalarFeatures = { level: 0, low: 0, mid: 0, high: 0, pulse: 0 };
// Low reacts with weight, mid sustains a phrase, and high/pulse articulate details.
// Fixed coefficients keep both position and velocity continuous when a target changes.
const OMEGA: ScalarFeatures = { level: 6, low: 13, mid: 7.5, high: 20, pulse: 24 };
const SPECTRUM_OMEGA = [11, 9, 12, 10, 11, 13, 10, 12, 16, 12, 18, 14];
const clamp = (value: number, max = 1) => Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
const spectrumTarget = (input: AudioFeatures, index: number) => clamp(input.spectrum === undefined
  ? (index < 4 ? input.low : index < 8 ? input.mid : input.high)
  : input.spectrum[index] ?? 0);

/**
 * Exact critically damped spring step for a constant target over this frame.
 * Returns the integral of its position, so phase speed can be integrated without
 * multiplying the running clock by a changing audio value.
 */
function advance(spring: Spring, target: number, omega: number, dt: number): number {
  const offset = spring.value - target;
  const coefficient = spring.velocity + omega * offset;
  const wdt = omega * dt;
  const decay = Math.exp(-wdt);
  const oneMinusDecay = -Math.expm1(-wdt);
  const moment = oneMinusDecay - wdt * decay;
  const integral = target * dt + offset * oneMinusDecay / omega + coefficient * moment / (omega * omega);
  spring.value = target + (offset + coefficient * dt) * decay;
  spring.velocity = (spring.velocity - omega * coefficient * dt) * decay;
  // A positive critical damping kernel preserves bounds for bounded input. Clamp
  // only to remove numerical error at a settled endpoint; never reset velocity.
  spring.value = clamp(spring.value);
  return Math.min(dt, Math.max(0, integral));
}

/**
 * Choreographs audio controls before the scene receives them. This is distinct
 * from the analyser's noise envelope: it controls the inertia of visible objects.
 *
 * A zero/invalid timestep freezes the entire state. A single frame is capped at
 * 250 ms so returning from a suspended browser cannot jump a long way forward.
 * reset(input) deliberately seeds a still image; it is not a per-frame operation.
 */
export class MotionDirector {
  private readonly springs: Record<keyof ScalarFeatures, Spring> = {
    level: { value: 0, velocity: 0 }, low: { value: 0, velocity: 0 },
    mid: { value: 0, velocity: 0 }, high: { value: 0, velocity: 0 },
    pulse: { value: 0, velocity: 0 },
  };
  private readonly phases: [number, number, number] = [0, 0, 0];
  private readonly spectrumSprings: Spring[] = Array.from({ length: 12 }, () => ({ value: 0, velocity: 0 }));

  reset(input: AudioFeatures = ZERO): MotionFrame {
    for (const key of KEYS) {
      this.springs[key].value = clamp(input[key]);
      this.springs[key].velocity = 0;
    }
    this.phases.fill(0);
    this.spectrumSprings.forEach((spring, index) => { spring.value = spectrumTarget(input, index); spring.velocity = 0; });
    return this.snapshot();
  }

  update(input: AudioFeatures, dtSeconds: number, speed = 1): MotionFrame {
    const dt = clamp(dtSeconds, .25);
    if (dt === 0) return this.snapshot();
    const rate = Number.isFinite(speed) ? clamp(speed, 2) : 1;
    const integrals: ScalarFeatures = { ...ZERO };
    for (const key of KEYS) {
      integrals[key] = advance(this.springs[key], clamp(input[key]), OMEGA[key], dt);
    }
    this.spectrumSprings.forEach((spring, index) => advance(spring, spectrumTarget(input, index), SPECTRUM_OMEGA[index], dt));
    // Each phase has one leading band. Treble never changes the body clocks.
    this.phases[0] += rate * (dt + .32 * integrals.low);
    this.phases[1] += rate * (.72 * dt + .28 * integrals.mid);
    this.phases[2] += rate * (1.15 * dt + .50 * integrals.high);
    return this.snapshot();
  }

  private snapshot(): MotionFrame {
    const low = this.springs.low.value;
    const mid = this.springs.mid.value;
    // Smooth at silence and at simultaneous peaks. Unlike max/normalise, this
    // introduces no threshold kink. High does not shrink or shift body geometry.
    const bodyBudget = 1 / Math.sqrt(1 + .55 * (low * low + mid * mid));
    const audio: AudioFeatures = {
      level: this.springs.level.value,
      low: low * bodyBudget,
      mid: mid * bodyBudget,
      high: this.springs.high.value,
      pulse: this.springs.pulse.value * .72,
    };
    const power = Math.sqrt(.44 * audio.low ** 2 + .34 * audio.mid ** 2 + .22 * audio.high ** 2);
    const energy = clamp(power * .82 + audio.level * .18);
    // Give moderate notes usable shape contrast after damping. The smooth curve
    // preserves silence, ordering and the peak bound; it does not change clocks.
    const spectrum = this.spectrumSprings.map(({ value }) => value * (2 - value));
    return { audio, phases: [...this.phases], energy, spectrum };
  }
}
