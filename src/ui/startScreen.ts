export interface StartScreenContent {
  eyebrow: string;
  status: string;
  primaryAction: string;
  siteLine: string;
}

function displaySeed(seed: string): string {
  return seed.trim().replace(/[-_\s]+/g, ' ').toUpperCase();
}

export function startScreenContent(seed: string, hasRoads: boolean): StartScreenContent {
  const site = displaySeed(seed);
  return {
    eyebrow: 'ISLAND OPERATIONS',
    status: hasRoads ? 'ACTIVE SITE' : 'NEW SITE',
    primaryAction: hasRoads ? 'CONTINUE SITE' : 'BREAK GROUND',
    siteLine: `${site} · ${hasRoads ? 'AUTOSAVE READY' : 'READY FOR SURVEY'}`,
  };
}

export function isStartScreenActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function shouldStartFromKeyboard(key: string, secondaryActionFocused: boolean): boolean {
  return isStartScreenActivationKey(key) && !secondaryActionFocused;
}

const START_SCREEN_STYLE_ID = 'gw-start-screen-style';
const EXIT_MS = 650;

const START_SCREEN_CSS = `
  #gw-start-screen {
    --gw-ink: #111719;
    --gw-panel: rgba(17, 23, 25, 0.88);
    --gw-border: rgba(216, 213, 205, 0.28);
    --gw-paper: #ece9df;
    --gw-muted: #a9aaa5;
    --gw-accent: #f06b24;
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow: hidden;
    display: grid;
    place-items: center;
    color: var(--gw-paper);
    background: var(--gw-ink);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    opacity: 1;
    transition: opacity ${EXIT_MS}ms cubic-bezier(.22,.61,.36,1), filter ${EXIT_MS}ms ease;
    isolation: isolate;
  }
  #gw-start-screen.gw-start-leaving {
    opacity: 0;
    filter: saturate(.72) brightness(1.2);
    pointer-events: none;
  }
  #gw-start-screen picture,
  #gw-start-screen .gw-start-art,
  #gw-start-screen .gw-start-shade,
  #gw-start-screen .gw-start-grain {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  #gw-start-screen .gw-start-art {
    object-fit: cover;
    object-position: center center;
    animation: gw-title-drift 14s ease-out both;
    user-select: none;
  }
  #gw-start-screen .gw-start-shade {
    background:
      linear-gradient(90deg, rgba(7,12,14,.82) 0%, rgba(7,12,14,.52) 38%, rgba(7,12,14,.06) 72%),
      linear-gradient(0deg, rgba(7,12,14,.62) 0%, transparent 44%, rgba(7,12,14,.14) 100%);
  }
  #gw-start-screen .gw-start-grain {
    opacity: .12;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.32'/%3E%3C/svg%3E");
    mix-blend-mode: soft-light;
    pointer-events: none;
  }
  #gw-start-screen .gw-start-shell {
    position: relative;
    z-index: 2;
    width: min(1180px, calc(100vw - 64px));
    min-height: min(690px, calc(100vh - 64px));
    display: flex;
    align-items: flex-end;
    padding: clamp(24px, 5vw, 72px);
    box-sizing: border-box;
  }
  #gw-start-screen .gw-start-card {
    width: min(475px, 100%);
    min-width: 0;
    box-sizing: border-box;
    padding: clamp(24px, 4vw, 42px);
    background: linear-gradient(145deg, rgba(18,24,26,.94), rgba(18,24,26,.78));
    border: 1px solid var(--gw-border);
    border-top: 3px solid var(--gw-accent);
    box-shadow: 0 28px 90px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.04);
    backdrop-filter: blur(14px) saturate(1.08);
    animation: gw-title-card-in .75s cubic-bezier(.16,1,.3,1) both;
  }
  #gw-start-screen .gw-start-eyebrow,
  #gw-start-screen .gw-start-status,
  #gw-start-screen .gw-start-site,
  #gw-start-screen .gw-start-foot {
    text-transform: uppercase;
    letter-spacing: .16em;
  }
  #gw-start-screen .gw-start-eyebrow {
    color: var(--gw-accent);
    font-size: 11px;
    margin-bottom: 18px;
  }
  #gw-start-screen h1 {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: clamp(48px, 7.6vw, 92px);
    line-height: .82;
    letter-spacing: -.065em;
    text-transform: uppercase;
    font-weight: 820;
    color: var(--gw-paper);
    text-shadow: 0 8px 35px rgba(0,0,0,.35);
  }
  #gw-start-screen .gw-start-tagline {
    margin: 22px 0 28px;
    max-width: 36ch;
    color: #d3d2cc;
    font: 500 clamp(13px, 1.25vw, 16px)/1.6 Inter, ui-sans-serif, system-ui, sans-serif;
  }
  #gw-start-screen .gw-start-site-row {
    display: flex;
    flex-wrap: wrap;
    gap: 9px 14px;
    align-items: center;
    margin-bottom: 22px;
    padding-top: 15px;
    border-top: 1px solid var(--gw-border);
  }
  #gw-start-screen .gw-start-status {
    padding: 5px 7px;
    color: var(--gw-ink);
    background: var(--gw-accent);
    font-size: 9px;
    font-weight: 800;
  }
  #gw-start-screen .gw-start-site { color: var(--gw-muted); font-size: 9px; }
  #gw-start-screen .gw-start-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  #gw-start-screen button {
    min-height: 48px;
    padding: 12px 18px;
    border: 1px solid var(--gw-border);
    color: var(--gw-paper);
    background: rgba(255,255,255,.045);
    font: 750 10px/1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: .13em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform .18s ease, border-color .18s ease, background .18s ease, color .18s ease;
  }
  #gw-start-screen button:hover { transform: translateY(-2px); border-color: rgba(255,255,255,.55); }
  #gw-start-screen button:focus-visible { outline: 2px solid #ffd29d; outline-offset: 3px; }
  #gw-start-screen .gw-start-primary {
    min-width: 190px;
    color: #161819;
    border-color: var(--gw-accent);
    background: var(--gw-accent);
  }
  #gw-start-screen .gw-start-primary:hover { background: #ff7e35; }
  #gw-start-screen .gw-start-foot {
    margin-top: 24px;
    color: rgba(236,233,223,.58);
    font-size: 8px;
    line-height: 1.7;
    white-space: pre-line;
  }
  @keyframes gw-title-card-in {
    from { opacity: 0; transform: translateY(24px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes gw-title-drift {
    from { transform: scale(1.025); }
    to { transform: scale(1.065); }
  }
  @media (max-width: 600px) {
    #gw-start-screen .gw-start-shade {
      background: linear-gradient(0deg, rgba(7,12,14,.92) 0%, rgba(7,12,14,.48) 58%, rgba(7,12,14,.08) 100%);
    }
    #gw-start-screen .gw-start-shell {
      width: 100%;
      min-height: 100%;
      padding: max(18px, env(safe-area-inset-top)) 16px max(18px, env(safe-area-inset-bottom));
      align-items: flex-end;
    }
    #gw-start-screen .gw-start-card {
      width: 100%;
      min-width: 0;
      padding: 24px 20px 22px;
      backdrop-filter: blur(10px);
    }
    #gw-start-screen h1 {
      min-width: 0;
      font-size: clamp(42px, 13.2vw, 56px);
      letter-spacing: -.055em;
    }
    #gw-start-screen .gw-start-tagline { margin: 17px 0 20px; }
    #gw-start-screen .gw-start-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    #gw-start-screen .gw-start-actions button { min-width: 0; padding-inline: 10px; }
  }
  @media (prefers-reduced-motion: reduce) {
    #gw-start-screen, #gw-start-screen .gw-start-art, #gw-start-screen .gw-start-card { animation: none; transition-duration: .01ms; }
  }
`;

