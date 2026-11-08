export type AudioFeatures = {
  level: number;
  low: number;
  mid: number;
  high: number;
  pulse: number;
  /** Twelve fine-frequency energies: four logarithmic slices of each low/mid/high band. */
  spectrum?: readonly number[];
  /**
   * Unsmoothed linear magnitudes for shaders that read the spectrum directly.
   * RAW_SPECTRUM_SIZE values on the warped axis of rawSpectrumHz; not bounded to 1.
   */
  raw?: Float32Array;
};

export type AudioBandGains = { low: number; mid: number; high: number };
export const DEFAULT_BAND_GAINS: Readonly<AudioBandGains> = Object.freeze({ low: 1, mid: 1, high: 1 });
export const BAND_GAIN_MAX = 3;

export const SILENCE: AudioFeatures = Object.freeze({ level: 0, low: 0, mid: 0, high: 0, pulse: 0, spectrum: Object.freeze(Array<number>(12).fill(0)) });
type AudioStatus = 'idle' | 'requesting' | 'live' | 'error';
type StatusListener = (status: AudioStatus, message: string) => void;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const compress = (value: number, gain: number) => 1 - Math.exp(-Math.max(0, value) * gain);
export const normalizeBandGains = (bands: AudioBandGains = DEFAULT_BAND_GAINS): AudioBandGains => ({
  low: clamp(finite(bands.low, 1), 0, BAND_GAIN_MAX),
  mid: clamp(finite(bands.mid, 1), 0, BAND_GAIN_MAX),
  high: clamp(finite(bands.high, 1), 0, BAND_GAIN_MAX),
});
// Keep every fine bin inside one existing broad band. Low bins may be empty at
// the analyser's 2048-point FFT resolution; do not invent detail between FFT bins.
const FINE_BANDS = [[20, 140, 8], [140, 2200, 8], [2200, 9000, 10]].flatMap(([from, to, gain]) =>
  Array.from({ length: 4 }, (_, i) => ({ from: from * (to / from) ** (i / 4), to: i === 3 ? to : from * (to / from) ** ((i + 1) / 4), gain })),
);

// Twelve texels per tenth, so the ten regions below have exact edges.
export const RAW_SPECTRUM_SIZE = 120;
/**
 * Texture coordinate (0..1) to Hz. Piecewise logarithmic through the meter's
 * own band edges, so a tenth of the row means the same thing to a shader and
 * to the low / mid / high meters: [0, .1) is the low band, [.1, .5) the mid
 * band, [.5, .8) the high band, and the rest is air above the meters.
 */
const RAW_KNOTS = [[0, 20], [.1, 140], [.5, 2200], [.8, 9000], [1, 16000]] as const;
export const rawSpectrumHz = (position: number) => {
  const x = clamp(position);
  for (let i = 1; i < RAW_KNOTS.length; i++) {
    const [x0, hz0] = RAW_KNOTS[i - 1], [x1, hz1] = RAW_KNOTS[i];
    if (x <= x1) return hz0 * (hz1 / hz0) ** ((x - x0) / (x1 - x0));
  }
  return 16000;
};
// Music loses roughly 4.5 dB per octave. Without this tilt the upper half of
// the texture stays near zero and only the bass could ever shape a picture.
const RAW_TILT = (hz: number) => Math.min(8, Math.max(1, hz / 150) ** .75);
const RAW_GAIN = 1;

/** Mean of each tenth of the row: ten contiguous regions with no gaps between them. */
export function rawRegions(raw: ArrayLike<number>, out = new Float32Array(10)): Float32Array {
  const size = raw.length / out.length;
  for (let region = 0; region < out.length; region++) {
    const from = Math.round(region * size), to = Math.max(from + 1, Math.round((region + 1) * size));
    let sum = 0;
    for (let i = from; i < to; i++) sum += finite(raw[i] ?? 0);
    out[region] = sum / (to - from);
  }
  return out;
}
/** The eight regions from 20 Hz to 9 kHz, summed: the drive of an outline. */
export const rawVoiceSum = (regions: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += regions[i] ?? 0;
  return sum;
};

