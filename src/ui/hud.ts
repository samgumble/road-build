import type { EventBus } from '../core/events';
import type { Stage } from '../core/types';
import type { DrawTool, DrawToolMode } from '../input/drawTool';
import type { Loop } from '../core/loop';
import type { AmbientAudio } from '../audio/ambient';

const ADJECTIVES = [
  'amber', 'quiet', 'copper', 'dusty', 'stone', 'cedar', 'misty', 'golden', 'rusty', 'granite',
  'silver', 'broad', 'hollow', 'shallow', 'winding', 'high', 'low', 'far', 'old', 'lone',
];
const NOUNS = [
  'valley', 'ridge', 'hollow', 'crossing', 'bend', 'flats', 'harbor', 'creek', 'ford', 'grove',
  'summit', 'basin', 'plateau', 'pass', 'meadow', 'quarry', 'landing', 'junction', 'span', 'reach',
];

/** Generates a random two-word seed like `amber-valley`, for New World and boot-time fallback. */
export function randomSeed(rng: () => number = Math.random): string {
  const a = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(rng() * NOUNS.length)];
  return `${a}-${n}`;
}

const STAGE_TICKER: Record<Stage, string> = {
  surveyed: 'SURVEYING…',
  graded: 'GRADING EARTHWORKS…',
  gravel: 'LAYING GRAVEL…',
  paved: 'PAVING…',
  painted: 'PAINTING LINES…',
};
const CREW_IDLE = 'CREW IDLE';

/** Task 25: up to this many crew ticker lines are shown, one per active crew (indices 0..N-1,
 * matching `BuildQueue.MAX_CREWS`'s 0-based `crew` field on construction events). Kept as a local
 * constant rather than importing MAX_CREWS from the sim so the UI layer doesn't need a sim-layer
 * dependency purely for a display cap — if MAX_CREWS ever changes, bump this alongside it. */
const MAX_CREW_LINES = 3;

const PANEL_BG = '#1d1f21';
const BORDER = '#3a3d40';
const ACCENT = '#e8641b';
const TEXT = '#d8d5cd';
const TEXT_DIM = '#8a8d90';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>,
  style?: Partial<CSSStyleDeclaration>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  if (style) Object.assign(node.style, style);
  return node;
}

function labelStyle(): Partial<CSSStyleDeclaration> {
  return {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: '11px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: TEXT,
  };
}

function baseButtonStyle(): Partial<CSSStyleDeclaration> {
  return {
    ...labelStyle(),
    pointerEvents: 'auto',
    background: PANEL_BG,
    border: `1px solid ${BORDER}`,
    borderRadius: '3px',
    color: TEXT,
    padding: '8px 14px',
    cursor: 'pointer',
    boxShadow: 'none',
  };
}

interface HudDeps {
  bus: EventBus;
  drawTool: DrawTool;
  loop: Loop;
  seed: string;
  renderFrame: () => void;
  canvas: HTMLCanvasElement;
  audio: AmbientAudio;
  onNewWorld: (seed: string) => void;
}

const SAVE_KEY = 'groundwork-save';

/**
 * Bottom-center toolbar + top-left seed/status readout, styled as an engineer's site plan: charcoal
 * panels, 1px borders, uppercase mono labels, safety-orange active accents, no shadows/gradients.
 * All DOM lives inside the existing `#hud` container (`pointer-events: none`); interactive children
 * re-enable pointer events individually.
 */
export class Hud {
  private root: HTMLElement;
  private tickerContainer!: HTMLElement;
  private tickerLineEls: HTMLElement[] = [];
  private idleLineEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private hintShown = true;

