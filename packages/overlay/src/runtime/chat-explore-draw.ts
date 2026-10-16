/**
 * @az runtime chat-explore-draw
 * Purpose: draws an answer's explore into copies of the chat word's templates — its controls, wired, and its views, recomputed in the page as the visitor changes a control.
 * Spec: docs/chat-block-spec.md §21.3.4, §21.3.5, §21.3.6
 * Exports: drawExplore, ExploreDraw, EXPLORE_ANNOUNCE_MS, EXPLORE_DRAW_COPY
 * Edit guide: values through properties (.value, .min, .checked), words through textContent, ids made here; no style, no markup,
 *   no network — a send form only hands its shown words to `ask`, on a submit.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat-explore.test.ts
 */

/**
 * The event was checked by chat-explore.ts validExplore; this clones the
 * explore part the chat word made (words/chat/figures.ts): a range input
 * with its label and an <output>, a date input with its bounds, a toggle as
 * a group of real radios (arrow keys move between them), a form of labelled
 * fields with one button. On `input` the views are recomputed — at most once
 * a frame — by chat-explore.ts computeView and drawn again with chat-draw.ts,
 * and the first view's new summary is said at most once in 1.5 s. Focus
 * alone changes nothing. A form that applies sets its fields' variables when
 * it is submitted; one that sends shows the exact question on its button and
 * hands those words to `ask` — the same path as typing them — and nothing
 * else here reaches the network.
 */

import { chartSummary } from './chat-chart.ts';
import { clonePart, drawChart, drop, fill, formatter, frame, provenance, slot, tableOf, type RichDraw } from './chat-draw.ts';
import {
  EXPLORE_TEXT, computeView, controlValue, initialVars, sendText, validExplore, viewChart, viewTitle,
  type ExploreControl, type ExploreData, type ExploreView,
} from './chat-explore.ts';

/** §9: the first view's summary is said at most this often while a control moves. */
export const EXPLORE_ANNOUNCE_MS = 1500;

/** Fixed copy the drawing adds. */
export const EXPLORE_DRAW_COPY = {
  said: (title: string, controls: number, views: number, ai: boolean) =>
    `Explore: ${title}, ${controls === 1 ? '1 control' : `${controls} controls`} and ${views === 1 ? '1 view' : `${views} views`}${ai ? ', AI-generated figures' : ''}.`,
} as const;

export interface ExploreDraw extends RichDraw {
  /** Asks a send form's question as the visitor's own message (chat.ts ask); absent where nothing may be asked — the shared page. */
  readonly ask?: (q: string) => void;
  /** Tells the status region, at once (chat.ts announce); this module keeps it to one summary in EXPLORE_ANNOUNCE_MS. */
  readonly announce?: (text: string) => void;
  /** Ends every listener, frame and timer this explore holds. */
  readonly signal: AbortSignal;
}

type Input = HTMLInputElement | HTMLSelectElement;

/**
 * The explore in an event, drawn and live — with what the status region
 * says of it — or null when it does not check out or the shell has no
 * template for it.
 */
