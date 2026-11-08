import { MediaLayers, type LayerKind, type LayerSettings } from './media';
import { isSafeMediaFilename, mediaFileKind, MAX_MEDIA_FILE_SIZE, type MediaFolderFile, type MediaFolderListing } from './media-folder-contract';
import { MEDIA_PREFERENCES_KEY, readMediaPreferences, writeMediaPreferences, restoreMediaPreferences, type MediaPreferences } from './media-preferences';

const kinds = ['logo', 'video'] as const;
const sizeLabel = (size: number): string => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const fileUrl = (file: MediaFolderFile): string => `/media/${encodeURIComponent(file.name)}?v=${file.modified}`;

/** Folder files remain on disk; only their names and display settings are saved. */
export class MediaFolder {
  private readonly media: MediaLayers;
  private readonly sync: () => void;
  private readonly status: (kind: LayerKind, message: string, error?: boolean) => void;
  private readonly panel: HTMLElement;
  private readonly sourceChanged: (kind: LayerKind, generated: boolean) => void;
  private preferences: MediaPreferences = {};
  private readonly selected: Record<LayerKind, string | null> = { logo: null, video: null };
  private readonly editedSettings: Record<LayerKind, Partial<LayerSettings>> = { logo: {}, video: {} };
  private readonly revisions = { logo: 0, video: 0 };
  private readonly pending: Record<LayerKind, AbortController | null> = { logo: null, video: null };
  private readonly missing = new Set<LayerKind>();
  private files: MediaFolderFile[] = [];
  private path = 'public/media/';
  private available = false;
  private active = false;
  private disposed = false;
  private timer = 0;
  private listing: Promise<MediaFolderFile[] | null> | null = null;
  private listRequest: AbortController | null = null;
  private restored = false;
  private readonly visibilityChanged = () => this.setActive(this.active);

  constructor(panel: HTMLElement, media: MediaLayers, sync: () => void, status: (kind: LayerKind, message: string, error?: boolean) => void, sourceChanged: (kind: LayerKind, generated: boolean) => void = () => {}) {
    this.panel = panel; this.media = media; this.sync = sync; this.status = status;
    this.sourceChanged = sourceChanged;
    try { this.preferences = readMediaPreferences(localStorage.getItem(MEDIA_PREFERENCES_KEY)); } catch { /* Storage may be disabled. */ }
    panel.innerHTML = `<div class="media-folder-heading"><h3>素材フォルダ</h3><button id="media-folder-refresh" type="button" hidden>更新</button></div>
      <div class="media-folder-location"><button id="media-folder-open" type="button" hidden>素材フォルダを開く</button><p><span id="media-folder-path">public/media/</span><span class="media-folder-instruction">ここにファイルを入れると一覧に出ます</span></p></div>
      <button id="media-folder-copy" class="text-button" type="button">パスをコピー</button>
      <p id="media-folder-status" class="media-status" role="status">素材フォルダを確認しています…</p>
      <p id="media-folder-message" class="media-status" role="status" hidden></p>
      <div id="media-folder-list" class="media-folder-list" aria-label="フォルダ内の素材" hidden></div>
      <p class="media-folder-note">画像・動画は1ファイル200MBまで。選んだ素材と表示設定を次回も使えます。</p>`;
    this.element('media-folder-refresh').addEventListener('click', () => { void this.refresh(); });
    this.element('media-folder-open').addEventListener('click', () => { void this.open(); });
    this.element('media-folder-copy').addEventListener('click', () => { void this.copyPath(); });
    document.addEventListener('visibilitychange', this.visibilityChanged);
  }

  async initialize(): Promise<void> { await this.refresh(); }

  setActive(active: boolean): void {
    this.active = active;
    window.clearInterval(this.timer);
    this.timer = 0;
    if (!active || document.hidden || this.disposed) return;
    void this.refresh();
    this.timer = window.setInterval(() => { void this.refresh(); }, 3000);
  }

  settingsChanged(kind: LayerKind, property?: keyof LayerSettings): void {
    const fileName = this.selected[kind];
    if (!fileName) {
      if (property) {
        const change = { [property]: this.media.settings[kind][property] };
        this.editedSettings[kind] = { ...this.editedSettings[kind], ...change };
        const saved = this.preferences[kind];
        if (saved) { Object.assign(saved.settings, change); this.persist(); }
      }
      return;
    }
    this.preferences[kind] = { fileName, settings: { ...this.media.settings[kind] } };
    this.persist();
  }

  async loadFile(kind: LayerKind, file: File): Promise<void> {
    const ticket = this.begin(kind);
    if (await this.media.load(kind, file) && ticket === this.revisions[kind] && !this.disposed) {
      this.forget(kind);
      this.sourceChanged(kind, false);
      this.sync();
    }
  }

  async loadSampleLogo(): Promise<void> {
    this.begin('logo');
    await this.media.loadSampleLogo();
    this.forget('logo');
    this.sourceChanged('logo', false);
    this.sync();
  }

