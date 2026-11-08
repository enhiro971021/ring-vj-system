import './logo-maker-controls.css';
import { normalizeHex } from './color';
import { TEXT_FONTS, MAX_TEXT_CHARACTERS } from './text-fonts';
import { LOGO_TEMPLATES, normalizeLogoDesign, renderLogoDesign, type LogoDesign } from './logo-design';

/** A local draft editor. Applying a logo is explicit and belongs to MediaLayers. */
export function createLogoMakerControls(
  container: HTMLElement,
  initial: LogoDesign,
  onChange: (design: LogoDesign) => void,
  onApply: (design: LogoDesign) => Promise<boolean>,
  getPalette: () => readonly string[],
) {
  let design = normalizeLogoDesign(initial);
  let composing = false, applying = false, downloading = false, disposed = false;
  let previewAvailable = false;
  let selectedColor = design.color === '#ffffff' ? 'white' : design.color === '#000000' ? 'black' : 'custom';
  let previewKey = '';
  const events = new AbortController();
  const signal = events.signal;
  const downloadURLs = new Set<string>();
  container.classList.add('logo-maker-controls');
  // Authored markup only; entered text is assigned through value/textContent.
  container.innerHTML = `
    <p class="logo-maker-intro">名前とデザインを選んで、透過ロゴを作れます。</p>
    <label class="logo-maker-field" for="logo-maker-text"><span>ロゴに入れる文字</span><textarea id="logo-maker-text" rows="2" placeholder="名前を入力" spellcheck="false" aria-describedby="logo-maker-text-hint logo-maker-count"></textarea></label>
    <div class="logo-maker-input-meta"><span id="logo-maker-text-hint">2行・120文字まで</span><output id="logo-maker-count" for="logo-maker-text"></output></div>
    <fieldset class="logo-maker-templates"><legend>デザイン</legend><div id="logo-maker-template-options" class="logo-maker-template-options" role="group" aria-label="ロゴのデザイン"></div></fieldset>
    <label class="logo-maker-field" for="logo-maker-font"><span>フォント</span><select id="logo-maker-font"></select></label>
    <fieldset class="logo-maker-colors"><legend>色</legend><div class="logo-maker-color-options">
      <button type="button" data-logo-color="white">白</button><button type="button" data-logo-color="black">黒</button>
      <button type="button" data-logo-color="palette0">配色1</button><button type="button" data-logo-color="palette1">配色2</button><button type="button" data-logo-color="palette2">配色3</button><button type="button" data-logo-color="custom">任意</button>
    </div><div class="logo-maker-custom-color"><input id="logo-maker-color" type="color" aria-label="任意のロゴ色"><input id="logo-maker-hex" type="text" aria-label="ロゴ色のHEXコード" spellcheck="false" maxlength="7"></div>
    <p class="logo-maker-hint">選んだ色は、背景の配色を変えても保ちます。</p><p id="logo-maker-color-error" class="logo-maker-error" role="status"></p></fieldset>
    <div class="logo-maker-actions"><button id="logo-maker-apply" class="logo-maker-primary" type="button">ロゴとして使う</button><button id="logo-maker-download" type="button">透過PNGを保存</button></div>
    <p id="logo-maker-status" class="logo-maker-status" role="status" aria-live="polite"></p>`;
  const find = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const input = find<HTMLTextAreaElement>('logo-maker-text');
  const font = find<HTMLSelectElement>('logo-maker-font');
  const picker = find<HTMLInputElement>('logo-maker-color');
  const hex = find<HTMLInputElement>('logo-maker-hex');
  const apply = find<HTMLButtonElement>('logo-maker-apply');
  const download = find<HTMLButtonElement>('logo-maker-download');
  const status = find<HTMLParagraphElement>('logo-maker-status');
  const templates = LOGO_TEMPLATES.map(template => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'logo-maker-template';
    button.dataset.logoTemplate = template.id;
    button.setAttribute('aria-label', `${template.label}のデザイン`);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = template.label;
    button.append(canvas, label);
    find('logo-maker-template-options').append(button);
    return { template, button, canvas };
  });
  for (const entry of TEXT_FONTS) {
    const option = new Option(entry.label, entry.id);
    option.style.fontFamily = entry.family;
    option.style.fontWeight = String(entry.weight);
    font.add(option);
  }
  const colorButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-logo-color]')];
  const colorFor = (source: string): string => source === 'white' ? '#ffffff' : source === 'black' ? '#000000'
    : source.startsWith('palette') ? normalizeHex(getPalette()[Number(source.slice(-1))] ?? '') ?? design.color
    : design.color;
  const updateActions = () => {
    const empty = !design.text.trim();
    apply.disabled = empty || !previewAvailable || applying;
    download.disabled = empty || !previewAvailable || downloading;
    apply.textContent = applying ? '反映中…' : 'ロゴとして使う';
    download.textContent = downloading ? '保存中…' : '透過PNGを保存';
    apply.setAttribute('aria-busy', String(applying));
  };
  const setStatus = (message: string, error = false) => {
    if (disposed) return;
    status.textContent = message;
    status.dataset.error = String(error);
  };
  const sync = () => {
    if (disposed) return;
    if (!composing && input.value !== design.text) input.value = design.text;
    find<HTMLOutputElement>('logo-maker-count').value = `${Array.from(design.text).length}/${MAX_TEXT_CHARACTERS}`;
    font.value = design.font;
    const selectedFont = TEXT_FONTS.find(entry => entry.id === design.font)!;
    input.style.fontFamily = selectedFont.family;
    input.style.fontWeight = String(selectedFont.weight);
    // The checkerboard is a preview background only; exported PNG stays clear.
    const rgb = design.color.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255);
    container.dataset.lightPreview = String(rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < .35);
    const nextPreviewKey = JSON.stringify([design.text, design.font, design.color]);
    for (const entry of templates) {
      const selected = entry.template.id === design.template;
      entry.button.setAttribute('aria-pressed', String(selected));
      entry.button.tabIndex = selected ? 0 : -1;
    }
    if (nextPreviewKey !== previewKey || !previewAvailable) {
      previewAvailable = false;
      try {
        for (const entry of templates) renderLogoDesign({ ...design, template: entry.template.id }, entry.canvas);
        previewKey = nextPreviewKey;
        previewAvailable = true;
      } catch {
        setStatus('プレビューを作成できませんでした。文字を短くして、もう一度試してください。', true);
      }
    }
    if (colorFor(selectedColor) !== design.color) selectedColor = 'custom';
    for (const button of colorButtons) {
      const source = button.dataset.logoColor!;
      button.style.setProperty('--logo-swatch', colorFor(source));
      button.setAttribute('aria-pressed', String(source === selectedColor));
    }
    picker.value = hex.value = design.color;
    hex.removeAttribute('aria-invalid');
    find('logo-maker-color-error').textContent = '';
    updateActions();
  };
  const edit = (patch: Partial<LogoDesign>) => {
    const next = normalizeLogoDesign({ ...design, ...patch });
    if (JSON.stringify(next) === JSON.stringify(design)) { sync(); return; }
    design = next;
    setStatus('');
    sync();
    onChange({ ...design });
  };
  const acceptInput = () => {
    if (composing) return;
    const start = input.selectionStart, end = input.selectionEnd;
    edit({ text: input.value });
    input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length));
  };
  input.addEventListener('compositionstart', () => { composing = true; }, { signal });
  input.addEventListener('compositionend', () => { composing = false; acceptInput(); }, { signal });
  input.addEventListener('input', acceptInput, { signal });
  font.addEventListener('change', () => edit({ font: font.value as LogoDesign['font'] }), { signal });
  for (const [index, entry] of templates.entries()) {
    entry.button.addEventListener('click', () => edit({ template: entry.template.id }), { signal });
    entry.button.addEventListener('keydown', event => {
      let target: number;
      if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = templates.length - 1;
      else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 2 : -2;
        target = (index + delta + templates.length) % templates.length;
      } else return;
      event.preventDefault(); event.stopPropagation();
      edit({ template: templates[target].template.id });
      templates[target].button.focus();
    }, { signal });
  }
  for (const button of colorButtons) button.addEventListener('click', () => {
    selectedColor = button.dataset.logoColor!;
    edit({ color: colorFor(selectedColor) });
    if (selectedColor === 'custom') hex.focus();
  }, { signal });
  picker.addEventListener('input', () => { selectedColor = 'custom'; edit({ color: picker.value }); }, { signal });
  hex.addEventListener('change', () => {
    const color = normalizeHex(hex.value);
    if (color) { selectedColor = 'custom'; edit({ color }); }
    else { hex.setAttribute('aria-invalid', 'true'); find('logo-maker-color-error').textContent = '#ffffff のようなHEXコードを入力してください。'; }
  }, { signal });
  apply.addEventListener('click', async () => {
    if (apply.disabled || disposed) return;
    const snapshot = { ...design };
    applying = true; setStatus(''); updateActions();
    try {
      const applied = await onApply(snapshot);
      if (applied) setStatus(JSON.stringify(snapshot) === JSON.stringify(design)
        ? 'ロゴに反映しました。大きさや回転は、ロゴ欄で調整できます。'
        : 'ロゴに反映しました。編集後の内容は、もう一度ボタンで反映できます。');
      else setStatus('ロゴを反映できませんでした。もう一度試してください。', true);
    } catch { setStatus('ロゴを反映できませんでした。もう一度試してください。', true); }
    finally { applying = false; if (!disposed) updateActions(); }
  }, { signal });
  download.addEventListener('click', () => {
    if (download.disabled || disposed) return;
    const snapshot = { ...design };
    downloading = true; setStatus(''); updateActions();
    try {
      renderLogoDesign(snapshot).canvas.toBlob(blob => {
        downloading = false;
        if (disposed) return;
        updateActions();
        if (!blob) { setStatus('PNGを作成できませんでした。もう一度試してください。', true); return; }
        const url = URL.createObjectURL(blob);
        downloadURLs.add(url);
        const link = document.createElement('a');
        const name = snapshot.text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, '-').slice(0, 32) || 'text';
        link.href = url; link.download = `logo-${snapshot.template}-${name}.png`;
        document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.delete(url); }, 1000);
        setStatus('透過PNGのダウンロードを開始しました。');
      }, 'image/png');
    } catch { downloading = false; updateActions(); setStatus('PNGを作成できませんでした。もう一度試してください。', true); }
  }, { signal });
  sync();
  return {
    update(value: LogoDesign) { if (!disposed) { design = normalizeLogoDesign(value); sync(); } },
    dispose() {
      if (disposed) return;
      disposed = true; events.abort();
      for (const url of downloadURLs) URL.revokeObjectURL(url);
      downloadURLs.clear(); container.replaceChildren(); container.classList.remove('logo-maker-controls');
      delete container.dataset.lightPreview;
    },
  };
}