function injectStartScreenStyles(): void {
  if (document.getElementById(START_SCREEN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = START_SCREEN_STYLE_ID;
  style.textContent = START_SCREEN_CSS;
  document.head.appendChild(style);
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export interface StartScreenOptions {
  seed: string;
  hasRoads: boolean;
  inertRoot: HTMLElement;
  onContinue: () => void;
  onNewWorld: () => void;
}

/** Full-screen, keyboard-first launch overlay. The live world is already initialized underneath,
 * but remains inert and sim-paused until the primary action hands control back to main.ts. */
export class StartScreen {
  private overlay: HTMLElement;
  private primary: HTMLButtonElement;
  private closing = false;

  constructor(private options: StartScreenOptions) {
    injectStartScreenStyles();
    const content = startScreenContent(options.seed, options.hasRoads);

    this.overlay = node('section', undefined);
    this.overlay.id = 'gw-start-screen';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Groundwork start screen');

    const picture = node('picture');
    const source = node('source');
    source.media = '(max-width: 600px)';
    source.srcset = 'art/groundwork-title-dawn-mobile.jpg';
    const art = node('img', 'gw-start-art');
    art.src = 'art/groundwork-title-dawn.jpg';
    art.alt = '';
    art.decoding = 'async';
    art.draggable = false;
    picture.append(source, art);
    this.overlay.appendChild(picture);
    this.overlay.appendChild(node('div', 'gw-start-shade'));
    this.overlay.appendChild(node('div', 'gw-start-grain'));

    const shell = node('div', 'gw-start-shell');
    const card = node('div', 'gw-start-card');
    card.appendChild(node('div', 'gw-start-eyebrow', content.eyebrow));
    card.appendChild(node('h1', undefined, 'Groundwork'));
    card.appendChild(node('p', 'gw-start-tagline', 'Build the road. Watch the island come alive.'));

    const siteRow = node('div', 'gw-start-site-row');
    siteRow.appendChild(node('span', 'gw-start-status', content.status));
    siteRow.appendChild(node('span', 'gw-start-site', content.siteLine));
    card.appendChild(siteRow);

    const actions = node('div', 'gw-start-actions');
    this.primary = node('button', 'gw-start-primary', content.primaryAction);
    this.primary.type = 'button';
    this.primary.addEventListener('click', () => this.continue());
    const newWorld = node('button', 'gw-start-secondary', 'New Island');
    newWorld.type = 'button';
    newWorld.addEventListener('click', () => {
      if (this.closing) return;
      this.closing = true;
      this.options.onNewWorld();
    });
    actions.append(this.primary, newWorld);
    card.appendChild(actions);
    card.appendChild(node('div', 'gw-start-foot', 'DRAW ROADS · DIRECT CREWS · GROW TOWNS\nENTER / SPACE TO START'));
    shell.appendChild(card);
    this.overlay.appendChild(shell);

    this.options.inertRoot.inert = true;
    document.body.appendChild(this.overlay);
    document.addEventListener('keydown', this.onKeyDown, true);
    requestAnimationFrame(() => this.primary.focus());
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const secondaryActionFocused = event.target instanceof HTMLButtonElement && event.target !== this.primary;
    if (!shouldStartFromKeyboard(event.key, secondaryActionFocused) || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    this.continue();
  };

  private continue(): void {
    if (this.closing) return;
    this.closing = true;
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.classList.add('gw-start-leaving');
    this.options.inertRoot.inert = false;
    this.options.onContinue();
    window.setTimeout(() => this.overlay.remove(), EXIT_MS);
  }
}