/** Trim after levelling so its running average cannot undo the user's balance.
 * The high trim also owns air above 9 kHz. A finite peak scales all bands only
 * on saturation; below it their gains are independent. Neutral gains preserve
 * the original row and its existing safety limits exactly.
 */
export function applyRawBandGains(raw: Float32Array, bands: AudioBandGains, peak = Infinity): Float32Array {
  const { low, mid, high } = normalizeBandGains(bands);
  if (low === 1 && mid === 1 && high === 1) return raw;
  const adjusted = raw.map((value, i) => value * (i < raw.length * .1 ? low : i < raw.length * .5 ? mid : high));
  const drive = rawVoiceSum(rawRegions(adjusted));
  if (drive > peak) {
    const scale = peak / drive;
    return adjusted.map(value => value * scale);
  }
  return adjusted;
}

/**
 * Brings the row to a working level whatever the input volume, so a quiet
 * microphone and a hot line input draw outlines of similar size. The level is
 * measured on the ungated row and followed slowly (about .3 s up, 8 s down):
 * phrases keep their dynamics and a fade is not pumped back up. The silence
 * gate is applied after levelling, so quiet input really does draw less, and
 * a closed gate yields an all-zero row with no change to the running level.
 * The boost is capped, and so is a single frame's peak.
 */
export class RawLeveler {
  static readonly TARGET = .42;
  static readonly MAX_BOOST = 24;
  /** No frame's drive exceeds this, whatever the running level says. */
  static readonly PEAK = .92;
  private average = 0;
  private readonly regions = new Float32Array(10);
  reset(): void { this.average = 0; }
  apply(raw: Float32Array | undefined, elapsed: number, gate = 1): Float32Array | undefined {
    if (!raw) return raw;
    const open = clamp(finite(gate));
    if (open <= 0) return new Float32Array(raw.length);
    const sum = rawVoiceSum(rawRegions(raw, this.regions));
    if (!(sum > 0)) return raw;
    const dt = clamp(finite(elapsed), 0, .25);
    if (this.average === 0) this.average = sum;
    else this.average += (sum - this.average) * (1 - Math.exp(-dt / (sum > this.average ? .3 : 8)));
    const scale = Math.min(RawLeveler.MAX_BOOST, RawLeveler.TARGET / this.average, RawLeveler.PEAK / sum) * open;
    return raw.map(value => value * scale);
  }
}

/**
 * The analyser's decibel bins as an unsmoothed magnitude row. No envelope, no
 * compression: a shader reading this sees each frame's spectrum immediately.
 */
export function rawSpectrum(spectrum: Float32Array, sampleRate: number, fftSize: number, gain = 1, out = new Float32Array(RAW_SPECTRUM_SIZE)): Float32Array {
  if (sampleRate <= 0 || fftSize <= 0 || spectrum.length === 0) return out.fill(0);
  const amplitude = (bin: number) => {
    const db = spectrum[Math.min(spectrum.length - 1, Math.max(1, bin))];
    return Number.isFinite(db) ? 10 ** (Math.min(0, db) / 20) : 0;
  };
  const scale = clamp(finite(gain, 1), 0, SENSITIVITY_MAX) * RAW_GAIN;
  for (let i = 0; i < out.length; i++) {
    const from = rawSpectrumHz(i / out.length) * fftSize / sampleRate;
    const to = rawSpectrumHz((i + 1) / out.length) * fftSize / sampleRate;
    const first = Math.ceil(from), last = Math.ceil(to) - 1;
    let peak = 0;
    if (last < first) {
      // Narrower than one bin: interpolate, so neighbours do not repeat a step.
      const centre = (from + to) / 2, base = Math.floor(centre), mix = centre - base;
      peak = amplitude(base) * (1 - mix) + amplitude(base + 1) * mix;
    } else for (let bin = first; bin <= last; bin++) peak = Math.max(peak, amplitude(bin));
    out[i] = peak * RAW_TILT(rawSpectrumHz((i + .5) / out.length)) * scale;
  }
  return out;
}

/**
 * Stand-in row for inputs that carry no measured spectrum (the synthetic demo,
 * stills). Twelve band controls are spread over their own Hz ranges at the
 * magnitude real music produces; it is not an FFT.
 */