export function drawExplore(d: ExploreDraw, data: unknown): { el: HTMLElement; said: string } | null {
  const x = validExplore(data);
  const root = x && clonePart(d.components, 'explore');
  const controlsBox = root && slot(root, 'controls');
  const viewsBox = root && slot(root, 'views');
  if (!x || !root || !controlsBox || !viewsBox) return null;
  const take = (box: Element, name: string): HTMLElement | null => {
    const el = slot(box, name);
    el?.remove();
    el?.removeAttribute('data-az-chat-slot');
    return el;
  };
  const t = {
    slider: take(controlsBox, 'slider'), date: take(controlsBox, 'date'), toggle: take(controlsBox, 'toggle'), form: take(controlsBox, 'form'),
    number: null as HTMLElement | null, choice: null as HTMLElement | null,
    view: take(viewsBox, 'view'), wide: take(viewsBox, 'view-wide'),
  };
  if (t.form) {
    const fields = slot(t.form, 'fields');
    if (fields) { t.number = take(fields, 'field-number'); t.choice = take(fields, 'field-choice'); }
  }
  if (!t.view || !t.wide) return null;
  const doc = d.doc;
  const win = doc.defaultView;
  const id = `az-chat-x-${d.suffix}`;
  fill(root, 'title', x.title);
  slot(root, 'title')?.setAttribute('id', id);
  root.setAttribute('aria-labelledby', id);

  /** The variables the views read, at their written values (positions are never kept, O9). */
  const vars = initialVars(x);
  const plain = new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: 20 });
  const show = (n: number) => plain.format(n);
  const on = (el: EventTarget, type: string, fn: (e: Event) => void) => el.addEventListener(type, fn, { signal: d.signal });

  /* ---- the views, recomputed at most once a frame ---- */
  const stops: ((() => void) | null)[] = x.views.map(() => null);
  const holders = x.views.map((v) => {
    const h = (v.kind === 'stat' ? t.view! : t.wide!).cloneNode(false) as HTMLElement;
    viewsBox.append(h);
    return h;
  });
  const drawView = (i: number): string => {
    const v = x.views[i];
    const sub: RichDraw = {
      ...d, suffix: `${d.suffix}-v${i}`,
      // A redrawn chart's width is watched again; the one it replaced is let go.
      ...(d.observe ? { observe: (el: Element, redraw: () => void) => { stops[i]?.(); stops[i] = d.observe!(el, redraw); return stops[i]!; } } : {}),
    };
    const drawn = viewOf(sub, x, v, computeView(x, v, vars));
    if (!drawn) return '';
    holders[i].replaceChildren(drawn.el);
    return drawn.said;
  };
  let lastSaid = -Infinity;
  let sayTimer: ReturnType<typeof setTimeout> | null = null;
  let toSay = '';
  const say = (text: string) => {
    if (!d.announce || text === '') return;
    toSay = text;
    if (sayTimer !== null) return;
    const wait = Math.max(0, lastSaid + EXPLORE_ANNOUNCE_MS - Date.now());
    sayTimer = setTimeout(() => {
      sayTimer = null;
      // An explore no longer on the page (a new chat replaced it) has nothing to say.
      if (d.signal.aborted || !root.isConnected) return;
      lastSaid = Date.now();
      d.announce!(toSay);
    }, wait);
  };
  let frameDue = false;
  const nextFrame = (fn: () => void) => (win?.requestAnimationFrame ? win.requestAnimationFrame(fn) : setTimeout(fn, 0));
  const redraw = () => {
    if (frameDue) return;
    frameDue = true;
    nextFrame(() => {
      frameDue = false;
      if (d.signal.aborted) return;
      const said = x.views.map((_, i) => drawView(i));
      say(said[0]);
    });
  };
  d.signal.addEventListener('abort', () => {
    if (sayTimer !== null) clearTimeout(sayTimer);
    for (const s of stops) s?.();
  }, { once: true });

  /* ---- the controls ---- */
  let n = 0;
  const nextId = () => `${id}-c${++n}`;
  /** A labelled input: its label tied to it by id, the input's own id. */
  const labelled = (box: Element, label: string): Input | null => {
    const input = slot(box, 'input') as Input | null;
    const lab = slot(box, 'label');
    if (!input || !lab) return null;
    const own = nextId();
    input.id = own;
    lab.setAttribute('for', own);
    lab.textContent = label;
    for (const el of [input, lab]) el.removeAttribute('data-az-chat-slot');
    return input;
  };
  const byName = new Map<string, Exclude<ExploreControl, { kind: 'form' }>>();
  for (const c of x.controls) if (c.kind !== 'form') byName.set(c.name, c);
  let controls = 0;

  for (const c of x.controls) {
    if (c.kind === 'slider' && t.slider) {
      const box = t.slider.cloneNode(true) as HTMLElement;
      const input = labelled(box, c.label) as HTMLInputElement | null;
      const output = slot(box, 'output');
      if (!input || !output) continue;
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.value = String(c.value);
      output.setAttribute('for', input.id);
      output.removeAttribute('data-az-chat-slot');
      output.textContent = show(c.value);
      const moved = () => {
        const v = controlValue(c, input.value);
        if (v === null || v === vars.get(c.name)) return;
        vars.set(c.name, v);
        output.textContent = show(v as number);
        redraw();
      };
      on(input, 'input', moved);
      on(input, 'change', moved);
      controlsBox.append(box);
      controls++;
    } else if (c.kind === 'date' && t.date) {
      const box = t.date.cloneNode(true) as HTMLElement;
      const input = labelled(box, c.label) as HTMLInputElement | null;
      if (!input) continue;
      input.min = c.min;
      input.max = c.max;
      input.value = c.value;
      on(input, 'input', () => {
        const v = controlValue(c, input.value);
        if (v === null || v === vars.get(c.name)) return;
        vars.set(c.name, v);
        redraw();
      });
      // A day out of bounds, or none, is not kept: the input shows the day the views use.
      on(input, 'change', () => { if (controlValue(c, input.value) === null) input.value = String(vars.get(c.name)); });
      controlsBox.append(box);
      controls++;
    } else if (c.kind === 'toggle' && t.toggle) {
      const box = t.toggle.cloneNode(true) as HTMLElement;
      const options = slot(box, 'options');
      const proto = options && slot(options, 'option');
      if (!options || !proto) continue;
      fill(box, 'legend', c.label);
      drop(box, 'option');
      const group = nextId();
      for (const o of c.options) {
        const item = proto.cloneNode(true) as HTMLElement;
        item.removeAttribute('data-az-chat-slot');
        const radio = slot(item, 'radio') as HTMLInputElement | null;
        if (!radio) continue;
        radio.removeAttribute('data-az-chat-slot');
        radio.name = group;
        radio.value = o;
        radio.checked = o === c.value;
        fill(item, 'text', o);
        on(radio, 'change', () => {
          if (!radio.checked || controlValue(c, radio.value) === null) return;
          vars.set(c.name, radio.value);
          redraw();
        });
        options.append(item);
      }
      controlsBox.append(box);
      controls++;
    } else if (c.kind === 'form' && t.form) {
      // A form that asks has nothing to do where nothing may be asked (the shared page): it is not drawn.
      if (c.action === 'send' && !d.ask) continue;
      const form = t.form.cloneNode(true) as HTMLFormElement;
      const fieldsBox = slot(form, 'fields');
      const button = slot(form, 'submit') as HTMLButtonElement | null;
      if (!fieldsBox || !button) continue;
      fill(form, 'legend', c.label);
      fieldsBox.removeAttribute('data-az-chat-slot');
      button.removeAttribute('data-az-chat-slot');
      /** The fields' values as last typed or picked: a form applies or asks with these, not the views' variables. */
      const typed = new Map<string, number | string>();
      const inputs: [Exclude<ExploreControl, { kind: 'form' }>, Input][] = [];
      for (const name of c.fields) {
        const f = byName.get(name);
        if (!f || f.kind !== 'field') continue;
        const proto = f.type === 'number' ? t.number : t.choice;
        if (!proto) continue;
        const box = proto.cloneNode(true) as HTMLElement;
        const input = labelled(box, f.label);
        if (!input) continue;
        if (f.type === 'number') {
          const field = input as HTMLInputElement;
          field.min = String(f.min);
          field.max = String(f.max);
          field.value = String(f.value);
        } else {
          const opt = slot(input, 'choice');
          if (!opt) continue;
          opt.remove();
          for (const o of f.options) {
            const item = opt.cloneNode(false) as HTMLOptionElement;
            item.removeAttribute('data-az-chat-slot');
            item.value = o;
            item.textContent = o;
            input.append(item);
          }
          input.value = f.value;
        }
        typed.set(name, f.value);
        inputs.push([f, input]);
        fieldsBox.append(box);
      }
      if (inputs.length !== c.fields.length) continue;
      const question = () => (c.action === 'send' ? sendText(c, typed, show) : null);
      const label = () => {
        if (c.action === 'apply') { button.textContent = EXPLORE_TEXT.apply; return; }
        const q = question();
        // The exact words that will be asked, on the button that asks them.
        button.textContent = q === null ? EXPLORE_TEXT.ask('') : EXPLORE_TEXT.ask(q);
        button.disabled = q === null;
      };
      for (const [f, input] of inputs) {
        on(input, 'input', () => {
          const v = controlValue(f, input.value);
          if (v === null) return;
          typed.set(f.name, v);
          label();
        });
      }
      on(form, 'submit', (e) => {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }
        for (const [f, input] of inputs) {
          const v = controlValue(f, input.value);
          if (v === null) { form.reportValidity(); return; }
          typed.set(f.name, v);
        }
        if (c.action === 'apply') {
          for (const [name, v] of typed) vars.set(name, v);
          redraw();
          return;
        }
        label();
        const q = question();
        if (q !== null) d.ask?.(q);
      });
      label();
      controlsBox.append(form);
      controls += inputs.length;
    }
  }
  if (controlsBox.childElementCount === 0) controlsBox.remove();
  else controlsBox.removeAttribute('data-az-chat-slot');
  viewsBox.removeAttribute('data-az-chat-slot');
  x.views.forEach((_, i) => drawView(i));
  return { el: root, said: EXPLORE_DRAW_COPY.said(x.title, controls, x.views.length, x.src === 'model') };
}