  /** Generated PNGs use the same validation/cancellation path as local images. */
  async loadGeneratedLogo(file: File): Promise<boolean> {
    const ticket = this.begin('logo');
    if (!await this.media.load('logo', file) || ticket !== this.revisions.logo || this.disposed) return false;
    this.forget('logo');
    this.sourceChanged('logo', true);
    this.sync();
    return true;
  }

  remove(kind: LayerKind): void {
    this.begin(kind);
    this.forget(kind);
    this.media.remove(kind);
    this.sourceChanged(kind, false);
    this.sync();
  }

  private begin(kind: LayerKind): number {
    this.pending[kind]?.abort();
    this.pending[kind] = null;
    this.media.cancelPending(kind);
    return ++this.revisions[kind];
  }

  private forget(kind: LayerKind): void {
    this.selected[kind] = null;
    this.editedSettings[kind] = {};
    this.missing.delete(kind);
    delete this.preferences[kind];
    this.persist();
    this.markSelected();
  }

  private persist(): void {
    let saved = false;
    try { saved = writeMediaPreferences(localStorage, this.preferences); } catch { /* Storage may be disabled. */ }
    if (!saved) this.message('設定を保存できませんでした。今回はそのまま使えますが、次回は選び直してください。', true);
  }

  private async load(kind: LayerKind, file: MediaFolderFile, settings?: LayerSettings): Promise<void> {
    if (this.disposed || !isSafeMediaFilename(file.name) || mediaFileKind(file.name) !== kind) return;
    const ticket = this.begin(kind);
    const controller = new AbortController();
    this.pending[kind] = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      if (file.size > MAX_MEDIA_FILE_SIZE) throw new Error('素材は200MB以下にしてください。');
      this.status(kind, '素材を読み込んでいます…');
      const response = await fetch(fileUrl(file), { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 404 ? `素材 ${file.name} が見つかりません。「更新」で一覧を確認してください。` : '素材を取得できませんでした。フォルダを確認してください。');
      if (Number(response.headers.get('content-length')) > MAX_MEDIA_FILE_SIZE) throw new Error('素材は200MB以下にしてください。');
      const blob = await response.blob();
      if (ticket !== this.revisions[kind] || this.disposed) return;
      window.clearTimeout(timeout);
      const loaded = await this.media.load(kind, new File([blob], file.name, { type: blob.type, lastModified: file.modified }));
      if (!loaded || ticket !== this.revisions[kind] || this.disposed) return;
      if (settings) Object.assign(this.media.settings[kind], settings, this.editedSettings[kind]);
      this.editedSettings[kind] = {};
      this.selected[kind] = file.name;
      this.missing.delete(kind);
      this.settingsChanged(kind);
      this.sourceChanged(kind, false);
      this.sync();
      this.markSelected();
    } catch (error) {
      if (ticket !== this.revisions[kind] || this.disposed) return;
      this.status(kind, controller.signal.aborted ? '素材の取得がタイムアウトしました。「更新」して選び直してください。' : error instanceof Error ? error.message : '素材を読み込めませんでした。', true);
    } finally {
      window.clearTimeout(timeout);
      if (this.pending[kind] === controller) this.pending[kind] = null;
    }
  }

  private refresh(): Promise<MediaFolderFile[] | null> {
    if (this.listing) return this.listing;
    if (this.disposed) return Promise.resolve(null);
    const refresh = this.element<HTMLButtonElement>('media-folder-refresh');
    refresh.disabled = true;
    this.listing = this.fetchList().finally(() => { this.listing = null; refresh.disabled = false; });
    return this.listing;
  }