export function rawFromBands(features: AudioFeatures, out = new Float32Array(RAW_SPECTRUM_SIZE)): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const hz = rawSpectrumHz((i + .5) / out.length);
    let position = 0;
    for (let band = 0; band < FINE_BANDS.length; band++) {
      const { from, to } = FINE_BANDS[band];
      if (hz >= from) position = band + clamp((hz - from) / (to - from));
    }
    const value = (index: number) => {
      const safe = Math.min(11, Math.max(0, index));
      const broad = safe < 4 ? features.low : safe < 8 ? features.mid : features.high;
      return clamp(finite(features.spectrum === undefined ? broad : features.spectrum[safe] ?? 0));
    };
    const base = Math.floor(position - .5), mix = position - .5 - base;
    out[i] = (value(base) * (1 - mix) + value(base + 1) * mix) * RAW_DEMO_LEVEL;
  }
  return out;
}
// Demo and still inputs are already 0..1 controls: a fixed level, no running
// adjustment, so a composed fade stays a fade. A typical passage (low .5,
// mid .5, high .3) sums to the leveler's target.
const RAW_DEMO_LEVEL = .12;

/**
 * Silence is judged on the waveform's RMS after the sensitivity multiplier,
 * so sensitivity acts as input gain: turning it down widens what counts as
 * silence, turning it up lets quiet sound through. At 1x the gate is closed
 * below about -50 dBFS and opens smoothly up to about -38 dBFS. Room tone and
 * the tail of a fade shrink every control, and the mist trio's outline settles
 * back to a circle instead of trembling on noise. Digital silence is zero at
 * any sensitivity.
 */
export const SILENCE_FLOOR = .003;
export const SILENCE_OPEN = .012;
/** Sensitivity (input gain) range accepted by the analysis. */
export const SENSITIVITY_MAX = 20;
export function silenceGate(rms: number): number {
  const x = clamp((finite(rms) - SILENCE_FLOOR) / (SILENCE_OPEN - SILENCE_FLOOR));
  return x * x * (3 - 2 * x);
}
/** RMS of a waveform after removing its DC offset. */
export function waveformRms(waveform: Float32Array): number {
  if (waveform.length === 0) return 0;
  let mean = 0;
  for (const value of waveform) mean += finite(value);
  mean /= waveform.length;
  let sum = 0;
  for (const value of waveform) sum += (finite(value) - mean) ** 2;
  return Math.sqrt(sum / waveform.length);
}

/** FFT values are decibels, not linear amplitudes. Convert to power before summing. */
function bandAmplitude(spectrum: Float32Array, sampleRate: number, fftSize: number, from: number, to: number): number {
  const start = Math.max(1, Math.ceil(from * fftSize / sampleRate));
  const end = Math.min(spectrum.length, Math.ceil(to * fftSize / sampleRate));
  let power = 0;
  for (let i = start; i < end; i++) {
    const db = spectrum[i];
    if (Number.isFinite(db)) power += 10 ** (Math.min(0, db) / 10);
  }
  return Math.sqrt(power);
}

/** Pure signal measurement, independent of browser devices and animation frame rate. */
export function measureAudio(
  waveform: Float32Array,
  spectrum: Float32Array,
  sampleRate: number,
  fftSize: number,
  sensitivity: number,
  bands: AudioBandGains = DEFAULT_BAND_GAINS,
): AudioFeatures {
  if (waveform.length === 0 || sampleRate <= 0 || fftSize <= 0) return { ...SILENCE };
  const rms = waveformRms(waveform);
  const gain = clamp(finite(sensitivity, 1), 0, SENSITIVITY_MAX);
  const trims = normalizeBandGains(bands);
  const gate = silenceGate(rms * gain);
  return {
    level: compress(rms * gain - SILENCE_FLOOR, 14) * gate,
    // Match greenVJ's Hz-based bands; the spectrum length caps them at Nyquist.
    low: compress(bandAmplitude(spectrum, sampleRate, fftSize, 20, 140), gain * 8 * trims.low) * gate,
    mid: compress(bandAmplitude(spectrum, sampleRate, fftSize, 140, 2200), gain * 8 * trims.mid) * gate,
    high: compress(bandAmplitude(spectrum, sampleRate, fftSize, 2200, 9000), gain * 10 * trims.high) * gate,
    pulse: 0,
    spectrum: FINE_BANDS.map((band, i) => compress(bandAmplitude(spectrum, sampleRate, fftSize, band.from, band.to), gain * band.gain * (i < 4 ? trims.low : i < 8 ? trims.mid : trims.high)) * gate),
    // The gate is the only shaping. A closed gate carries no row at all, so
    // readers fall back to the (zero or decaying) band controls.
    ...(gate > 0 ? { raw: applyRawBandGains(rawSpectrum(spectrum, sampleRate, fftSize, gain).map(value => value * gate), trims) } : {}),
  };
}

