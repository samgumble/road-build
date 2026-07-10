import type { EventBus } from '../core/events';
import { STAGES, type Stage } from '../core/types';
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
const DEMOLISH_TICKER: Partial<Record<Stage, string>> = {
  painted: 'REMOVING LINES…',
  paved: 'REMOVING ASPHALT…',
  gravel: 'HAULING GRAVEL…',
  graded: 'RESTORING GROUND…',
};
const CREW_IDLE = 'CREW IDLE';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function constructionJobProgress(
  stageProgress: Partial<Record<Stage, number>>,
  demolish: boolean,
  activeStage: Stage,
  activeProgress: number,
): number {
  if (!demolish) {
    const total = STAGES.reduce((sum, stage) => sum + clamp01(stageProgress[stage] ?? 0), 0);
    return total / STAGES.length;
  }

  // Demolition walks painted -> paved -> gravel -> graded, with t decreasing within each pass.
  // Convert that "remaining structure" representation into a conventional 0 -> 1 completion bar.
  const stageIndex = STAGES.indexOf(activeStage);
  const remainingCompletedStages = Math.max(0, stageIndex - 1);
  const remaining = remainingCompletedStages + clamp01(activeProgress);
  return clamp01(1 - remaining / (STAGES.length - 1));
}

export function formatCrewTicker(crew: number, stage: Stage, demolish: boolean, onBreak: boolean): string {
  if (onBreak) return `CREW ${crew + 1} ON BREAK`;
  const action = demolish ? (DEMOLISH_TICKER[stage] ?? 'CLEARING SITE…') : STAGE_TICKER[stage];
  return `CREW ${crew + 1} ${action}`;
}

export function formatConstructionNotice(stage: Stage | 'removed', crew: number): string | null {
  if (crew < 0) return null;
  if (stage === 'painted') return `ROAD OPEN · CREW ${crew + 1} COMPLETE`;
  if (stage === 'removed') return `ROAD REMOVED · CREW ${crew + 1} CLEAR`;
  return null;
}

export interface GrowthControlCopy {
  full: string;
  compact: string;
  notice: string;
}

export function formatGrowthControl(paused: boolean): GrowthControlCopy {
  return paused
    ? { full: 'Growth Paused', compact: 'GROW OFF', notice: 'ENVIRONMENT GROWTH PAUSED' }
    : { full: 'Growth', compact: 'GROW', notice: 'ENVIRONMENT GROWTH RESUMED' };
}

/** Task 25: up to this many crew ticker lines are shown, one per active crew (indices 0..N-1,
 * matching `BuildQueue.MAX_CREWS`'s 0-based `crew` field on construction events). Kept as a local
 * constant rather than importing MAX_CREWS from the sim so the UI layer doesn't need a sim-layer
 * dependency purely for a display cap — if MAX_CREWS ever changes, bump this alongside it. */
const MAX_CREW_LINES = 3;

// Shared visual language with startScreen.ts's generated dawn key art: deep slate field-office
// glass, warm safety orange, and paper-white typography. Kept local so the HUD remains a small,
// dependency-free DOM surface rather than introducing a styling framework for six color tokens.
const PANEL_BG = 'rgba(17, 23, 25, 0.92)';
const BORDER = 'rgba(216, 213, 205, 0.22)';
const ACCENT = '#f06b24';
const TEXT = '#ece9df';
const TEXT_DIM = '#a9aaa5';

/**
 * Task 29 (mobile): responsive HUD rules for viewports <=480px — compacted button labels (each
 * button holds a `.gw-label-full` and `.gw-label-compact` span, see `setResponsiveLabel`, and the
 * media query below swaps which is visible), touch targets grown to >=44px (Apple/Google's
 * minimum recommended hit target), toolbar wraps to two rows instead of overflowing, the
 * seed/ticker panel's font shrinks, and the toolbar gets safe-area bottom padding for iOS's home
 * indicator. A real `<style>` + media query (rather than a JS matchMedia toggle) so it responds
 * live to viewport/orientation changes and DevTools responsive-mode resizes without any extra
 * plumbing — same mechanism a plain CSS site would use, just injected since this app has no
 * external stylesheet.
 */
