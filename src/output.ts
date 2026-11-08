type OutputStatus = (message: string, error?: boolean) => void;

/** Shares only the composed canvas, never the operator controls or microphone audio. */
export class OutputWindow {
  private readonly canvas: HTMLCanvasElement;
  private readonly onStatus: OutputStatus;
  private popup: Window | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private poll: number | null = null;
  private idleTimer: number | null = null;
  private revision = 0;
  private readonly onPageHide = () => this.close();

  constructor(canvas: HTMLCanvasElement, onStatus: OutputStatus = () => {}) {
    this.canvas = canvas;
    this.onStatus = onStatus;
    window.addEventListener('pagehide', this.onPageHide);
  }

  get isOpen(): boolean { return this.popup !== null && !this.popup.closed; }

  /** Must run synchronously from a user click so popup permission can be granted. */
  open(): void {
    if (this.isOpen) { this.popup?.focus(); return; }
    this.cleanup(false);
    if (!this.canvas.captureStream) {
      this.onStatus('このブラウザでは別画面への映像出力を使えません。Chromeで開いてください。', true);
      return;
    }
    const popup = window.open('about:blank', '_blank', 'popup,width=1280,height=720');
    if (!popup) {
      this.onStatus('出力画面がブロックされました。このサイトのポップアップを許可して、もう一度開いてください。', true);
      return;
    }
    this.popup = popup;
    const ticket = ++this.revision;
    try {
      const doc = popup.document;
      doc.title = '映像出力 — RING VJ System';
      doc.documentElement.lang = 'ja';
      const style = doc.createElement('style');
      style.textContent = `
        *{box-sizing:border-box;cursor:none}html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
        body{font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#f2f5f8}
        video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
        .tools{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:14px;align-items:center;max-width:calc(100% - 32px);padding:12px 16px;border:1px solid #ffffff22;border-radius:9px;background:#10151ee8;transition:opacity 150ms;white-space:nowrap}
        button{font:inherit;color:inherit;background:#ffffff15;border:1px solid #ffffff25;padding:9px 13px;border-radius:6px}
        button:focus-visible{outline:2px solid #c5ddf1;outline-offset:3px}.hint{color:#c2cad4;font-size:12px}
        .idle .tools{opacity:0;pointer-events:none}.tools:focus-within{opacity:1;pointer-events:auto}
        @media(max-width:650px){.hint{display:none}.tools{bottom:12px}}
        @media(prefers-reduced-motion:reduce){.tools{transition:none}}
      `;
      doc.head.append(style);
      const video = doc.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('aria-label', '合成済みのVJ映像');
      const controls = doc.createElement('div');
      controls.className = 'tools';
      const hint = doc.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'この画面を投影先へ移して、全画面にします';
      const fullscreen = doc.createElement('button');
      fullscreen.type = 'button';
      fullscreen.textContent = '全画面にする';
      controls.append(hint, fullscreen);
      doc.body.replaceChildren(video, controls);
      this.video = video;
      // Request the full render rate; the browser delivers what the canvas and display allow.
      this.stream = this.canvas.captureStream(60);
      video.srcObject = this.stream;
      void video.play().catch(() => {
        if (ticket === this.revision) this.onStatus('出力画面をクリックして、映像の再生を開始してください。', true);
      });
      const reveal = () => {
        if (ticket !== this.revision || popup.closed) return;
        doc.body.classList.remove('idle');
        if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => {
          if (!popup.closed) doc.body.classList.add('idle');
        }, 2200);
      };
      const toggleFullscreen = async () => {
        try {
          if (doc.fullscreenElement) await doc.exitFullscreen();
          else await doc.documentElement.requestFullscreen();
        } catch {
          this.onStatus('出力画面を全画面にできません。出力側のブラウザメニューから切り替えてください。', true);
        }
      };
      fullscreen.addEventListener('click', () => {
        void video.play().catch(() => {});
        void toggleFullscreen();
      });
      video.addEventListener('click', () => { void video.play().catch(() => {}); reveal(); });
      video.addEventListener('dblclick', () => { void toggleFullscreen(); });
      doc.addEventListener('mousemove', reveal);
      doc.addEventListener('pointerdown', reveal);
      doc.addEventListener('fullscreenchange', () => {
        fullscreen.textContent = doc.fullscreenElement ? '全画面を終了' : '全画面にする';
        fullscreen.blur();
        reveal();
      });
      doc.addEventListener('keydown', event => {
        if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.code === 'KeyF') { event.preventDefault(); void toggleFullscreen(); }
        if (event.code === 'Escape') reveal();
      });
      popup.addEventListener('pagehide', () => {
        if (ticket !== this.revision) return;
        this.cleanup(false);
        this.onStatus('出力画面を閉じました。');
      }, { once: true });
      this.poll = window.setInterval(() => {
        if (!popup.closed || ticket !== this.revision) return;
        this.cleanup(false);
        this.onStatus('出力画面を閉じました。');
      }, 500);
      reveal();
      this.onStatus('映像出力を開きました。投影先の画面へ移して全画面にしてください。');
    } catch {
      this.cleanup(true);
      this.onStatus('映像出力を開始できませんでした。Chromeで開き直して試してください。', true);
    }
  }

  close(): void {
    const wasOpen = this.isOpen;
    this.cleanup(true);
    if (wasOpen) this.onStatus('出力画面を閉じました。');
  }

  dispose(): void {
    this.close();
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private cleanup(closeWindow: boolean): void {
    ++this.revision;
    if (this.poll !== null) window.clearInterval(this.poll);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.poll = this.idleTimer = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.stream?.getTracks().forEach(track => track.stop());
    const popup = this.popup;
    this.stream = null;
    this.video = null;
    this.popup = null;
    if (closeWindow && popup && !popup.closed) popup.close();
  }
}