/** Fast attack and slow release produce continuous modulation; pulse is an onset, not a beat clock. */
export class FeatureEnvelope {
  private value: AudioFeatures = { ...SILENCE };
  private baseline = 0;
  private cooldown = 0;
  private readonly spectrum = Array<number>(12).fill(0);
  /** Passed through untouched; kept so a frozen frame repeats the same row. */
  private raw: Float32Array | undefined;

  reset(): void {
    this.raw = undefined;
    this.value = { ...SILENCE };
    this.baseline = 0;
    this.cooldown = 0;
    this.spectrum.fill(0);
  }

  update(input: AudioFeatures, elapsed: number): AudioFeatures {
    const dt = clamp(finite(elapsed), 0, 0.25);
    if (dt === 0) return this.snapshot();
    this.raw = input.raw;
    const energy = Math.max(clamp(finite(input.low)) * 0.65, clamp(finite(input.level)));
    this.cooldown = Math.max(0, this.cooldown - dt);
    const rise = energy - this.baseline * 1.25;
    this.baseline += (energy - this.baseline) * (1 - Math.exp(-dt / 0.28));
    this.value.pulse *= Math.exp(-dt / 0.16);
    if (rise > 0.09 && this.cooldown === 0) {
      this.value.pulse = Math.max(this.value.pulse, clamp(rise * 2));
      this.cooldown = 0.16;
    }
    for (const key of ['level', 'low', 'mid', 'high'] as const) {
      const target = clamp(finite(input[key]));
      const tau = target > this.value[key] ? 0.035 : 0.28;
      this.value[key] += (target - this.value[key]) * (1 - Math.exp(-dt / tau));
    }
    for (let i = 0; i < 12; i++) {
      const broad = i < 4 ? input.low : i < 8 ? input.mid : input.high;
      const target = clamp(finite(input.spectrum === undefined ? broad : input.spectrum[i] ?? 0));
      const tau = target > this.spectrum[i] ? .045 : .32;
      this.spectrum[i] += (target - this.spectrum[i]) * (1 - Math.exp(-dt / tau));
    }
    return this.snapshot();
  }

  private snapshot(): AudioFeatures {
    return { ...this.value, spectrum: [...this.spectrum], ...(this.raw ? { raw: this.raw } : {}) };
  }
}

function failureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'マイクが許可されていません。ブラウザとMacの「プライバシーとセキュリティ」でマイクを許可し、もう一度開始してください。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '選択したマイクが見つかりません。接続を確認し、別の入力を選んでください。';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'マイクを開けません。ほかのアプリの使用状況や接続を確認して、もう一度開始してください。';
  }
  return 'マイクを開始できませんでした。入力機器とブラウザの権限を確認して、もう一度開始してください。';
}

/** Captures locally for analysis only: no connection is made to AudioContext.destination. */
export class AudioInput {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private waveform = new Float32Array(2048);
  private spectrum = new Float32Array(1024);
  private envelope = new FeatureEnvelope();
  private leveler = new RawLeveler();
  private revision = 0;
  private onStatus: StatusListener;
  private lastStatus = '';

  constructor(onStatus: StatusListener = () => {}) {
    this.onStatus = onStatus;
  }

  get active(): boolean {
    return this.context?.state === 'running' && this.stream?.getAudioTracks().some(track => track.readyState === 'live') === true;
  }