  private async fetchList(): Promise<MediaFolderFile[] | null> {
    const controller = new AbortController();
    this.listRequest = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    // A user's selection during the first listing must take precedence over restoration.
    const initialRevisions = { ...this.revisions };
    try {
      const response = await fetch('/__media/list', { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('unavailable');
      const listing = await response.json() as MediaFolderListing;
      if (!listing || typeof listing.path !== 'string' || !Array.isArray(listing.files)) throw new Error('unavailable');
      if (this.disposed) return null;
      this.path = listing.path;
      const files = listing.files.filter(file => file && isSafeMediaFilename(file.name) && mediaFileKind(file.name) === file.kind && Number.isFinite(file.size) && file.size >= 0 && Number.isFinite(file.modified));
      const changed = JSON.stringify(files) !== JSON.stringify(this.files);
      this.files = files;
      this.available = true;
      this.element('media-folder-path').textContent = this.path;
      for (const id of ['media-folder-open', 'media-folder-refresh', 'media-folder-list']) this.element(id).hidden = false;
      const listStatus = files.length ? `${files.length}件 · タブを開いている間は3秒ごとに更新` : 'まだ素材がありません。フォルダに画像や動画を入れてください。';
      if (this.element('media-folder-status').textContent !== listStatus) this.element('media-folder-status').textContent = listStatus;
      this.element('media-folder-status').dataset.error = 'false';
      if (changed) this.renderList();
      if (!this.restored) {
        this.restored = true;
        const pending: MediaPreferences = {};
        for (const kind of kinds) if (initialRevisions[kind] === this.revisions[kind] && this.revisions[kind] === 0 && this.preferences[kind]) pending[kind] = this.preferences[kind];
        // Decoding a large saved file must not block future directory refreshes.
        void restoreMediaPreferences(pending, files, async (kind, file, settings) => {
          if (this.revisions[kind] === 0) await this.load(kind, file, settings);
        }, (kind, message) => {
          if (this.revisions[kind] !== 0 || this.disposed) return;
          this.status(kind, message, true);
          document.getElementById(`${kind}-remove`)?.removeAttribute('disabled');
        });
      }
      for (const kind of kinds) {
        const name = this.selected[kind];
        if (!name) continue;
        if (!files.some(file => file.kind === kind && file.name === name)) {
          if (!this.missing.has(kind)) {
            this.missing.add(kind);
            this.status(kind, `素材 ${name} がフォルダにありません。現在の表示は続きますが、次回は復元できません。`, true);
          }
        } else if (this.missing.delete(kind)) this.status(kind, name);
      }
      return files;
    } catch {
      if (this.disposed) return null;
      this.element('media-folder-status').textContent = this.available
        ? '一覧を更新できませんでした。ローカルサーバーの起動を確認して「更新」を押してください。'
        : 'この環境ではフォルダ一覧を使えません。プロジェクトの public/media/ に素材を置き、npm run dev または npm run preview で開いてください。その場で使う素材は下の「画像を選ぶ」「動画を選ぶ」から読み込めます。';
      this.element('media-folder-status').dataset.error = String(this.available);
      return null;
    } finally {
      window.clearTimeout(timeout);
      if (this.listRequest === controller) this.listRequest = null;
    }
  }

  private renderList(): void {
    const list = this.element('media-folder-list');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.fileName : undefined;
    list.replaceChildren(...this.files.map(file => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'media-folder-item'; button.dataset.fileName = file.name;
      button.title = `${file.name}\n${sizeLabel(file.size)} · ${new Date(file.modified).toLocaleString('ja-JP')}`;
      const thumbnail = file.kind === 'logo' && file.size <= MAX_MEDIA_FILE_SIZE ? document.createElement('img') : document.createElement('span');
      if (thumbnail instanceof HTMLImageElement) { thumbnail.src = fileUrl(file); thumbnail.alt = ''; thumbnail.loading = 'lazy'; }
      else { thumbnail.className = 'media-folder-type'; thumbnail.textContent = file.kind === 'video' ? '動画' : '画像'; }
      const text = document.createElement('span'); text.className = 'media-folder-item-text';
      const name = document.createElement('span'); name.className = 'media-folder-item-name'; name.textContent = file.name;
      const detail = document.createElement('span'); detail.className = 'media-folder-item-detail'; detail.textContent = `${file.kind === 'logo' ? 'ロゴ・画像' : '動画'} · ${sizeLabel(file.size)}${file.size > MAX_MEDIA_FILE_SIZE ? ' · 上限を超えています' : ''}`;
      text.append(name, detail); button.append(thumbnail, text);
      button.addEventListener('click', () => { void this.load(file.kind, file); });
      return button;
    }));
    this.markSelected();
    if (focused) Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.fileName === focused)?.focus({ preventScroll: true });
  }

  private markSelected(): void {
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-file-name]')) button.setAttribute('aria-pressed', String(kinds.some(kind => this.selected[kind] === button.dataset.fileName)));
  }

  private async open(): Promise<void> {
    const button = this.element<HTMLButtonElement>('media-folder-open');
    button.disabled = true;
    try {
      const response = await fetch('/__media/open', { method: 'POST', signal: AbortSignal.timeout(5000), credentials: 'same-origin' });
      if (!response.ok) throw new Error('open failed');
      this.message('フォルダを開くようOSへ依頼しました。');
    } catch {
      this.message('フォルダを開けませんでした。「パスをコピー」からFinderなどで開いてください。', true);
      this.element('media-folder-copy').focus();
    } finally { button.disabled = false; }
  }

  private async copyPath(): Promise<void> {
    try { await navigator.clipboard.writeText(this.path); this.message('フォルダのパスをコピーしました。'); }
    catch {
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(this.element('media-folder-path'));
      selection?.removeAllRanges(); selection?.addRange(range);
      this.message('パスを選択しました。⌘C または Ctrl+C でコピーしてください。');
    }
  }

  private message(text: string, error = false): void {
    const message = this.element('media-folder-message');
    message.hidden = false; message.textContent = text; message.dataset.error = String(error);
    // Saving can fail while the picker is collapsed; keep the warning visible.
    const details = this.panel.closest('details');
    if (error && details) details.open = true;
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T { return this.panel.querySelector<T>(`#${id}`)!; }

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.timer);
    this.listRequest?.abort();
    for (const kind of kinds) this.begin(kind);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
  }
}