  private drawBtn!: HTMLButtonElement;
  private demolishBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];

  private newWorldBtn!: HTMLButtonElement;
  private newWorldPanel!: HTMLElement;
  private newWorldInput!: HTMLInputElement;

  private muteBtn!: HTMLButtonElement;

  /** This crew's currently-reported stage, keyed by 0-based crew index (Task 25); a crew has no
   * entry while idle (no job assigned) or once its job reaches a terminal stage ('painted'/
   * 'removed'). Populated from `construction:stage` events — `crew: -1` (the sim's synthetic
   * "no live crew" sentinel for instant-remove/save-restore-sync emits, see queue.ts) is ignored,
   * since it never represents an actual ticker-worthy crew. */
  private stageByCrew = new Map<number, Stage>();

  constructor(private deps: HudDeps) {
    const hud = document.getElementById('hud');
    if (!hud) throw new Error('#hud container not found');
    this.root = hud;

    this.buildTopLeft();
    this.buildToolbar();
    this.wireEvents();
  }

  private buildTopLeft(): void {
    const panel = el('div', {}, {
      position: 'fixed', top: '16px', left: '16px',
      background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '10px 14px', pointerEvents: 'none',
    });

    const seedLine = el('div', { textContent: this.deps.seed }, {
      ...labelStyle(), color: TEXT, marginBottom: '4px',
    });
    panel.appendChild(seedLine);

    // Up to MAX_CREW_LINES ticker lines (Task 25), one per active crew — built once and hidden
    // individually rather than recreated per update, same "build once, toggle visibility" pattern
    // the render layer uses for its per-crew rigs.
    this.tickerContainer = el('div', {}, { display: 'flex', flexDirection: 'column', gap: '2px' });
    for (let i = 0; i < MAX_CREW_LINES; i++) {
      const line = el('div', { textContent: '' }, { ...labelStyle(), color: TEXT_DIM, display: 'none' });
      this.tickerLineEls.push(line);
      this.tickerContainer.appendChild(line);
    }
    this.tickerContainer.appendChild(
      // Fallback single "CREW IDLE" line, shown only when every crew line is hidden (no crew has
      // ever done anything yet, or all crews have gone idle) — collapses away as soon as any crew
      // line appears.
      (this.idleLineEl = el('div', { textContent: CREW_IDLE }, { ...labelStyle(), color: TEXT_DIM })),
    );
    panel.appendChild(this.tickerContainer);

    this.root.appendChild(panel);

    this.hintEl = el('div', { textContent: 'DRAG TO SURVEY A ROAD' }, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      ...labelStyle(), color: TEXT, fontSize: '13px', pointerEvents: 'none',
      transition: 'opacity 0.8s ease',
      opacity: '1',
    });
    this.root.appendChild(this.hintEl);
  }

  private buildToolbar(): void {
    const bar = el('div', {}, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'stretch', gap: '8px',
      background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '8px', pointerEvents: 'auto',
    });

    bar.appendChild(this.buildModeGroup());
    bar.appendChild(this.buildDivider());
    bar.appendChild(this.buildSpeedGroup());
    bar.appendChild(this.buildDivider());
    bar.appendChild(this.buildNewWorldGroup());
    bar.appendChild(this.buildPhotoButton());
    bar.appendChild(this.buildMuteButton());

    this.root.appendChild(bar);
  }

  private buildDivider(): HTMLElement {
    return el('div', {}, { width: '1px', alignSelf: 'stretch', background: BORDER });
  }

  private modeButton(label: string, mode: DrawToolMode): HTMLButtonElement {
    const btn = el('button', { type: 'button', textContent: label }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
      borderRadius: '3px',
    });
    btn.addEventListener('click', () => {
      this.deps.drawTool.mode = this.deps.drawTool.mode === mode ? 'none' : mode;
      this.refreshModeButtons();
    });
    return btn;
  }

  private buildModeGroup(): HTMLElement {
    const group = el('div', {}, { display: 'flex', gap: '4px' });
    this.drawBtn = this.modeButton('Draw', 'draw');
    this.demolishBtn = this.modeButton('Demolish', 'demolish');
    group.appendChild(this.drawBtn);
    group.appendChild(this.demolishBtn);
    this.refreshModeButtons();
    return group;
  }

  private refreshModeButtons(): void {
    const active = this.deps.drawTool.mode;
    for (const [btn, mode] of [[this.drawBtn, 'draw'], [this.demolishBtn, 'demolish']] as const) {
      const isActive = active === mode;
      btn.style.borderBottomColor = isActive ? ACCENT : 'transparent';
      btn.style.color = isActive ? ACCENT : TEXT;
    }
  }

  private buildSpeedGroup(): HTMLElement {
    const group = el('div', {}, { display: 'flex', gap: '4px' });
    const speeds: [string, number][] = [['1×', 1], ['4×', 4], ['16×', 16]];
    for (const [label, value] of speeds) {
      const btn = el('button', { type: 'button', textContent: label }, {
        ...baseButtonStyle(),
        borderBottom: '2px solid transparent',
      });
      btn.addEventListener('click', () => {
        this.deps.loop.timeScale = value;
        this.refreshSpeedButtons();
      });
      this.speedBtns.push(btn);
      group.appendChild(btn);
    }
    this.refreshSpeedButtons();
    return group;
  }

  private refreshSpeedButtons(): void {
    const speeds = [1, 4, 16];
    this.speedBtns.forEach((btn, i) => {
      const isActive = this.deps.loop.timeScale === speeds[i];
      btn.style.borderBottomColor = isActive ? ACCENT : 'transparent';
      btn.style.color = isActive ? ACCENT : TEXT;
    });
  }

  private buildNewWorldGroup(): HTMLElement {
    const wrap = el('div', {}, { position: 'relative', display: 'flex' });

    this.newWorldBtn = el('button', { type: 'button', textContent: 'New World' }, baseButtonStyle());
    this.newWorldPanel = el('div', {}, {
      display: 'none',
      position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
      background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '10px', gap: '8px', alignItems: 'center', whiteSpace: 'nowrap',
    });
    this.newWorldPanel.style.display = 'none';

    this.newWorldInput = el('input', { type: 'text', value: randomSeed() }, {
      ...labelStyle(),
      background: '#141516', border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '6px 8px', width: '140px', outline: 'none',
    });

    const buildBtn = el('button', { type: 'button', textContent: 'Build' }, {
      ...baseButtonStyle(), color: ACCENT, borderColor: ACCENT,
    });

    const row = el('div', {}, { display: 'flex', gap: '8px', alignItems: 'center' });
    row.appendChild(this.newWorldInput);
    row.appendChild(buildBtn);
    this.newWorldPanel.appendChild(row);
    wrap.appendChild(this.newWorldPanel);
    wrap.appendChild(this.newWorldBtn);

    this.newWorldBtn.addEventListener('click', () => {
      const open = this.newWorldPanel.style.display !== 'none';
      this.newWorldPanel.style.display = open ? 'none' : 'flex';
      if (!open) {
        this.newWorldInput.value = randomSeed();
        this.newWorldInput.focus();
        this.newWorldInput.select();
      }
    });

    buildBtn.addEventListener('click', () => {
      const seed = this.newWorldInput.value.trim() || randomSeed();
      this.deps.onNewWorld(seed);
    });
    this.newWorldInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') buildBtn.click();
    });

    return wrap;
  }

  private buildPhotoButton(): HTMLElement {
    const btn = el('button', { type: 'button', textContent: 'Photo' }, baseButtonStyle());
    btn.addEventListener('click', () => this.takePhoto());
    return btn;
  }

  private buildMuteButton(): HTMLElement {
    const btn = el('button', { type: 'button', textContent: 'Mute' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
    });
    btn.addEventListener('click', () => {
      this.deps.audio.muted = !this.deps.audio.muted;
      this.refreshMuteButton();
    });
    this.muteBtn = btn;
    this.refreshMuteButton();
    return btn;
  }

  private refreshMuteButton(): void {
    const muted = this.deps.audio.muted;
    this.muteBtn.textContent = muted ? 'Sound Off' : 'Mute';
    this.muteBtn.style.borderBottomColor = muted ? ACCENT : 'transparent';
    this.muteBtn.style.color = muted ? ACCENT : TEXT;
  }

  private takePhoto(): void {
    this.deps.renderFrame();
    this.deps.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `groundwork-${this.deps.seed}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  private wireEvents(): void {
    this.deps.bus.on('construction:stage', ({ crew, stage }) => {
      // crew: -1 is the sim's synthetic "no live crew" sentinel (instant pending-job removal,
      // save-restore's stage-sync emit — see queue.ts) — never a real crew ticker line.
      if (crew < 0) return;
      // A crew reaching a terminal stage frees up that ticker line — collapse it rather than
      // showing a stale "PAINTING LINES…" for a crew that's actually gone back to idle.
      if (stage === 'removed' || stage === 'painted') {
        this.stageByCrew.delete(crew);
      } else {
        this.stageByCrew.set(crew, stage);
      }
      this.updateTicker();
    });
    this.deps.bus.on('roads:edgeAdded', () => {
      this.dismissHint();
    });
  }

  /** Renders one line per crew with an entry in `stageByCrew` (indices in ascending crew order,
   * up to MAX_CREW_LINES), collapsing the single fallback "CREW IDLE" line as soon as any crew has
   * a line showing, and collapsing every per-crew line back down once all crews go idle. */
  private updateTicker(): void {
    const activeCrews = [...this.stageByCrew.entries()].sort(([a], [b]) => a - b);

    for (let i = 0; i < this.tickerLineEls.length; i++) {
      const line = this.tickerLineEls[i];
      const entry = activeCrews[i];
      if (entry) {
        const [crew, stage] = entry;
        line.textContent = `CREW ${crew + 1} ${STAGE_TICKER[stage]}`;
        line.style.display = '';
      } else {
        line.style.display = 'none';
      }
    }

    this.idleLineEl.style.display = activeCrews.length === 0 ? '' : 'none';
  }

  private dismissHint(): void {
    if (!this.hintShown) return;
    this.hintShown = false;
    this.hintEl.style.opacity = '0';
  }

  /** Called once on boot if a save was restored, so the hint doesn't show for a world that
   * already has roads. */
  suppressHintIfRoadsExist(hasRoads: boolean): void {
    if (hasRoads) this.dismissHint();
  }

  /** Refresh mode/speed button highlighting after external state changes (e.g. keyboard shortcuts). */
  syncControls(): void {
    this.refreshModeButtons();
    this.refreshSpeedButtons();
  }
}

export { SAVE_KEY };