/** A view in its holder's terms: a figure (table, chart, or a note in place of either) or a stat card — and its summary. */
function viewOf(d: RichDraw, x: ExploreData, v: ExploreView, r: ReturnType<typeof computeView>): { el: HTMLElement; said: string } | null {
  const title = viewTitle(x, v);
  const note = r.kind === 'empty' ? EXPLORE_TEXT.empty : r.kind === 'none' ? EXPLORE_TEXT.none : r.kind === 'overflow' ? EXPLORE_TEXT.overflow : null;
  if (v.kind === 'stat') return statOf(d, x, v.label, v.unit, r.kind === 'value' ? r.value : null, note ?? EXPLORE_TEXT.none);
  if (note !== null) return noteOf(d, x, title, note);
  if (v.kind === 'table' && r.kind === 'rows') {
    const f = frame(d, title, x.src, x.asOf, x.source);
    const body = f && slot(f, 'body');
    const head = x.columns.map((c) => ({ label: c.label, type: c.type === 'number' ? 'number' as const : 'text' as const, unit: c.unit }));
    const table = tableOf(d, d.suffix, title, head, r.rows, false);
    if (!f || !body || !table) return null;
    body.replaceChildren(table);
    const said = r.total > r.rows.length ? EXPLORE_TEXT.shownOf(r.rows.length, r.total) : EXPLORE_TEXT.rows(r.total);
    fill(f, 'summary', said);
    for (const name of ['legend', 'details']) drop(f, name);
    return { el: f, said: `${title}: ${said}` };
  }
  if (v.kind === 'chart' && r.kind === 'groups') {
    const c = viewChart(x, v, r.groups);
    if (!c) return noteOf(d, x, title, EXPLORE_TEXT.undrawable);
    const el = drawChart(d, c);
    return el ? { el, said: chartSummary(c, formatter(d.doc, c.unit)) } : null;
  }
  return null;
}

