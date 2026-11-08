import { CameraInput, type CameraState, type TrackingMode } from './camera';
import { shoulderTilt, TiltController } from './pose';
import { measureFace, FaceMotionController, sampleFaceDemo, type FaceMeasurement } from './face';
import { CAMERA_PREFERENCES_KEY, readCameraPreferences, writeCameraPreferences, type PerformanceMode } from './camera-preferences';
import type { SharedCameraFrame } from './shared-camera';

function control<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing camera control: ${id}`);
  return found as T;
}
export type CameraMotionSettings = {
  cameraTilt: number;
  cameraOffset: [number, number];
  cameraYaw: number;
  cameraPitch: number;
};
const zeroMotion = (): CameraMotionSettings => ({ cameraTilt: 0, cameraOffset: [0, 0], cameraYaw: 0, cameraPitch: 0 });
function savedCameraPreferences() {
  try { return readCameraPreferences(localStorage.getItem(CAMERA_PREFERENCES_KEY)); }
  catch { return readCameraPreferences(null); }
}
export type CameraPresentationFrame = {
  cameraFrame: SharedCameraFrame | null;
  performanceMode: PerformanceMode;
  liveOpacity: number;
  cameraMirror: boolean;
};

/** Input, recognition and presentation share one source but keep separate controls and status. */
export class CameraControls {
  private readonly video = control<HTMLVideoElement>('camera-video');
  private readonly startButton = control<HTMLButtonElement>('camera-start');
  private readonly demoButton = control<HTMLButtonElement>('camera-demo');
  private readonly device = control<HTMLSelectElement>('camera-device');
  private readonly tracking = control<HTMLSelectElement>('camera-tracking');
  private readonly mirror = control<HTMLInputElement>('camera-mirror');
  private readonly calibrateButton = control<HTMLButtonElement>('camera-calibrate');
  private readonly status = control('camera-status');
  private readonly inputStatus = control('camera-input-status');
  private readonly preferences = savedCameraPreferences();
  private readonly onChange: () => void;
  private readonly input: CameraInput;
  private readonly tilt = new TiltController();
  private readonly face = new FaceMotionController();
  private motionValue = zeroMotion();
  private demo = false;
  private demoTime = 0;
  private raw: number | null = null;
  private faceRaw: FaceMeasurement | null = null;
  private available = true;
  private disposed = false;
  private refreshRevision = 0;
  private state: CameraState = 'idle';
  private lastUI = 0;
  private latestFrame: SharedCameraFrame | null = null;
  private trackingMessage = '動きの追跡は停止しています。';
  private trackingError = false;
  private readonly pageHidden = () => this.dispose();
  private readonly deviceChanged = () => { void this.refreshDevices(); };
  private get mode(): TrackingMode { return this.tracking.value === 'body' ? 'body' : 'face'; }
  private get tracked(): boolean { return this.mode === 'face' ? this.faceRaw !== null : this.raw !== null; }
  private get setupHint(): string { return this.mode === 'face' ? '顔全体を映してください。最初の姿勢が基準になります。' : '上半身と両肩が映る位置に置いてください。'; }

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
    this.input = new CameraInput(this.video, (state, message) => {
      this.state = state;
      this.inputStatus.textContent = message;
      this.inputStatus.dataset.error = String(state === 'error' || state === 'reconnecting');
      if (state !== 'running') this.latestFrame = null;
      if (state === 'running') {
        const resolved = this.input.resolvedSelection;
        if (resolved) { this.preferences.deviceId = resolved.deviceId; this.preferences.label = resolved.label; this.savePreferences(); }
        void this.refreshDevices();
      }
      this.syncControls();
      this.onChange();
    }, (state, message) => {
      this.trackingMessage = message; this.trackingError = state === 'error';
      if (!this.demo) { this.status.textContent = message; this.status.dataset.error = String(state === 'error'); }
      this.onChange();
    });
    control('camera-sensitivity-control').innerHTML = '<label class="parameter" for="camera-sensitivity"><span>動きの反応量<output id="camera-sensitivity-value" for="camera-sensitivity">1.00×</output></span><input id="camera-sensitivity" type="range" min="0.2" max="2" step="0.05" value="1" /></label>';
    const sensitivity = control<HTMLInputElement>('camera-sensitivity');
    const syncSensitivity = () => {
      control<HTMLOutputElement>('camera-sensitivity-value').value = `${Number(sensitivity.value).toFixed(2)}×`;
      sensitivity.style.setProperty('--fill', `${100 * (Number(sensitivity.value) - .2) / 1.8}%`);
      this.onChange();
    };
    sensitivity.addEventListener('input', syncSensitivity);
    syncSensitivity();
    this.startButton.addEventListener('click', () => {
      if (this.state === 'starting' || this.state === 'running' || this.state === 'reconnecting') this.input.stop();
      else { this.setDemo(false); this.startInput(); }
    });
    this.demoButton.addEventListener('click', () => this.setDemo(!this.demo));
    this.device.addEventListener('change', () => {
      this.preferences.deviceId = this.device.value;
      this.preferences.label = this.device.selectedOptions[0]?.dataset.cameraLabel ?? '';
      this.savePreferences();
      if (this.state === 'running' || this.state === 'starting' || this.state === 'reconnecting') this.startInput();
      this.onChange();
    });
    this.tracking.addEventListener('change', () => {
      this.resetTracking();
      void this.input.setTrackingMode(this.mode);
      if (this.demo) this.setDemo(true);
      else if (this.state !== 'running') { this.status.textContent = this.setupHint; this.status.dataset.error = 'false'; }
      this.syncControls();
      this.onChange();
    });
    this.mirror.addEventListener('change', () => { this.syncControls(); this.onChange(); });
    this.calibrateButton.addEventListener('click', () => {
      const frame = this.input.sample();
      const calibrated = this.mode === 'face' ? this.face.calibrate(measureFace(frame)) : this.tilt.calibrate(shoulderTilt(frame));
      if (calibrated) this.status.textContent = this.mode === 'face' ? '今の顔の位置・傾き・向きを基準にしました。' : '今の姿勢を水平の基準にしました。';
      this.onChange();
    });
    for (const id of ['camera-effect-tilt', 'camera-effect-shift', 'camera-effect-turn']) control(id).addEventListener('change', this.onChange);
    control<HTMLInputElement>('camera-auto-start').checked = this.preferences.autoStart;
    control<HTMLInputElement>('camera-image-mirror').checked = this.preferences.mirror;
    control<HTMLInputElement>('live-opacity').value = String(this.preferences.opacity);
    control('camera-auto-start').addEventListener('change', () => {
      this.preferences.autoStart = control<HTMLInputElement>('camera-auto-start').checked;
      this.savePreferences(); this.onChange();
    });
    control('camera-image-mirror').addEventListener('change', () => {
      this.preferences.mirror = control<HTMLInputElement>('camera-image-mirror').checked;
      this.savePreferences(); this.syncControls(); this.onChange();
    });
    control('live-opacity').addEventListener('input', () => {
      this.preferences.opacity = Math.max(0, Math.min(1, Number(control<HTMLInputElement>('live-opacity').value) || 0));
      this.savePreferences(); this.syncPresentation(); this.onChange();
    });
    for (const mode of ['dj', 'live'] as const) control(`performance-${mode}`).addEventListener('click', () => {
      this.preferences.mode = mode;
      this.savePreferences(); this.syncPresentation(); this.onChange();
    });
    navigator.mediaDevices?.addEventListener('devicechange', this.deviceChanged);
    window.addEventListener('pagehide', this.pageHidden);
    void this.refreshDevices();
    this.syncControls();
    this.syncPresentation();
    // Consent is restored only from an explicitly saved opt-in, never from camera selection.
    if (this.preferences.autoStart) this.startInput();
  }

  get active(): boolean { return this.input.active; }
  presentationFrame(): CameraPresentationFrame {
    return { cameraFrame: this.active ? this.latestFrame : null, performanceMode: this.preferences.mode,
      liveOpacity: this.preferences.opacity, cameraMirror: this.preferences.mirror };
  }
  private savePreferences(): void {
    try { localStorage.setItem(CAMERA_PREFERENCES_KEY, writeCameraPreferences(this.preferences)); }
    catch { /* Camera use remains available if browser storage is disabled. */ }
  }
  private syncPresentation(): void {
    control('performance-dj').setAttribute('aria-pressed', String(this.preferences.mode === 'dj'));
    control('performance-live').setAttribute('aria-pressed', String(this.preferences.mode === 'live'));
    control('live-camera-controls').hidden = this.preferences.mode !== 'live';
    control<HTMLOutputElement>('live-opacity-value').value = `${Math.round(this.preferences.opacity * 100)}%`;
    control<HTMLInputElement>('live-opacity').style.setProperty('--fill', `${this.preferences.opacity * 100}%`);
  }

  private resetTracking(): void {
    this.face.reset(); this.tilt.reset(); this.raw = null; this.faceRaw = null;
    // Keep motionValue so changing inputs eases from the previous image, including after pause.
  }
  private startInput(): void {
    this.resetTracking();
    void this.input.start({ deviceId: this.preferences.deviceId, label: this.preferences.label }, this.mode);
  }
  private async refreshDevices(): Promise<void> {
    const revision = ++this.refreshRevision;
    const list = await this.input.devices();
    if (this.disposed || revision !== this.refreshRevision) return;
    const selected = this.preferences.deviceId;
    this.device.replaceChildren(new Option('標準のカメラ', ''));
    list.forEach((entry, index) => {
      if (entry.deviceId && entry.deviceId !== 'default') {
        const option = new Option(entry.label || `カメラ ${index + 1}`, entry.deviceId);
        option.dataset.cameraLabel = entry.label;
        this.device.add(option);
      }
    });
    if (selected && ![...this.device.options].some(option => option.value === selected)) {
      const missing = new Option(`${this.preferences.label || '選んだカメラ'}（未接続）`, selected);
      missing.dataset.cameraLabel = this.preferences.label;
      this.device.add(missing);
    }
    this.device.value = selected;
    this.onChange();
  }

  private setDemo(enabled: boolean): void {
    this.demo = enabled;
    if (enabled) {
      this.demoTime = 0; this.resetTracking();
      this.status.textContent = this.mode === 'face' ? '顔の傾き・移動・向きをデモで再現しています。' : '左右の揺れをデモで再現しています。';
      this.status.dataset.error = 'false';
    } else {
      this.status.textContent = this.state === 'running' || this.state === 'starting' ? this.trackingMessage : this.setupHint;
      this.status.dataset.error = String(this.state === 'running' && this.trackingError);
    }
    this.syncControls();
    this.onChange();
  }

  private syncControls(): void {
    const running = this.state === 'running', face = this.mode === 'face';
    this.startButton.textContent = this.state === 'starting' ? '接続を中止' : this.state === 'reconnecting' ? '再接続を中止' : running ? 'カメラを停止' : 'カメラを開始';
    this.startButton.setAttribute('aria-pressed', String(running));
    this.demoButton.textContent = this.demo ? 'デモを停止' : face ? '顔の動きを試す' : '揺れを試す';
    this.demoButton.setAttribute('aria-pressed', String(this.demo));
    control('camera-demo-indicator').hidden = !this.demo;
    this.video.hidden = !running;
    this.video.dataset.mirrored = String(this.preferences.mirror);
    control('camera-figure').style.display = running ? 'none' : '';
    control('camera-face').toggleAttribute('hidden', !face);
    control('camera-body').toggleAttribute('hidden', face);
    control('camera-face-effects').hidden = !face;
    this.startButton.disabled = !this.available;
    this.demoButton.disabled = !this.available;
    this.device.disabled = !this.available;
    this.tracking.disabled = !this.available;
    this.calibrateButton.textContent = face ? '今の顔を基準にする' : '今の姿勢を水平にする';
    this.calibrateButton.disabled = !running || !this.tracked || this.demo;
  }

  update(now: number, dt: number): CameraMotionSettings {
    const hadFrame = this.latestFrame !== null;
    this.latestFrame = this.input.captureFrame(now);
    if (hadFrame !== (this.latestFrame !== null)) this.onChange();
    if (this.latestFrame) this.input.submit(this.latestFrame);
    if (this.demo && dt > 0) this.demoTime += Math.min(dt, .1);
    const frame = this.input.sample(now);
    this.raw = this.mode === 'body' ? this.demo ? Math.sin(this.demoTime * 1.15) * .3 : shoulderTilt(frame) : null;
    this.faceRaw = this.mode === 'face' ? this.demo ? sampleFaceDemo(this.demoTime) : measureFace(frame) : null;
    const options = { mirrored: this.mirror.checked, sensitivity: Number(control<HTMLInputElement>('camera-sensitivity').value) };
    const bodyAngle = this.tilt.update(this.raw, dt, options);
    const face = this.face.update(this.faceRaw, dt, {
      ...options,
      tilt: control<HTMLInputElement>('camera-effect-tilt').checked,
      shift: control<HTMLInputElement>('camera-effect-shift').checked,
      turn: control<HTMLInputElement>('camera-effect-turn').checked,
    });
    const target: CameraMotionSettings = this.mode === 'face'
      ? { cameraTilt: face.roll, cameraOffset: [face.shiftX, face.shiftY], cameraYaw: face.yaw, cameraPitch: face.pitch }
      : { cameraTilt: bodyAngle, cameraOffset: [0, 0], cameraYaw: 0, cameraPitch: 0 };
    if (Number.isFinite(dt) && dt > 0) {
      const alpha = 1 - Math.exp(-Math.min(dt, .25) / .1);
      const smooth = (a: number, b: number) => a + (b - a) * alpha;
      this.motionValue = {
        cameraTilt: smooth(this.motionValue.cameraTilt, target.cameraTilt),
        cameraOffset: [smooth(this.motionValue.cameraOffset[0], target.cameraOffset[0]), smooth(this.motionValue.cameraOffset[1], target.cameraOffset[1])],
        cameraYaw: smooth(this.motionValue.cameraYaw, target.cameraYaw),
        cameraPitch: smooth(this.motionValue.cameraPitch, target.cameraPitch),
      };
    }
    if (now - this.lastUI > 80) {
      this.lastUI = now;
      const m = this.motionValue;
      control('camera-body').style.transform = `rotate(${m.cameraTilt}rad)`;
      control('camera-face').style.transform = `translate(${m.cameraOffset[0] * 200}px, ${m.cameraOffset[1] * 150}px) rotate(${m.cameraTilt}rad) scaleX(${Math.cos(m.cameraYaw * 2)})`;
      control('camera-nose').style.transform = `translate(${Math.sin(m.cameraYaw * 2) * 22}px, ${-Math.sin(m.cameraPitch * 2) * 15}px)`;
      control('camera-preview-label').textContent = this.demo ? this.mode === 'face' ? '顔の動きのデモ' : 'スウェイデモ' : this.state === 'starting' ? '準備中…' : this.state === 'running' ? this.tracked ? this.mode === 'face' ? '顔を追跡中' : '両肩を追跡中' : this.mode === 'face' ? '顔が映る位置へ' : '両肩が映る位置へ' : 'カメラはオフ';
      this.calibrateButton.disabled = this.state !== 'running' || !this.tracked || this.demo;
    }
    return this.motionValue;
  }

  setAvailable(available: boolean): void {
    this.available = available;
    if (!available) { this.setDemo(false); this.input.stop(); }
    this.syncControls();
  }
  stop(): void { this.setDemo(false); this.input.stop(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.demo = false; this.latestFrame = null; this.input.dispose();
    navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChanged);
    window.removeEventListener('pagehide', this.pageHidden);
  }
}