const RESPONSIVE_CSS = `
  #gw-top-left,
  #gw-toolbar,
  #gw-guide-panel,
  #gw-new-world-panel {
    background: linear-gradient(145deg, rgba(18,24,26,.96), rgba(18,24,26,.84)) !important;
    border-color: rgba(216,213,205,.25) !important;
    box-shadow: 0 16px 50px rgba(0,0,0,.28), inset 0 1px rgba(255,255,255,.035) !important;
    backdrop-filter: blur(12px) saturate(1.08);
  }
  #gw-top-left,
  #gw-toolbar {
    border-top: 2px solid ${ACCENT} !important;
  }
  #gw-top-left .gw-office-label {
    margin-bottom: 7px;
    color: ${ACCENT};
    font-size: 8px;
    letter-spacing: .18em;
  }
  #gw-top-left .gw-seed {
    font-size: 12px;
    letter-spacing: .12em;
  }
  #gw-toolbar {
    box-shadow: 0 20px 60px rgba(0,0,0,.34), inset 0 1px rgba(255,255,255,.04) !important;
  }
  #gw-toolbar::before {
    content: 'SITE COMMAND';
    position: absolute;
    left: 12px;
    top: -17px;
    color: rgba(236,233,223,.62);
    font: 700 8px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: .16em;
  }
  #gw-toolbar button,
  #gw-guide-panel button,
  #gw-new-world-panel button {
    background: rgba(255,255,255,.035) !important;
    border-color: rgba(216,213,205,.20);
    transition: transform .16s ease, color .16s ease, border-color .16s ease, background .16s ease;
  }
  #gw-toolbar button:hover,
  #gw-guide-panel button:hover,
  #gw-new-world-panel button:hover {
    transform: translateY(-1px);
    border-color: rgba(216,213,205,.5) !important;
    background: rgba(255,255,255,.07) !important;
  }
  #gw-toolbar button:focus-visible,
  #gw-guide-panel button:focus-visible,
  #gw-new-world-panel button:focus-visible,
  #gw-new-world-panel input:focus-visible {
    outline: 2px solid #ffd29d;
    outline-offset: 2px;
  }
  #gw-hint {
    padding: 9px 13px;
    background: rgba(17,23,25,.64);
    border: 1px solid rgba(216,213,205,.2);
    border-left: 3px solid ${ACCENT};
    box-shadow: 0 12px 35px rgba(0,0,0,.2);
    backdrop-filter: blur(7px);
  }
  #gw-notices > div {
    box-shadow: 0 14px 38px rgba(0,0,0,.27);
    backdrop-filter: blur(9px);
  }
  #gw-toolbar {
    padding-bottom: calc(8px + env(safe-area-inset-bottom));
  }
  #gw-toolbar .gw-label-compact {
    display: none;
  }
  @media (max-width: 480px) {
    #gw-toolbar {
      flex-wrap: wrap;
      max-width: calc(100vw - 16px);
      justify-content: center;
      padding-bottom: calc(8px + env(safe-area-inset-bottom));
    }
    #gw-toolbar::before { display: none; }
    #gw-toolbar button {
      min-width: 44px;
      min-height: 44px;
      padding: 8px 10px !important;
      font-size: 10px !important;
    }
    #gw-toolbar .gw-label-full {
      display: none;
    }
    #gw-toolbar .gw-label-compact {
      display: inline;
    }
    #gw-top-left {
      padding: 6px 8px !important;
    }
    #gw-top-left .gw-seed,
    #gw-top-left .gw-ticker-line {
      font-size: 9px !important;
    }
    #gw-guide-panel {
      width: min(330px, calc(100vw - 32px)) !important;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
    }
    #gw-notices {
      top: 84px !important;
      left: 8px;
      right: 8px !important;
      align-items: center !important;
    }
    #gw-notices > div {
      max-width: calc(100vw - 32px);
      text-align: center;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    #gw-top-left .gw-ticker-row > div:last-child > div,
    #gw-notices > div {
      transition: none !important;
    }
    #gw-guide-backdrop {
      backdrop-filter: none !important;
    }
  }
`;

function injectResponsiveStyles(): void {
  if (document.getElementById('gw-responsive-style')) return;
  const style = document.createElement('style');
  style.id = 'gw-responsive-style';
  style.textContent = RESPONSIVE_CSS;
  document.head.appendChild(style);
}

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