/** A figure's frame holding only a fixed note — no rows match, no figure, too large, too few to draw. */
function noteOf(d: RichDraw, x: ExploreData, title: string, note: string): { el: HTMLElement; said: string } | null {
  const f = frame(d, title, x.src, x.asOf, x.source);
  if (!f) return null;
  for (const name of ['body', 'legend', 'details']) drop(f, name);
  fill(f, 'summary', note);
  return { el: f, said: `${title}: ${note}` };
}

/** A stat card: its label, its figure in its unit (or the note in its place), and where the figure came from. */
function statOf(d: RichDraw, x: ExploreData, label: string, unit: string | null, value: number | null, note: string): { el: HTMLElement; said: string } | null {
  const list = clonePart(d.components, 'stats');
  const card = list && slot(list, 'stat');
  if (!list || !card) return null;
  card.removeAttribute('data-az-chat-slot');
  list.replaceChildren(card);
  fill(card, 'label', label);
  const shown = value === null ? null : formatter(d.doc, unit)(value);
  if (shown === null) {
    drop(card, 'value');
    fill(card, 'glyph', '');
    fill(card, 'words', note);
  } else {
    fill(card, 'value', shown);
    drop(card, 'delta');
  }
  fill(card, 'ai', provenance(d.doc, x.src, x.asOf, x.source));
  return { el: list, said: `${label}: ${shown ?? note}` };
}

