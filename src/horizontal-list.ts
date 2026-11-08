/** Browse a circular collection without duplicating its controls or IDs. */
export function horizontalList(viewport: HTMLElement, previous: HTMLButtonElement, next: HTMLButtonElement) {
  let lastSelected: HTMLElement | null = null;
  let cards: HTMLElement[] = [];
  let start = 0;
  let step = 0;
  let maximum = 0;
  let pointerFocus = false;
  const modulo = (value: number, length: number) => ((value % length) + length) % length;

  function order(first: number): void {
    start = modulo(first, cards.length);
    cards.forEach((card, index) => { card.style.order = String(modulo(index - start, cards.length)); });
  }
  function measure(resized = false): void {
    const children = [...viewport.children] as HTMLElement[];
    const changed = children.length !== cards.length || children.some((card, index) => card !== cards[index]);
    if (changed) {
      cards = children;
      start = 0;
      if (cards.length) order(0);
    }
    if (changed || resized) viewport.style.maxWidth = '';
    step = cards.length ? cards[0]!.getBoundingClientRect().width + (parseFloat(getComputedStyle(viewport).columnGap) || 0) : 0;
    maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    // Native swipes need an offscreen card on either side to recycle invisibly.
    // When nearly everything fits, reserve that space; when everything fits, show it all.
    if (viewport.clientWidth && cards.length > 2 && maximum > 1 && maximum < step * 2) {
      viewport.style.maxWidth = `${viewport.scrollWidth - Math.ceil(step * 2)}px`;
      maximum = viewport.scrollWidth - viewport.clientWidth;
    }
    const fits = cards.length < 2 || maximum <= 1;
    previous.disabled = next.disabled = fits;
    if (fits && start) order(0);
  }
  // Rotate only the visual order. DOM order, focus, listeners and checked state survive.
  // Compensating by the exact card pitch keeps every visible card in the same place.
  function recenter(): void {
    if (!step || maximum < step) return;
    const left = viewport.scrollLeft;
    const turns = Math.round((left - maximum / 2) / step);
    if (!turns) return;
    order(start + turns);
    viewport.scrollLeft = left - turns * step;
  }
  function move(distance: number): void {
    measure();
    if (next.disabled || !step) return;
    const destination = viewport.scrollLeft + distance;
    const turns = Math.round((destination - maximum / 2) / step);
    order(start + turns);
    viewport.scrollLeft = Math.max(0, Math.min(maximum, destination - turns * step));
  }
  function reveal(item: HTMLElement): void {
    if (!viewport.clientWidth) return;
    measure();
    const bounds = viewport.getBoundingClientRect();
    const card = item.getBoundingClientRect();
    const style = getComputedStyle(viewport);
    const left = bounds.left + parseFloat(style.paddingLeft);
    const right = bounds.right - parseFloat(style.paddingRight);
    if (card.left < left) viewport.scrollLeft += card.left - left;
    else if (card.right > right) viewport.scrollLeft += card.right - right;
    recenter();
  }
  function page(direction: number): void {
    move(direction * viewport.clientWidth * .8);
  }
  previous.addEventListener('click', () => page(-1));
  next.addEventListener('click', () => page(1));
  for (const button of [previous, next]) {
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation();
        page(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
  }
  viewport.addEventListener('wheel', event => {
    if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
    const horizontal = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!horizontal || event.ctrlKey) return;
    measure();
    if (next.disabled) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? step : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientWidth : 1;
    move(horizontal * unit);
  }, { passive: false });
  viewport.addEventListener('scroll', recenter, { passive: true });
  viewport.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    measure();
    const target = event.target as HTMLElement;
    const index = cards.findIndex(card => card.contains(target));
    const last = cards.length - 1;
    if (last < 0) return;
    const destination = event.key === 'Home' ? 0 : event.key === 'End' ? last
      : index < 0 ? (event.key === 'ArrowLeft' ? last : 0)
      : modulo(index + (event.key === 'ArrowLeft' ? -1 : 1), cards.length);
    const card = cards[destination]!;
    const control = card.querySelector<HTMLElement>(target instanceof HTMLInputElement ? 'input:not(:disabled)' : 'button');
    (control ?? card.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    reveal(card);
  });
  // Tab and programmatic focus also need to follow the logical, unchanged DOM order.
  // A pointer press must keep its target stationary until the click has completed.
  viewport.addEventListener('pointerdown', () => { pointerFocus = true; });
  window.addEventListener('pointerup', () => { pointerFocus = false; });
  window.addEventListener('pointercancel', () => { pointerFocus = false; });
  viewport.addEventListener('focusin', event => {
    if (pointerFocus) return;
    const item = cards.find(card => card.contains(event.target as Node));
    if (item) reveal(item);
  });
  function revealSelection(force = false): void {
    measure();
    const selected = viewport.querySelector<HTMLElement>('[aria-pressed=true]');
    // An unchanged selection must not move a pending click during a name edit's blur.
    if (selected?.parentElement && (force || selected !== lastSelected)) reveal(selected.parentElement);
    lastSelected = selected;
    recenter();
  }
  const resize = new ResizeObserver(() => {
    measure(true);
    revealSelection(true);
  });
  resize.observe(viewport);
  if (viewport.parentElement) resize.observe(viewport.parentElement);
  measure();
  return { revealSelection };
}