  get settings(): MediaTrackSettings | null {
    return this.stream?.getAudioTracks()[0]?.getSettings() ?? null;
  }

  async devices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    } catch {
      return [];
    }
  }

  /** Invoke from a click. Failures are reported through onStatus and do not reject. */
  async start(deviceId?: string): Promise<void> {
    const ticket = ++this.revision;
    this.release();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      this.emit('error', 'この環境ではマイク入力を利用できません。MacのChromeでlocalhostから開いてください。');
      return;
    }
    this.emit('requesting', 'ブラウザのマイク使用許可を待っています。');
    let localContext: AudioContext | null = null;
    let localStream: MediaStream | null = null;
    try {
      // Start/resume synchronously inside the user gesture, before awaiting permissions.
      localContext = new AudioContext({ latencyHint: 'interactive' });
      this.context = localContext;
      const resumed = localContext.resume().catch(() => {});
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      if (ticket !== this.revision) {
        localStream.getTracks().forEach(track => track.stop());
        if (localContext.state !== 'closed') void localContext.close().catch(() => {});
        return;
      }
      this.stream = localStream;
      await resumed;
      if (ticket !== this.revision) return;
      if (localContext.state !== 'running') throw new Error('Audio context is not running');
      const analyser = localContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      this.waveform = new Float32Array(analyser.fftSize);
      this.spectrum = new Float32Array(analyser.frequencyBinCount);
      this.analyser = analyser;
      this.source = localContext.createMediaStreamSource(localStream);
      this.source.connect(analyser);
      for (const track of localStream.getAudioTracks()) {
        track.onended = () => {
          if (ticket !== this.revision) return;
          ++this.revision;
          this.release();
          this.emit('error', 'マイクとの接続が切れました。接続を確認して、もう一度開始してください。');
        };
      }
      localContext.onstatechange = () => {
        if (ticket !== this.revision) return;
        if (this.context?.state === 'running') {
          this.emit('live', 'マイクの音に反応しています。');
        } else {
          ++this.revision;
          this.release();
          this.emit('error', '音声処理が停止しました。マイクをもう一度開始してください。');
        }
      };
      this.emit('live', 'マイクの音に反応しています。');
    } catch (error) {
      if (ticket !== this.revision) {
        localStream?.getTracks().forEach(track => track.stop());
        if (localContext && localContext.state !== 'closed') void localContext.close().catch(() => {});
        return;
      }
      this.release();
      this.emit('error', failureMessage(error));
    }
  }

  stop(): void {
    ++this.revision;
    this.release();
    this.emit('idle', 'マイクは停止しています。');
  }

  sample(dt: number, sensitivity: number, bands: AudioBandGains = DEFAULT_BAND_GAINS): AudioFeatures {
    if (!this.active || !this.analyser || !this.context) return this.envelope.update(SILENCE, dt);
    this.analyser.getFloatTimeDomainData(this.waveform);
    this.analyser.getFloatFrequencyData(this.spectrum);
    const measured = measureAudio(this.waveform, this.spectrum, this.context.sampleRate, this.analyser.fftSize, sensitivity, bands);
    // Level the ungated row, then gate it. A closed gate still delivers a row
    // (all zeros), so the renderer never substitutes the decaying band controls.
    const gain = clamp(finite(sensitivity, 1), 0, SENSITIVITY_MAX);
    const raw = this.leveler.apply(rawSpectrum(this.spectrum, this.context.sampleRate, this.analyser.fftSize, gain), dt, silenceGate(waveformRms(this.waveform) * gain));
    return this.envelope.update({ ...measured, raw: raw && applyRawBandGains(raw, bands, RawLeveler.PEAK) }, dt);
  }

  private emit(status: AudioStatus, message: string): void {
    const signature = `${status}:${message}`;
    if (signature === this.lastStatus) return;
    this.lastStatus = signature;
    this.onStatus(status, message);
  }

  private release(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    }
    this.source?.disconnect();
    this.analyser?.disconnect();
    if (this.context) {
      this.context.onstatechange = null;
      if (this.context.state !== 'closed') void this.context.close().catch(() => {});
    }
    this.context = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.envelope.reset();
    this.leveler.reset();
  }
}