/**
 * Sets a button's visible label to two swappable spans: the full desktop label and a shorter
 * compact one, toggled purely by the `RESPONSIVE_CSS` media query above (`.gw-label-full` /
 * `.gw-label-compact`) — no JS breakpoint logic needed, and it responds live to resizes. If
 * `compact` is omitted, the full label is reused for both (nothing to shorten, e.g. "1×").
 */
function setResponsiveLabel(btn: HTMLButtonElement, full: string, compact?: string): void {
  btn.textContent = '';
  const fullEl = el('span', { textContent: full, className: 'gw-label-full' });
  const compactEl = el('span', { textContent: compact ?? full, className: 'gw-label-compact' });
  btn.appendChild(fullEl);
  btn.appendChild(compactEl);
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

export interface SiteOverview {
  roads: number;
  scheduledJobs: number;
  activeCrews: number;
  cars: number;
  homes: number;
  buildings: number;
  paused: boolean;
  growthPaused: boolean;
}

/** Compact, stable wording for the site guide's event-driven snapshot. Kept pure so the UI's
 * player-facing language is regression-tested without requiring a DOM/WebGL environment. */
export function formatSiteOverview(site: SiteOverview): string[] {
  return [
    `NETWORK  ${site.roads} ROAD${site.roads === 1 ? '' : 'S'}`,
    `WORK      ${site.activeCrews} CREW${site.activeCrews === 1 ? '' : 'S'} · ${site.scheduledJobs} JOB${site.scheduledJobs === 1 ? '' : 'S'}`,
    `TOWN      ${site.homes} HOME${site.homes === 1 ? '' : 'S'} · ${site.buildings} BUILDING${site.buildings === 1 ? '' : 'S'}`,
    `TRAFFIC   ${site.cars} CAR${site.cars === 1 ? '' : 'S'}`,
    `SIM       ${site.paused ? 'PAUSED' : site.growthPaused ? 'RUNNING · GROWTH PAUSED' : 'RUNNING'}`,
  ];
}

interface HudDeps {
  bus: EventBus;
  drawTool: DrawTool;
  loop: Loop;
  seed: string;
  renderFrame: () => void;
  canvas: HTMLCanvasElement;
  audio: AmbientAudio;
  getSiteOverview: () => SiteOverview;
  getEdgeLength: (edgeId: number) => number;
  getGrowthPaused: () => boolean;
  setGrowthPaused: (paused: boolean) => void;
  onNewWorld: (seed: string) => void;
}

interface CrewHudState {
  edgeId: number;
  activeStage: Stage;
  activeProgress: number;
  stageProgress: Partial<Record<Stage, number>>;
  demolish: boolean;
  onBreak: boolean;
}

const SAVE_KEY = 'groundwork-save';
/** Task 39: MUSIC HUD toggle's persisted on/off state — separate from MUTE (which isn't persisted
 * at all; it always starts unmuted). Defaults to ON (music enabled) whenever the key is missing or
 * unreadable (private browsing, storage disabled, corrupt value), matching this game's
 * "music-on-by-default" design. */
const MUSIC_KEY = 'groundwork-music';
const GROWTH_PAUSED_KEY = 'groundwork-growth-paused';

function readPersistedMusicOn(): boolean {
  try {
    const raw = window.localStorage.getItem(MUSIC_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function persistMusicOn(on: boolean): void {
  try {
    window.localStorage.setItem(MUSIC_KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable — the toggle still works for this session, just doesn't persist.
  }
}

function readPersistedGrowthPaused(): boolean {
  try {
    return window.localStorage.getItem(GROWTH_PAUSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistGrowthPaused(paused: boolean): void {
  try {
    window.localStorage.setItem(GROWTH_PAUSED_KEY, paused ? '1' : '0');
  } catch {
    // Storage unavailable — the control still owns the current session correctly.
  }
}

/**
 * Bottom-center toolbar + top-left seed/status readout, styled as an engineer's site plan: charcoal
 * panels, fine borders, uppercase mono labels, safety-orange active accents, and restrained
 * depth borrowed from the generated title art's slate/amber dawn palette.
 * All DOM lives inside the existing `#hud` container (`pointer-events: none`); interactive children
 * re-enable pointer events individually.
 */
export class Hud {
  private root: HTMLElement;
  private tickerContainer!: HTMLElement;
  private tickerRowEls: HTMLElement[] = [];
  private tickerLineEls: HTMLElement[] = [];
  private tickerProgressEls: HTMLElement[] = [];
  private idleLineEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private hintShown = true;

  private drawBtn!: HTMLButtonElement;
  private demolishBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn!: HTMLButtonElement;
  private growthBtn!: HTMLButtonElement;
  private guideBtn!: HTMLButtonElement;
  private guideBackdrop!: HTMLElement;
  private guidePanel!: HTMLElement;
  private guideCloseBtn!: HTMLButtonElement;
  private guideOverviewLines: HTMLElement[] = [];
  private guideOpen = false;

  private newWorldBtn!: HTMLButtonElement;
  private newWorldPanel!: HTMLElement;
  private newWorldInput!: HTMLInputElement;

  private muteBtn!: HTMLButtonElement;
  private musicBtn!: HTMLButtonElement;

  /** This crew's currently-reported stage, keyed by 0-based crew index (Task 25); a crew has no
   * entry while idle (no job assigned) or once its job reaches a terminal stage ('painted'/
   * 'removed'). Populated from `construction:stage` events — `crew: -1` (the sim's synthetic
   * "no live crew" sentinel for instant-remove/save-restore-sync emits, see queue.ts) is ignored,
   * since it never represents an actual ticker-worthy crew. */
  private crewStateByCrew = new Map<number, CrewHudState>();
  private tickerFramePending = false;
  private noticeContainer!: HTMLElement;

  constructor(private deps: HudDeps) {
    const hud = document.getElementById('hud');
    if (!hud) throw new Error('#hud container not found');
    this.root = hud;

    // Task 39: restore the persisted MUSIC toggle state before any button is built, so
    // buildMusicButton's initial `refreshMusicButton()` reflects it immediately rather than
    // flashing the default-on state for a frame.
    this.deps.audio.musicOn = readPersistedMusicOn();
    this.deps.setGrowthPaused(readPersistedGrowthPaused());

    injectResponsiveStyles();
    this.buildTopLeft();
    this.buildToolbar();
    this.buildGuideOverlay();
    this.wireEvents();
  }

  private buildTopLeft(): void {
    const panel = el('div', { id: 'gw-top-left' }, {
      position: 'fixed', top: '16px', left: '16px',
      background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '10px 14px', pointerEvents: 'none',
    });

    panel.appendChild(el('div', {
      textContent: 'GROUNDWORK / FIELD OFFICE', className: 'gw-office-label',
    }, labelStyle()));

    const seedLine = el('div', { textContent: this.deps.seed, className: 'gw-seed' }, {
      ...labelStyle(), color: TEXT, marginBottom: '4px',
    });
    panel.appendChild(seedLine);

    // Up to MAX_CREW_LINES ticker lines (Task 25), one per active crew — built once and hidden
    // individually rather than recreated per update, same "build once, toggle visibility" pattern
    // the render layer uses for its per-crew rigs.
    this.tickerContainer = el('div', {}, { display: 'flex', flexDirection: 'column', gap: '2px' });
    for (let i = 0; i < MAX_CREW_LINES; i++) {
      const row = el('div', { className: 'gw-ticker-row' }, { display: 'none', minWidth: '220px' });
      const line = el('div', { textContent: '', className: 'gw-ticker-line' }, { ...labelStyle(), color: TEXT_DIM });
      const track = el('div', {}, { height: '2px', marginTop: '3px', overflow: 'hidden', background: BORDER });
      const fill = el('div', {}, {
        width: '100%', height: '100%', background: ACCENT, transform: 'scaleX(0)',
        transformOrigin: 'left center', transition: 'transform 0.12s linear',
      });
      track.appendChild(fill);
      row.appendChild(line);
      row.appendChild(track);
      this.tickerRowEls.push(row);
      this.tickerLineEls.push(line);
      this.tickerProgressEls.push(fill);
      this.tickerContainer.appendChild(row);
    }
    this.tickerContainer.appendChild(
      // Fallback single "CREW IDLE" line, shown only when every crew line is hidden (no crew has
      // ever done anything yet, or all crews have gone idle) — collapses away as soon as any crew
      // line appears.
      (this.idleLineEl = el('div', { textContent: CREW_IDLE, className: 'gw-ticker-line' }, { ...labelStyle(), color: TEXT_DIM })),
    );
    panel.appendChild(this.tickerContainer);

    this.root.appendChild(panel);

    this.hintEl = el('div', { id: 'gw-hint', textContent: 'DRAG TO SURVEY A ROAD' }, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      ...labelStyle(), color: TEXT, fontSize: '13px', pointerEvents: 'none',
      transition: 'opacity 0.8s ease',
      opacity: '1',
    });
    this.root.appendChild(this.hintEl);

    this.noticeContainer = el('div', { id: 'gw-notices', ariaLive: 'polite' }, {
      position: 'fixed', top: '16px', right: '16px', display: 'flex', flexDirection: 'column',
      alignItems: 'flex-end', gap: '6px', pointerEvents: 'none',
    });
    this.root.appendChild(this.noticeContainer);
  }

  private buildToolbar(): void {
    const bar = el('div', { id: 'gw-toolbar' }, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'stretch', gap: '8px',
      background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '8px', pointerEvents: 'auto',
    });

    bar.appendChild(this.buildModeGroup());
    bar.appendChild(this.buildDivider());
    bar.appendChild(this.buildSpeedGroup());
    bar.appendChild(this.buildPauseButton());
    bar.appendChild(this.buildGrowthButton());
    bar.appendChild(this.buildDivider());
    bar.appendChild(this.buildNewWorldGroup());
    bar.appendChild(this.buildGuideButton());
    bar.appendChild(this.buildPhotoButton());
    bar.appendChild(this.buildMusicButton());
    bar.appendChild(this.buildMuteButton());

    this.root.appendChild(bar);
  }

  private buildDivider(): HTMLElement {
    return el('div', {}, { width: '1px', alignSelf: 'stretch', background: BORDER });
  }

  private modeButton(label: string, compact: string, mode: DrawToolMode): HTMLButtonElement {
    const btn = el('button', { type: 'button' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
      borderRadius: '3px',
    });
    setResponsiveLabel(btn, label, compact);
    btn.addEventListener('click', () => {
      this.deps.drawTool.mode = this.deps.drawTool.mode === mode ? 'none' : mode;
      this.refreshModeButtons();
    });
    return btn;
  }

  private buildModeGroup(): HTMLElement {
    const group = el('div', {}, { display: 'flex', gap: '4px' });
    this.drawBtn = this.modeButton('Draw', 'DRAW', 'draw');
    this.demolishBtn = this.modeButton('Demolish', 'DEMO', 'demolish');
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
      const btn = el('button', { type: 'button' }, {
        ...baseButtonStyle(),
        borderBottom: '2px solid transparent',
      });
      setResponsiveLabel(btn, label); // already compact — reuse as-is at every width
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

  private buildPauseButton(): HTMLButtonElement {
    const btn = el('button', { type: 'button' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
    });
    btn.addEventListener('click', () => {
      this.deps.loop.togglePaused();
      this.syncControls();
    });
    this.pauseBtn = btn;
    this.refreshPauseButton();
    return btn;
  }

  private refreshPauseButton(): void {
    const paused = this.deps.loop.isPaused;
    setResponsiveLabel(this.pauseBtn, paused ? 'Resume' : 'Pause', paused ? 'PLAY' : 'PAUSE');
    this.pauseBtn.style.borderBottomColor = paused ? ACCENT : 'transparent';
    this.pauseBtn.style.color = paused ? ACCENT : TEXT;
  }

  private buildGrowthButton(): HTMLButtonElement {
    const btn = el('button', { type: 'button' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
    });
    btn.addEventListener('click', () => {
      const paused = !this.deps.getGrowthPaused();
      this.deps.setGrowthPaused(paused);
      persistGrowthPaused(paused);
      this.refreshGrowthButton();
      this.refreshGuide();
      this.showNotice(formatGrowthControl(paused).notice);
    });
    this.growthBtn = btn;
    this.refreshGrowthButton();
    return btn;
  }

  private refreshGrowthButton(): void {
    const paused = this.deps.getGrowthPaused();
    const copy = formatGrowthControl(paused);
    setResponsiveLabel(this.growthBtn, copy.full, copy.compact);
    this.growthBtn.style.borderBottomColor = paused ? ACCENT : 'transparent';
    this.growthBtn.style.color = paused ? ACCENT : TEXT;
    this.growthBtn.setAttribute('aria-pressed', String(paused));
    this.growthBtn.title = paused ? 'Resume settlement and vegetation growth' : 'Pause settlement and vegetation growth';
  }

  private buildGuideButton(): HTMLButtonElement {
    const btn = el('button', { type: 'button' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
    });
    setResponsiveLabel(btn, 'Guide', 'GUIDE');
    btn.addEventListener('click', () => this.toggleGuide());
    this.guideBtn = btn;
    return btn;
  }

  private buildGuideOverlay(): void {
    const backdrop = el('div', { id: 'gw-guide-backdrop' }, {
      display: 'none', position: 'fixed', inset: '0', background: 'rgba(10, 12, 13, 0.58)',
      backdropFilter: 'blur(2px)', pointerEvents: 'auto', zIndex: '1',
    });
    backdrop.addEventListener('click', () => this.toggleGuide(false));

    const panel = el('section', {
      id: 'gw-guide-panel', role: 'dialog', ariaModal: 'true', ariaLabel: 'Site guide', tabIndex: -1,
    }, {
      display: 'none', position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      width: '390px', background: PANEL_BG, border: `1px solid ${BORDER}`, borderRadius: '3px',
      padding: '16px', pointerEvents: 'auto', zIndex: '2', boxShadow: '0 18px 60px rgba(0,0,0,0.38)',
    });

    const header = el('div', {}, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' });
    header.appendChild(el('div', { textContent: 'SITE GUIDE' }, { ...labelStyle(), color: ACCENT, fontSize: '12px' }));
    const close = el('button', { type: 'button', textContent: '×', ariaLabel: 'Close site guide' }, {
      ...baseButtonStyle(), padding: '2px 8px', fontSize: '16px', lineHeight: '20px',
    });
    close.addEventListener('click', () => this.toggleGuide(false));
    this.guideCloseBtn = close;
    header.appendChild(close);
    panel.appendChild(header);

    const overview = el('div', {}, { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '14px', padding: '10px', background: '#141516', border: `1px solid ${BORDER}` });
    for (let i = 0; i < 5; i++) {
      const line = el('div', { textContent: '' }, { ...labelStyle(), color: i === 4 ? ACCENT : TEXT });
      this.guideOverviewLines.push(line);
      overview.appendChild(line);
    }
    panel.appendChild(overview);

    const sections: Array<[string, string[]]> = [
      ['BUILD', ['DRAG TO SURVEY A ROAD', 'DRAW BACK TO THE START TO CLOSE A LOOP', 'DEMOLISH MODE REMOVES A SELECTED ROAD']],
      ['CAMERA', ['RIGHT DRAG ORBITS · MIDDLE DRAG / WASD PANS', 'WHEEL ZOOMS · TWO FINGERS PAN / PINCH / TWIST']],
      ['COMMAND', ['SPACE PAUSES OR RESUMES THE SIM', '1 / 4 / 6 SELECT 1× / 4× / 16× SPEED', 'H OR ? OPENS THIS GUIDE']],
    ];
    for (const [title, lines] of sections) {
      panel.appendChild(el('div', { textContent: title }, { ...labelStyle(), color: TEXT_DIM, marginTop: '14px', marginBottom: '5px' }));
      for (const line of lines) panel.appendChild(el('div', { textContent: line }, { ...labelStyle(), color: TEXT, fontSize: '10px', lineHeight: '1.5' }));
    }
    this.guideBackdrop = backdrop;
    this.guidePanel = panel;
    this.root.appendChild(backdrop);
    this.root.appendChild(panel);
  }

  private toggleGuide(force?: boolean): void {
    this.guideOpen = force ?? !this.guideOpen;
    this.guideBackdrop.style.display = this.guideOpen ? '' : 'none';
    this.guidePanel.style.display = this.guideOpen ? '' : 'none';
    this.guideBtn.style.borderBottomColor = this.guideOpen ? ACCENT : 'transparent';
    this.guideBtn.style.color = this.guideOpen ? ACCENT : TEXT;
    if (this.guideOpen) {
      this.refreshGuide();
      this.guideCloseBtn.focus();
    } else {
      this.guideBtn.focus();
    }
  }

  private refreshGuide(): void {
    if (!this.guideOpen) return;
    const lines = formatSiteOverview(this.deps.getSiteOverview());
    this.guideOverviewLines.forEach((line, i) => { line.textContent = lines[i] ?? ''; });
  }

  private buildNewWorldGroup(): HTMLElement {
    const wrap = el('div', {}, { position: 'relative', display: 'flex' });

    this.newWorldBtn = el('button', { type: 'button' }, baseButtonStyle());
    setResponsiveLabel(this.newWorldBtn, 'New World', 'NEW');
    this.newWorldPanel = el('div', { id: 'gw-new-world-panel' }, {
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
    const btn = el('button', { type: 'button' }, baseButtonStyle());
    setResponsiveLabel(btn, 'Photo', 'PHOTO');
    btn.addEventListener('click', () => this.takePhoto());
    return btn;
  }

  private buildMuteButton(): HTMLElement {
    const btn = el('button', { type: 'button' }, {
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
    setResponsiveLabel(this.muteBtn, muted ? 'Sound Off' : 'Mute', muted ? 'UNMUTE' : 'MUTE');
    this.muteBtn.style.borderBottomColor = muted ? ACCENT : 'transparent';
    this.muteBtn.style.color = muted ? ACCENT : TEXT;
  }

  /** Task 39: MUSIC toggle — same mono/uppercase/orange-underline aesthetic as MUTE, but controls
   * only `audio.musicOn` (the real tracks + pad-fallback bus), independent of MUTE. Default ON,
   * with the orange underline showing while ON (mirroring how every other toggle/mode button here
   * uses the underline for "this is the active state" — MUTE is the one exception, where the
   * underline marks the muted state, since that's the one worth calling out). Persisted immediately
   * on every click via `persistMusicOn`. */
  private buildMusicButton(): HTMLElement {
    const btn = el('button', { type: 'button' }, {
      ...baseButtonStyle(),
      borderBottom: '2px solid transparent',
    });
    btn.addEventListener('click', () => {
      const next = !this.deps.audio.musicOn;
      this.deps.audio.musicOn = next;
      persistMusicOn(next);
      this.refreshMusicButton();
    });
    this.musicBtn = btn;
    this.refreshMusicButton();
    return btn;
  }

  private refreshMusicButton(): void {
    const on = this.deps.audio.musicOn;
    setResponsiveLabel(this.musicBtn, 'Music', 'MUSIC');
    this.musicBtn.style.borderBottomColor = on ? ACCENT : 'transparent';
    this.musicBtn.style.color = on ? ACCENT : TEXT;
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
    this.deps.bus.on('construction:stage', ({ edgeId, crew, stage }) => {
      // crew: -1 is the sim's synthetic "no live crew" sentinel (instant pending-job removal,
      // save-restore's stage-sync emit — see queue.ts) — never a real crew ticker line.
      if (crew < 0) return;
      const notice = formatConstructionNotice(stage, crew);
      if (notice) this.showNotice(notice);

      if (stage === 'removed' || stage === 'painted') {
        this.crewStateByCrew.delete(crew);
      } else {
        const previous = this.crewStateByCrew.get(crew);
        const state: CrewHudState = previous?.edgeId === edgeId ? previous : {
          edgeId,
          activeStage: stage,
          activeProgress: 1,
          stageProgress: {},
          demolish: false,
          onBreak: false,
        };
        state.activeStage = stage;
        state.activeProgress = 1;
        state.stageProgress[stage] = 1;
        this.crewStateByCrew.set(crew, state);
      }
      this.updateTicker();
      this.refreshGuide();
    });
    this.deps.bus.on('construction:progress', ({ edgeId, crew, stage, t, demolish, onBreak }) => {
      if (crew < 0) return;
      const length = this.deps.getEdgeLength(edgeId);
      const progress = length > 0 ? clamp01(t / length) : 0;
      const previous = this.crewStateByCrew.get(crew);
      const state: CrewHudState = previous?.edgeId === edgeId ? previous : {
        edgeId,
        activeStage: stage,
        activeProgress: progress,
        stageProgress: {},
        demolish,
        onBreak,
      };
      state.stageProgress[stage] = progress;
      state.demolish = demolish;
      state.onBreak = onBreak;

      if (demolish) {
        state.activeStage = stage;
        state.activeProgress = progress;
      } else {
        // The stage train emits multiple fronts per tick. Display the furthest-advanced kind that
        // has genuinely started, while the overall bar averages every stage's independent t.
        let activeStage = stage;
        for (const candidate of STAGES) {
          if ((state.stageProgress[candidate] ?? 0) > 0) activeStage = candidate;
        }
        state.activeStage = activeStage;
        state.activeProgress = state.stageProgress[activeStage] ?? 0;
      }
      this.crewStateByCrew.set(crew, state);
      this.scheduleTickerUpdate();
    });
    this.deps.bus.on('roads:edgeAdded', () => {
      this.dismissHint();
      this.refreshGuide();
    });
    this.deps.bus.on('roads:edgeRemoved', () => this.refreshGuide());
    this.deps.bus.on('growth:spawn', () => this.refreshGuide());
    this.deps.bus.on('growth:remove', () => this.refreshGuide());
    this.deps.bus.on('growth:upgrade', () => {
      this.refreshGuide();
      this.showNotice('SETTLEMENT GROWING · NEW BUILDING');
    });
    this.deps.bus.on('quarry:placed', () => this.showNotice('QUARRY ESTABLISHED · SUPPLY LINE READY'));
    this.deps.bus.on('atmosphere:phase', ({ night }) => {
      this.showNotice(night ? 'NIGHT SHIFT · WORK LIGHTS ON' : 'DAYBREAK · FULL OPERATIONS');
    });
  }

  /** Renders one line per crew with an entry in `crewStateByCrew` (indices in ascending crew order,
   * up to MAX_CREW_LINES), collapsing the single fallback "CREW IDLE" line as soon as any crew has
   * a line showing, and collapsing every per-crew line back down once all crews go idle. */
  private scheduleTickerUpdate(): void {
    if (this.tickerFramePending) return;
    this.tickerFramePending = true;
    requestAnimationFrame(() => {
      this.tickerFramePending = false;
      this.updateTicker();
    });
  }

  private updateTicker(): void {
    const activeCrews = [...this.crewStateByCrew.entries()].sort(([a], [b]) => a - b);

    for (let i = 0; i < this.tickerLineEls.length; i++) {
      const line = this.tickerLineEls[i];
      const row = this.tickerRowEls[i];
      const fill = this.tickerProgressEls[i];
      const entry = activeCrews[i];
      if (entry) {
        const [crew, state] = entry;
        line.textContent = formatCrewTicker(crew, state.activeStage, state.demolish, state.onBreak);
        const progress = constructionJobProgress(
          state.stageProgress, state.demolish, state.activeStage, state.activeProgress,
        );
        fill.style.transform = `scaleX(${progress.toFixed(4)})`;
        fill.style.background = state.onBreak ? TEXT_DIM : ACCENT;
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    }

    this.idleLineEl.style.display = activeCrews.length === 0 ? '' : 'none';
  }

  private showNotice(message: string): void {
    while (this.noticeContainer.childElementCount >= 3) {
      this.noticeContainer.firstElementChild?.remove();
    }
    const notice = el('div', { textContent: message }, {
      ...labelStyle(), color: TEXT, background: PANEL_BG, border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${ACCENT}`, borderRadius: '3px', padding: '9px 12px',
      opacity: '0', transform: 'translateY(-8px)', transition: 'opacity 0.2s ease, transform 0.2s ease',
    });
    this.noticeContainer.appendChild(notice);
    requestAnimationFrame(() => {
      notice.style.opacity = '1';
      notice.style.transform = 'translateY(0)';
    });
    window.setTimeout(() => {
      notice.style.opacity = '0';
      notice.style.transform = 'translateY(-5px)';
      window.setTimeout(() => notice.remove(), 220);
    }, 2800);
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
    this.refreshPauseButton();
    this.refreshGrowthButton();
    this.refreshGuide();
  }

  /** Returns true when the key was consumed. Interactive text controls keep their native keys. */
  handleKeyboardShortcut(event: KeyboardEvent): boolean {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return false;
    if (event.code === 'Space') {
      event.preventDefault();
      this.deps.loop.togglePaused();
      this.syncControls();
      return true;
    }
    if (event.key === 'Escape' && this.guideOpen) {
      this.toggleGuide(false);
      return true;
    }
    if (event.key === '?' || event.key.toLowerCase() === 'h') {
      event.preventDefault();
      this.toggleGuide();
      return true;
    }
    const speeds: Record<string, number> = { '1': 1, '4': 4, '6': 16 };
    const speed = speeds[event.key];
    if (speed) {
      event.preventDefault();
      this.deps.loop.timeScale = speed;
      this.syncControls();
      return true;
    }
    return false;
  }
}

export { SAVE_KEY };
