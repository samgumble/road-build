import type { EventBus } from '../core/events';

// ---- Tuning constants -------------------------------------------------

const MASTER_GAIN = 0.5;
const MUSIC_GAIN = 0.4;
const SFX_GAIN = 0.6;
const MUTE_RAMP = 0.3; // seconds
const MUSIC_TOGGLE_RAMP = 0.3; // seconds, ramped like MUTE_RAMP so flipping MUSIC never clicks

// Chord progression. This used to drive a sustained synth pad (already demoted to an
// offline-fallback by Task 39's de-drone pass) — after a THIRD drone report the pad was removed
// outright, along with the day-shimmer sine: this codebase now has a standing rule of NO sustained
// synthesized tones, ever (see HANDOFF invariants). The root cycle survives because the pluck
// arpeggio wanders over it; only the sustained oscillators are gone. Offline/blocked-network
// sessions simply get plucks + nature + construction sfx with no music bed.
const CHORD_ROOTS_HZ = [110.0, 130.81, 146.83, 164.81, 98.0]; // A2, C3, D3, E3, G2
const CHORD_PERIOD = 24; // seconds per root

// Real ambient music tracks (Task 39): a small rotation of pre-recorded CC0 ambient tracks (see
// public/music/LICENSE.txt for sourcing) played one at a time through HTMLAudioElement ->
// MediaElementAudioSourceNode -> the music bus, with a slow crossfade between tracks and generous
// silence gaps — this is a zen game, and continuous wall-to-wall music would undercut that as much
// as the old drone did. Lazy-loaded well after boot (first gesture + a delay) so it never competes
// with initial load, and any track that fails to load/play is just skipped rather than surfaced.
const MUSIC_TRACKS: { file: string; title: string }[] = [
  { file: 'contemplation.mp3', title: 'Contemplation' },
  { file: 'ice-shine-bells.ogg', title: 'Ice Shine Bells' },
  { file: 'the-fade.mp3', title: 'The Fade' },
];
const MUSIC_BASE_URL = 'music/';
const TRACK_CROSSFADE = 6; // seconds, equal-power crossfade between outgoing/incoming tracks
const TRACK_GAP_MIN = 30; // seconds of silence between one track ending and the next starting
const TRACK_GAP_MAX = 90;
// Groundwork batch-review Finding 2: a per-load watchdog so a track that never fires
// canplaythrough/error (a stalled fetch — e.g. a connection that hangs rather than cleanly
// erroring) doesn't wedge `phase` in 'loading' forever, which would otherwise both play nothing
// AND (if a previous track had already set the sticky `loadedAny` flag) keep the pad fallback
// gated off — permanent silence with no fallback either. 20s is generously past any realistic
// load time for these small ambient files, so it never fires under normal conditions.
const TRACK_LOAD_WATCHDOG_MS = 20000;
// Groundwork batch-review Finding 2: after this many consecutive full rotations through every
// track with zero successful plays, stop retrying for the rest of the session rather than
// hammering a 2s retry loop forever (e.g. fully offline, or the whole music/ directory 404ing) —
// the pad fallback keeps covering for it regardless (hasLoadedTrack() stays false, same as it
// always would in an all-failed scenario), so nothing is lost by giving up the retry loop itself.
const MUSIC_MAX_FAILED_CYCLES = 2;
const TRACK_LOAD_DELAY_MIN = 3; // seconds after the qualifying gesture before we even start fetching
const TRACK_LOAD_DELAY_MAX = 6;
const TRACK_GAIN = 0.9; // per-track element gain (tracks are already mixed/mastered; this just
// trims a little headroom into the shared music bus, distinct from the synthesized pad's gain)

// Pluck / arpeggio (the "chill music" layer)
const PLUCK_SCALE_STEPS = [0, 3, 5, 7, 10]; // pentatonic minor intervals (semitones) over the chord root
const PLUCK_MIN_INTERVAL_DAY = 8;
const PLUCK_MAX_INTERVAL_DAY = 16;
const PLUCK_MIN_INTERVAL_NIGHT = 16; // roughly half the rate at night
const PLUCK_MAX_INTERVAL_NIGHT = 32;
const PLUCK_NOTES_MIN = 3;
const PLUCK_NOTES_MAX = 6;
const PLUCK_NOTE_SPACING_MIN = 0.3;
const PLUCK_NOTE_SPACING_MAX = 0.6;
const PLUCK_OCTAVE_MIN = 3;
const PLUCK_OCTAVE_MAX = 5;
const PLUCK_DECAY_MIN = 0.4;
const PLUCK_DECAY_MAX = 0.8;
const PLUCK_GAIN_DB = -16; // mix level into the music bus
const PLUCK_NIGHT_GAIN_DB_OFFSET = -6;
const PLUCK_VELOCITY_JITTER = 0.3; // +-30%
const PLUCK_BELL_CHANCE = 0.2;
const PLUCK_BELL_DECAY = 2.0;
const PLUCK_DELAY_TIME_L = 0.28;
const PLUCK_DELAY_TIME_R = 0.42;
const PLUCK_DELAY_FEEDBACK = 0.25;


// Birds / crickets
const BIRD_MIN_INTERVAL = 4;
const BIRD_MAX_INTERVAL = 11;
const BIRD_BLIP_MIN = 3;
const BIRD_BLIP_MAX = 5;
const BIRD_FREQ_MIN = 2200;
const BIRD_FREQ_MAX = 4500;
const BIRD_GAIN_DB = -24;

const CRICKET_FREQ = 4200;
const CRICKET_PULSE_HZ = 12;
const CRICKET_BURST_MIN = 1.2;
const CRICKET_BURST_MAX = 1.5;
const CRICKET_MIN_INTERVAL = 3;
const CRICKET_MAX_INTERVAL = 8;
const CRICKET_GAIN_DB = -24;

// Construction. The continuous engine-rumble bed (a lowpassed noise loop gated by crew activity)
// was removed here — it read as a constant background drone whenever any crew was working, which
// in practice is most of the time. CREW_ACTIVE_RELEASE survives it: the beeper/radio-chatter
// layers still need the same "this crew is still working" liveness window it defined.
const CREW_ACTIVE_RELEASE = 1.2; // seconds of silence-from-last-progress before a crew reads as idle
const BLIP_GAIN_DB = -18;

export function roadStageCue(stage: string): 'none' | 'progress' | 'complete' {
  if (stage === 'removed') return 'none';
  return stage === 'painted' ? 'complete' : 'progress';
}
const BEEPER_FREQ = 880;
const BEEPER_HZ = 1.2; // pulses per second
const BEEPER_GAIN_DB = -26;
const BEEPER_DUTY = 0.5;

const PAN_CLAMP = 0.7;
const PAN_DIVISOR = 120;

// Construction theater one-shots (2026-07-14): a low settle THUNK when the crane lands a bridge
// deck span, and a soft leafy rustle-crack as corridor trees fall ahead of the excavator. Both
// are strictly self-contained one-shots (attack -> exponential decay, disconnect onended) —
// nothing here may loop or sustain, per the "no sustained synthesized tones, ever" invariant.
const DECK_THUNK_GAIN_DB = -14;
const DECK_THUNK_DUR = 0.32;
const TREE_FALL_GAIN_DB = -21;
const TREE_FALL_DUR = 0.24;
const TREE_FALL_MIN_INTERVAL = 0.09; // s between rustles — a clearing sweep rustles, not machine-guns
const TREE_FALL_MAX_QUEUE = 8; // batch clears (fast-forward) collapse to at most this many rustles
const CREW_SWITCH_MARGIN = 20; // units a competitor must beat the followed crew by before we switch
const PAN_EASE_TAU = 0.15; // seconds, damped-lerp time constant for the beeper pan

// Radio chatter (Groundwork Task 26): occasional filtered-noise blips per active crew, panned to
// that crew's own position (not the shared followed-crew pan the beeper uses — each crew chatters
// independently since this is meant to read as "a radio somewhere on that crew's site", not a
// single shared voice).
const RADIO_MIN_INTERVAL = 20; // seconds
const RADIO_MAX_INTERVAL = 45;
const RADIO_GAIN_DB = -30;
const RADIO_FILTER_FREQ = 1800; // bandpass center, walkie-talkie-ish
const RADIO_FILTER_Q = 2.5;
const RADIO_BLIP_MIN = 2;
const RADIO_BLIP_MAX = 4;
const RADIO_BLIP_DUR_MIN = 0.08;
const RADIO_BLIP_DUR_MAX = 0.16;

// Grader scrape (Groundwork Task 26 deliverable 6): a soft one-shot tied to grader passes during
// gravel-stage work, triggered by constructionRenderer.ts (which owns the actual grader rig/timing)
// via a DOM CustomEvent rather than a new EventBus contract — see the listener in the constructor.
const SCRAPE_GAIN_DB = -22;
const SCRAPE_DUR = 0.5;
const SCRAPE_FILTER_FREQ = 900;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Generative ambient audio: a sparse generative kalimba/bell pluck arpeggio layer (through a
 * ping-pong feedback delay) wandering over a slowly shifting pentatonic chord progression,
 * day/night birds and crickets, construction sfx (stage-complete blips, demolish reverse-beeper,
 * radio chatter, completion swells/chimes), and (Task 39) a slow-rotating background of real CC0
 * ambient music tracks. There are deliberately NO sustained synthesized tones anywhere in this
 * file — the engine rumble, the synth pad (even as an offline fallback), and the day-shimmer sine
 * were each removed after being reported as "background drone" (three separate reports). Built
 * lazily via `start()` on first user gesture (autoplay policy); until then no `AudioContext` or
 * nodes exist. The real tracks lazy-load a few seconds after `start()`; sessions where no track
 * loads simply have no music bed.
 *
 * All one-shot and looping scheduling is driven by `ctx.currentTime` lookahead scheduling inside
 * `update()`, which is called once per render frame — there is no `setInterval` anywhere in this
 * class except the music track rotation's load-delay/gap timers, which use `window.setTimeout`
 * because they span user-gesture/network-load boundaries rather than per-frame audio scheduling
 * (see `MusicPlayer`). Continuous sound sources (pluck delay bus, cricket burst noise) are
 * created once in `start()`/on first gate-open and reused; only true one-shots (bird chirps,
 * blips, beeper pulses, pluck/bell notes) allocate and discard nodes.
 */
export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  /** Task 39: gain node sitting between `master` and `musicBus`, ramped by the MUSIC HUD toggle
   * (independent of MUTE, which zeroes `master` and kills everything). Holds real tracks +
   * real tracks ONLY — the pluck layer stays on `musicBus` directly (unaffected by this toggle),
   * matching the spec's "pluck stays SFX-adjacent on its current bus" instruction. */
  private musicToggleGain: GainNode | null = null;
  private _musicOn = true;

  private _muted = false;

  // Chord progression clock (shared root cycle the pluck layer arpeggiates over)
  private chordTimer = 0;
  private chordIdx = 0;

  // Real ambient music track rotation (Task 39)
  private musicPlayer: MusicPlayer | null = null;

  // Pluck / arpeggio layer
  private pluckBus: GainNode | null = null;
  private pluckTimer = 0;
  private pluckNextInterval = PLUCK_MIN_INTERVAL_DAY;

  // Birds / crickets
  private birdTimer = 0;
  private birdNextInterval = BIRD_MIN_INTERVAL;
  private cricketTimer = 0;
  private cricketNextInterval = CRICKET_MIN_INTERVAL;
  private cricketBurstRemaining = 0;
  private cricketPulsePhase = 0;

  // Construction (Task 25: one followed-crew voice total, shared across every crew — see
  // `nearestActiveCrew` — rather than one per crew, keeping this simple per the binding spec).
  /** Last-seen progress per crew (0-based index, matching `construction:progress`'s `crew`
   * field): `at` is this crew's own recency clock (so one crew going idle doesn't reset another's),
   * `x`/`demolish` are that crew's most recent reported position/demolish flag. `crew: -1` (the
   * sim's synthetic "no live crew" sentinel — see queue.ts) never reaches here, since only
   * `construction:progress` feeds this map and that event is never emitted with crew -1. */
  private crewProgress: Map<number, { at: number; x: number; demolish: boolean }> = new Map();
  private clockTime = 0; // ctx.currentTime substitute tracked via update(dt), used for gating
  /** Crew index the shared beeper voice is currently "locked onto" (see `nearestActiveCrew`'s
   * hysteresis) — null when no crew has ever been picked or the followed crew went idle with no
   * replacement chosen yet. Persisting this across frames stops a camera parked equidistant
   * between two crews from flip-flopping crew identity (and the stereo image) every frame. */
  private followedCrew: number | null = null;
  /** Eased pan value for the beeper panner, damped per-frame rather than snapping via a bare
   * `setValueAtTime`. */
  private panCurrent = 0;

  private beeperGain: GainNode | null = null;
  private beeperPanner: StereoPannerNode | null = null;
  private beeperPhase = 0;
  private beeperOn = false;

  private noiseBuffer: AudioBuffer | null = null;

  // Radio chatter (Task 26): one timer/interval per crew index, independently scheduled while that
  // crew is active (see `updateRadioChatter`) — deliberately separate from the shared rumble/beeper
  // followed-crew bookkeeping above, since every active crew should be able to chatter on its own.
  private radioTimer: Map<number, number> = new Map();
  private radioNextInterval: Map<number, number> = new Map();

  // Grader scrape (Task 26 deliverable 6): queued by the DOM CustomEvent listener below (fired from
  // constructionRenderer.ts, which owns the actual grader rig/pass timing) and drained one-shot-style
  // in `update()`, following the same "self-contained, disconnect onended" pattern as every other
  // one-shot in this file.
  private pendingScrapes: number[] = []; // queued pan positions (x, pre-divided) awaiting playback
  private onGraderScrape = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ x: number }>).detail;
    if (detail) this.pendingScrapes.push(detail.x);
  };

  // Construction theater one-shot queues (see DECK_THUNK_*/TREE_FALL_* constants): events land
  // here and update() drains them with camera context, mirroring pendingScrapes above.
  private pendingDeckThunks: number[] = []; // world x per landed span, for panning
  private pendingTreeFalls = 0;
  private treeFallCooldown = 0;

  constructor(private bus: EventBus) {
    this.bus.on('construction:stage', (payload) => this.onConstructionStage(payload));
    this.bus.on('construction:progress', (payload) => this.onConstructionProgress(payload));
    this.bus.on('traffic:edgeEntered', ({ firstUse }) => {
      if (firstUse) this.playFirstUseChime();
    });
    this.bus.on('construction:deckSettled', ({ x }) => this.pendingDeckThunks.push(x));
    this.bus.on('wilderness:cleared', ({ indices }) => {
      this.pendingTreeFalls = Math.min(TREE_FALL_MAX_QUEUE, this.pendingTreeFalls + indices.length);
    });
    this.bus.on('growth:cleared', ({ kind }) => {
      if (kind === 'tree') this.pendingTreeFalls = Math.min(TREE_FALL_MAX_QUEUE, this.pendingTreeFalls + 1);
    });
    window.addEventListener('construction:graderScrape', this.onGraderScrape);
  }

  /** Detaches the DOM listener registered in the constructor and (Task 39) tears down the music
   * rotation's pending timers/`<audio>` elements — call once when tearing down the whole ambient
   * audio system. Every synthesized AudioContext node otherwise still lives for the page's lifetime
   * by design; `musicPlayer` is the one part of this class with real disposable resources
   * (setTimeout handles, `<audio>` element network activity). */
  dispose(): void {
    window.removeEventListener('construction:graderScrape', this.onGraderScrape);
    this.musicPlayer?.dispose();
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(v: boolean) {
    this._muted = v;
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const target = v ? 0 : MASTER_GAIN;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + MUTE_RAMP);
  }

  /** Task 39: MUSIC HUD toggle — controls ONLY the music-bus routing for real tracks + the pad
   * fallback (via `musicToggleGain`), ramped so flipping it never clicks. Independent of `muted`:
   * MUTE still master-kills everything (tracks, pad, pluck, birds, construction sfx alike), while
   * this only silences the tracks/pad-fallback layer. Defaults to true (music on) and is expected
   * to be persisted/restored by the caller (see Hud's localStorage wiring). */
  get musicOn(): boolean {
    return this._musicOn;
  }

  set musicOn(v: boolean) {
    this._musicOn = v;
    if (!this.ctx || !this.musicToggleGain) return;
    const now = this.ctx.currentTime;
    const target = v ? 1 : 0;
    this.musicToggleGain.gain.cancelScheduledValues(now);
    this.musicToggleGain.gain.setValueAtTime(this.musicToggleGain.gain.value, now);
    this.musicToggleGain.gain.linearRampToValueAtTime(target, now + MUSIC_TOGGLE_RAMP);
  }

  /** Builds the AudioContext and full node graph. Call once, from a user-gesture handler
   * (pointerdown). Safe to call more than once — no-ops after the first successful build. */
  start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
    this.master = master;

    // musicBus: the pluck layer's existing, un-toggled home (Task 39 spec: it stays exactly as-is,
    // "SFX-adjacent", unaffected by the MUSIC toggle — only MUTE reaches it, via `master`).
    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN;
    musicBus.connect(master);

    // trackBus: the real tracks' home, gated by `musicToggleGain` (the MUSIC toggle) on its way to
    // `master`. Kept at the same nominal level as musicBus so toggling MUSIC off/on doesn't change
    // the overall balance of what's left playing.
    const musicToggleGain = ctx.createGain();
    musicToggleGain.gain.value = this._musicOn ? 1 : 0;
    musicToggleGain.connect(master);
    this.musicToggleGain = musicToggleGain;

    const trackBus = ctx.createGain();
    trackBus.gain.value = MUSIC_GAIN;
    trackBus.connect(musicToggleGain);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_GAIN;
    sfxBus.connect(master);
    this.sfxBus = sfxBus;

    this.noiseBuffer = this.buildNoiseBuffer(ctx);

    this.buildPluckBus(ctx, musicBus);
    this.buildConstructionBed(ctx, sfxBus);

    this.musicPlayer = new MusicPlayer(ctx, trackBus);
    // Lazy-load well after this first gesture (never block boot): a few seconds' delay, then the
    // player fetches/decodes tracks on its own schedule (see MusicPlayer.beginLoading).
    const delay = (TRACK_LOAD_DELAY_MIN + Math.random() * (TRACK_LOAD_DELAY_MAX - TRACK_LOAD_DELAY_MIN)) * 1000;
    window.setTimeout(() => this.musicPlayer?.beginLoading(), delay);

    if (ctx.state === 'suspended') void ctx.resume();
  }

  // ---- Setup helpers ----------------------------------------------------

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate * 2; // 2s loopable buffer
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Continuous send bus for the pluck/arpeggio layer: a ping-pong feedback delay (two DelayNodes,
   * hard-panned L/R, cross-feeding into each other with StereoPanners flipping the image each
   * bounce) sitting behind a fixed -16dB mix gain into the music bus. Built once; individual pluck
   * notes are one-shots that feed into `pluckBus`, which then also feeds the delay in parallel. */
  private buildPluckBus(ctx: AudioContext, musicBus: AudioNode): void {
    const pluckBus = ctx.createGain();
    pluckBus.gain.value = dbToGain(PLUCK_GAIN_DB);
    pluckBus.connect(musicBus);
    this.pluckBus = pluckBus;

    // Dry path straight to the music bus is `pluckBus` itself (connected above). The wet/delay
    // path taps off the same bus and ping-pongs before rejoining the music bus at the same level.
    const delayL = ctx.createDelay(1);
    delayL.delayTime.value = PLUCK_DELAY_TIME_L;
    const delayR = ctx.createDelay(1);
    delayR.delayTime.value = PLUCK_DELAY_TIME_R;

    const panL = ctx.createStereoPanner();
    panL.pan.value = -1;
    const panR = ctx.createStereoPanner();
    panR.pan.value = 1;

    const feedbackL = ctx.createGain();
    feedbackL.gain.value = PLUCK_DELAY_FEEDBACK;
    const feedbackR = ctx.createGain();
    feedbackR.gain.value = PLUCK_DELAY_FEEDBACK;

    const wetGain = ctx.createGain();
    wetGain.gain.value = 1;

    // pluckBus -> delayL -> panL -> wetGain/out, and panL -> feedbackR -> delayR (cross-feed) to
    // create the ping-pong bounce; symmetric for the R side.
    pluckBus.connect(delayL);
    pluckBus.connect(delayR);
    delayL.connect(panL);
    delayR.connect(panR);
    panL.connect(wetGain);
    panR.connect(wetGain);
    panL.connect(feedbackR);
    feedbackR.connect(delayR);
    panR.connect(feedbackL);
    feedbackL.connect(delayL);
    wetGain.connect(musicBus);
  }

  private buildConstructionBed(ctx: AudioContext, sfxBus: AudioNode): void {
    // (The continuous engine-rumble noise loop that used to live here was removed — it read as a
    // constant background drone. Construction now only speaks through one-shots and the gated
    // beeper below.)

    // Reverse beeper bed: a single oscillator gated on/off in update() to form the square pulse
    // train, rather than scheduling one-shots per pulse.
    const beepOsc = ctx.createOscillator();
    beepOsc.type = 'square';
    beepOsc.frequency.value = BEEPER_FREQ;
    const beepGain = ctx.createGain();
    beepGain.gain.value = 0;
    const beepPanner = ctx.createStereoPanner();
    beepOsc.connect(beepGain);
    beepGain.connect(beepPanner);
    beepPanner.connect(sfxBus);
    beepOsc.start();

    this.beeperGain = beepGain;
    this.beeperPanner = beepPanner;
  }

  // ---- Event handlers -----------------------------------------------------

  private onConstructionProgress(payload: { pos: { x: number }; demolish: boolean; crew: number }): void {
    // crew: -1 never reaches here (see crewProgress's doc comment) but guard anyway rather than
    // indexing a bogus map entry.
    if (payload.crew < 0) return;
    this.crewProgress.set(payload.crew, { at: this.clockTime, x: payload.pos.x, demolish: payload.demolish });
  }

  private onConstructionStage(payload: { stage: string; crew?: number }): void {
    if (!this.ctx || !this.sfxBus) return;
    const cue = roadStageCue(payload.stage);
    if (cue === 'none') return;
    if (cue === 'complete' && (payload.crew ?? 0) >= 0) this.playCompletionSwell();
    else this.playStageBlip();
  }

  private playCompletionSwell(): void {
    const ctx = this.ctx;
    const destination = this.sfxBus;
    if (!ctx || !destination) return;
    const now = ctx.currentTime;
    const notes = [392, 493.88, 587.33]; // G4, B4, D5 — warmer/lower than the normal stage blip
    notes.forEach((freq, i) => {
      const startAt = now + i * 0.11;
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(dbToGain(BLIP_GAIN_DB - 2), startAt + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.75);
      osc.connect(g);
      g.connect(destination);
      osc.start(startAt);
      osc.stop(startAt + 0.8);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    });
  }

  private playFirstUseChime(): void {
    const ctx = this.ctx;
    const destination = this.sfxBus;
    if (!ctx || !destination) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(783.99, now);
    osc.frequency.exponentialRampToValueAtTime(987.77, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(dbToGain(BLIP_GAIN_DB - 8), now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc.connect(g);
    g.connect(destination);
    osc.start(now);
    osc.stop(now + 0.46);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  private playStageBlip(): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus) return;
    const now = ctx.currentTime;
    const gainLin = dbToGain(BLIP_GAIN_DB);

    // Soft two-note marimba-ish blip: two sines in quick succession, each with a fast decay.
    const notes = [523.25, 659.25]; // C5, E5
    notes.forEach((freq, i) => {
      const startAt = now + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(gainLin, startAt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.35);
      osc.connect(g);
      g.connect(sfxBus);
      osc.start(startAt);
      osc.stop(startAt + 0.4);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    });
  }

  // ---- Per-frame update ---------------------------------------------------

  /** Advance all scheduling; called once per render frame. `timeOfDay` in 0..1, `cameraX` world x. */
  update(dt: number, timeOfDay: number, cameraX: number): void {
    this.clockTime += dt;
    if (!this.ctx) return; // not started yet (no user gesture) — nothing to do

    // A simple day/night split (sun elevation sign) is sufficient for birds/crickets/plucks —
    // matches Atmosphere's own sunElevation(t) formula without needing a direct dependency on it.
    const night = this.isNightFromTimeOfDay(timeOfDay);

    this.updateChordProgression(dt);
    this.updatePluck(dt, night);
    this.updateBirdsAndCrickets(dt, night);
    this.updateConstruction(dt, cameraX);
    this.updateRadioChatter(dt, cameraX);
    this.drainGraderScrapes(cameraX);
    this.drainDeckThunks(cameraX);
    this.drainTreeFalls(dt);
    this.musicPlayer?.update();
  }

  private drainDeckThunks(cameraX: number): void {
    if (this.pendingDeckThunks.length === 0) return;
    const xs = this.pendingDeckThunks;
    this.pendingDeckThunks = [];
    for (const x of xs) this.playDeckThunkOneShot(x, cameraX);
  }

  private drainTreeFalls(dt: number): void {
    this.treeFallCooldown = Math.max(0, this.treeFallCooldown - dt);
    if (this.pendingTreeFalls <= 0 || this.treeFallCooldown > 0) return;
    this.pendingTreeFalls--;
    this.treeFallCooldown = TREE_FALL_MIN_INTERVAL;
    this.playTreeFallOneShot();
  }

  /** Low settle thunk for a landed bridge deck span: a pitch-dropping sine thump plus a short
   * lowpassed noise slap, panned by world x like the grader scrapes. Strictly one-shot. */
  private playDeckThunkOneShot(spanX: number, cameraX: number): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const pan = clamp((spanX - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(sfxBus);

    const gainLin = dbToGain(DECK_THUNK_GAIN_DB);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + DECK_THUNK_DUR);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0, now);
    thumpGain.gain.linearRampToValueAtTime(gainLin, now + 0.012);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + DECK_THUNK_DUR);
    thump.connect(thumpGain);
    thumpGain.connect(panner);
    thump.start(now);
    thump.stop(now + DECK_THUNK_DUR + 0.02);

    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const slapFilter = ctx.createBiquadFilter();
    slapFilter.type = 'lowpass';
    slapFilter.frequency.value = 320;
    const slapGain = ctx.createGain();
    slapGain.gain.setValueAtTime(0, now);
    slapGain.gain.linearRampToValueAtTime(gainLin * 0.8, now + 0.008);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    slap.connect(slapFilter);
    slapFilter.connect(slapGain);
    slapGain.connect(panner);
    slap.start(now);
    slap.stop(now + 0.17);

    slap.onended = () => {
      thump.disconnect();
      thumpGain.disconnect();
      slap.disconnect();
      slapFilter.disconnect();
      slapGain.disconnect();
      panner.disconnect();
    };
  }

  /** Soft leafy crack-rustle for one corridor tree felled by the grading front: a bandpassed
   * noise burst with a fast attack and a quicker low knock underneath. Strictly one-shot,
   * rate-limited by `drainTreeFalls`. */
  private playTreeFallOneShot(): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const gainLin = dbToGain(TREE_FALL_GAIN_DB);

    const rustle = ctx.createBufferSource();
    rustle.buffer = this.noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 950;
    band.Q.value = 0.7;
    const rustleGain = ctx.createGain();
    rustleGain.gain.setValueAtTime(0, now);
    rustleGain.gain.linearRampToValueAtTime(gainLin, now + 0.015);
    rustleGain.gain.exponentialRampToValueAtTime(0.0001, now + TREE_FALL_DUR);
    rustle.connect(band);
    band.connect(rustleGain);
    rustleGain.connect(sfxBus);
    rustle.start(now);
    rustle.stop(now + TREE_FALL_DUR + 0.02);

    const knock = ctx.createOscillator();
    knock.type = 'sine';
    knock.frequency.setValueAtTime(95, now);
    knock.frequency.exponentialRampToValueAtTime(60, now + 0.08);
    const knockGain = ctx.createGain();
    knockGain.gain.setValueAtTime(0, now);
    knockGain.gain.linearRampToValueAtTime(gainLin * 0.6, now + 0.008);
    knockGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    knock.connect(knockGain);
    knockGain.connect(sfxBus);
    knock.start(now);
    knock.stop(now + 0.11);

    rustle.onended = () => {
      rustle.disconnect();
      band.disconnect();
      rustleGain.disconnect();
      knock.disconnect();
      knockGain.disconnect();
    };
  }

  private isNightFromTimeOfDay(timeOfDay: number): boolean {
    // Matches Atmosphere's sunElevation(t) = sin(2*pi*(t-0.25)) < 0 band, without needing a
    // direct dependency on Atmosphere — negative elevation is night.
    const elevation = Math.sin(2 * Math.PI * (timeOfDay - 0.25));
    return elevation < 0;
  }

  /** Advances the shared chord-root cycle. Formerly this also crossfaded a sustained pad bed
   * between roots; the pad is gone (see CHORD_ROOTS_HZ's comment) but the clock stays so the
   * pluck layer keeps wandering through the progression. */
  private updateChordProgression(dt: number): void {
    this.chordTimer += dt;
    if (this.chordTimer >= CHORD_PERIOD) {
      this.chordTimer -= CHORD_PERIOD;
      this.chordIdx = (this.chordIdx + 1) % CHORD_ROOTS_HZ.length;
    }
  }

  /** Current chord root in Hz — the pluck layer always arpeggiates over the current root of the
   * shared progression. */
  private currentChordRootHz(): number {
    return CHORD_ROOTS_HZ[this.chordIdx];
  }

  /** Sparse generative arpeggio: every PLUCK_MIN..MAX_INTERVAL seconds (rng-jittered, roughly
   * halved at night), schedules a short 3-6 note run (or, 20% of the time, a single longer "bell"
   * note) drawn from the current chord's pentatonic scale across octaves 3-5. Day/night differs in
   * rate, register, and level per the spec (night: half rate, one octave down, -6dB). */
  private updatePluck(dt: number, night: boolean): void {
    if (!this.ctx || !this.pluckBus) return;
    this.pluckTimer += dt;
    if (this.pluckTimer < this.pluckNextInterval) return;

    this.pluckTimer = 0;
    const [minI, maxI] = night
      ? [PLUCK_MIN_INTERVAL_NIGHT, PLUCK_MAX_INTERVAL_NIGHT]
      : [PLUCK_MIN_INTERVAL_DAY, PLUCK_MAX_INTERVAL_DAY];
    this.pluckNextInterval = minI + Math.random() * (maxI - minI);

    if (Math.random() < PLUCK_BELL_CHANCE) {
      this.playBellNote(night);
    } else {
      this.playPluckArpeggio(night);
    }
  }

  /** Picks a scale-degree frequency for the current chord root at the given octave offset from
   * octave 4 (0 = octave the root's own PAD_ROOTS_HZ value already sits in). `octave` is absolute
   * (3, 4, or 5); root frequencies in PAD_ROOTS_HZ already sit around octave 2-3, so we treat that
   * as the scale's octave 3 for note-picking purposes and multiply up from there. */
  private pluckNoteHz(octave: number, stepIdx: number): number {
    const root = this.currentChordRootHz();
    const len = PLUCK_SCALE_STEPS.length;
    // stepIdx walks up or down (playPluckArpeggio's `direction` can be -1), so a plain `%` can
    // yield a negative index into PLUCK_SCALE_STEPS (JS `%` preserves the dividend's sign) — use a
    // proper positive-modulo instead.
    const wrapped = ((stepIdx % len) + len) % len;
    const semitoneOffset = PLUCK_SCALE_STEPS[wrapped];
    const octaveShift = octave - 3; // octave 3 == root's own register
    const freq = root * Math.pow(2, semitoneOffset / 12) * Math.pow(2, octaveShift);
    return freq;
  }

  private playPluckArpeggio(night: boolean): void {
    const ctx = this.ctx;
    const pluckBus = this.pluckBus;
    if (!ctx || !pluckBus) return;

    const noteCount = PLUCK_NOTES_MIN + Math.floor(Math.random() * (PLUCK_NOTES_MAX - PLUCK_NOTES_MIN + 1));
    const now = ctx.currentTime;
    const gainDbOffset = night ? PLUCK_NIGHT_GAIN_DB_OFFSET : 0;
    const baseGain = dbToGain(gainDbOffset); // relative to pluckBus's own fixed -16dB mix level

    let t = now;
    // Walk the pentatonic scale in a random direction/starting point rather than pure random picks
    // per note, so the run reads as a little melodic phrase rather than scattershot.
    let stepIdx = Math.floor(Math.random() * PLUCK_SCALE_STEPS.length);
    const direction = Math.random() < 0.5 ? 1 : -1;

    for (let i = 0; i < noteCount; i++) {
      let octave = PLUCK_OCTAVE_MIN + Math.floor(Math.random() * (PLUCK_OCTAVE_MAX - PLUCK_OCTAVE_MIN + 1));
      if (night) octave = Math.max(PLUCK_OCTAVE_MIN, octave - 1); // one octave down at night
      const freq = this.pluckNoteHz(octave, stepIdx);
      stepIdx += direction;

      const velocity = 1 + (Math.random() * 2 - 1) * PLUCK_VELOCITY_JITTER;
      const decay = PLUCK_DECAY_MIN + Math.random() * (PLUCK_DECAY_MAX - PLUCK_DECAY_MIN);
      this.schedulePluckNote(pluckBus, t, freq, baseGain * velocity, decay);

      t += PLUCK_NOTE_SPACING_MIN + Math.random() * (PLUCK_NOTE_SPACING_MAX - PLUCK_NOTE_SPACING_MIN);
    }
  }

  /** One kalimba/pluck voice: triangle osc through a bandpass "body" filter with a fast exponential
   * decay envelope. Self-contained one-shot — disconnects everything onended, following the same
   * pattern as playBirdChirp/playStageBlip. */
  private schedulePluckNote(destination: AudioNode, startAt: number, freq: number, gainMult: number, decay: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = freq * 2.5;
    bandpass.Q.value = 1.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(gainMult, startAt + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);

    osc.connect(bandpass);
    bandpass.connect(g);
    g.connect(destination);
    osc.start(startAt);
    osc.stop(startAt + decay + 0.05);
    osc.onended = () => {
      osc.disconnect();
      bandpass.disconnect();
      g.disconnect();
    };
  }

  /** Occasional (20%) single "bell" note in place of an arpeggio run: sine + quiet 2nd harmonic,
   * longer decay for a chime-like sustain. */
  private playBellNote(night: boolean): void {
    const ctx = this.ctx;
    const pluckBus = this.pluckBus;
    if (!ctx || !pluckBus) return;

    const now = ctx.currentTime;
    let octave = PLUCK_OCTAVE_MIN + Math.floor(Math.random() * (PLUCK_OCTAVE_MAX - PLUCK_OCTAVE_MIN + 1));
    if (night) octave = Math.max(PLUCK_OCTAVE_MIN, octave - 1);
    const stepIdx = Math.floor(Math.random() * PLUCK_SCALE_STEPS.length);
    const freq = this.pluckNoteHz(octave, stepIdx);

    const gainDbOffset = night ? PLUCK_NIGHT_GAIN_DB_OFFSET : 0;
    const velocity = 1 + (Math.random() * 2 - 1) * PLUCK_VELOCITY_JITTER;
    const baseGain = dbToGain(gainDbOffset) * velocity;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(baseGain, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + PLUCK_BELL_DECAY);
    g.connect(pluckBus);

    const fund = ctx.createOscillator();
    fund.type = 'sine';
    fund.frequency.value = freq;
    fund.connect(g);

    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.3; // quiet 2nd harmonic for a touch of bell-like shimmer
    const harmonic = ctx.createOscillator();
    harmonic.type = 'sine';
    harmonic.frequency.value = freq * 2;
    harmonic.connect(harmonicGain);
    harmonicGain.connect(g);

    fund.start(now);
    harmonic.start(now);
    fund.stop(now + PLUCK_BELL_DECAY + 0.1);
    harmonic.stop(now + PLUCK_BELL_DECAY + 0.1);
    fund.onended = () => {
      fund.disconnect();
      g.disconnect();
    };
    harmonic.onended = () => {
      harmonic.disconnect();
      harmonicGain.disconnect();
    };
  }

  /** Slow-attack/release easing of the day-only shimmer layer's gain and frequency (tracks the
   * current chord root), mirroring the pad filter's easing approach. */
  private updateBirdsAndCrickets(dt: number, night: boolean): void {
    if (!this.ctx || !this.sfxBus) return;

    if (!night) {
      this.birdTimer += dt;
      if (this.birdTimer >= this.birdNextInterval) {
        this.birdTimer = 0;
        this.birdNextInterval = BIRD_MIN_INTERVAL + Math.random() * (BIRD_MAX_INTERVAL - BIRD_MIN_INTERVAL);
        this.playBirdChirp();
      }
    } else {
      this.birdTimer = 0;
    }

    if (night) {
      if (this.cricketBurstRemaining > 0) {
        this.cricketBurstRemaining -= dt;
        this.advanceCricketPulses(dt);
      } else {
        this.cricketTimer += dt;
        if (this.cricketTimer >= this.cricketNextInterval) {
          this.cricketTimer = 0;
          this.cricketNextInterval = CRICKET_MIN_INTERVAL + Math.random() * (CRICKET_MAX_INTERVAL - CRICKET_MIN_INTERVAL);
          this.cricketBurstRemaining = CRICKET_BURST_MIN + Math.random() * (CRICKET_BURST_MAX - CRICKET_BURST_MIN);
          this.cricketPulsePhase = 0;
        }
      }
    } else {
      this.cricketTimer = 0;
      this.cricketBurstRemaining = 0;
    }
  }

  private playBirdChirp(): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus) return;

    const blipCount = BIRD_BLIP_MIN + Math.floor(Math.random() * (BIRD_BLIP_MAX - BIRD_BLIP_MIN + 1));
    const now = ctx.currentTime;
    const pan = (Math.random() * 2 - 1) * 0.8;
    const gainLin = dbToGain(BIRD_GAIN_DB);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(sfxBus);

    let t = now;
    for (let i = 0; i < blipCount; i++) {
      const startFreq = BIRD_FREQ_MIN + Math.random() * (BIRD_FREQ_MAX - BIRD_FREQ_MIN);
      const glideFreq = BIRD_FREQ_MIN + Math.random() * (BIRD_FREQ_MAX - BIRD_FREQ_MIN);
      const dur = 0.04 + Math.random() * 0.05;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, t);
      osc.frequency.linearRampToValueAtTime(glideFreq, t + dur);

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = (startFreq + glideFreq) / 2;
      bandpass.Q.value = 4;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gainLin, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(bandpass);
      bandpass.connect(g);
      g.connect(panner);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      osc.onended = () => {
        osc.disconnect();
        bandpass.disconnect();
        g.disconnect();
      };

      t += dur + 0.02 + Math.random() * 0.03;
    }

    // Detach the shared panner once the last blip has finished.
    const totalDur = t - now + 0.05;
    window.setTimeout(() => panner.disconnect(), Math.min(totalDur, 2) * 1000 + 50);
  }

  /** Cricket ticks: pulsed filtered-noise bursts at ~12Hz for the duration of the current burst.
   * Scheduled per-update via a phase accumulator rather than setInterval. */
  private advanceCricketPulses(dt: number): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    this.cricketPulsePhase += dt * CRICKET_PULSE_HZ;
    while (this.cricketPulsePhase >= 1) {
      this.cricketPulsePhase -= 1;
      this.playCricketTick();
    }
  }

  private playCricketTick(): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = CRICKET_FREQ;
    bandpass.Q.value = 8;

    const panner = ctx.createStereoPanner();
    panner.pan.value = (Math.random() * 2 - 1) * 0.5;

    const g = ctx.createGain();
    const gainLin = dbToGain(CRICKET_GAIN_DB);
    const dur = 0.02;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainLin, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    source.connect(bandpass);
    bandpass.connect(g);
    g.connect(panner);
    panner.connect(sfxBus);
    source.start(now);
    source.stop(now + dur + 0.01);
    source.onended = () => {
      source.disconnect();
      bandpass.disconnect();
      g.disconnect();
      panner.disconnect();
    };
  }

  /**
   * Task 25: with up to MAX_CREWS crews potentially active at once, picks whichever crew is
   * currently BOTH active (reported progress within CREW_ACTIVE_RELEASE) AND nearest to the
   * camera on the x axis, and returns its position/demolish flag — the single shared beeper voice
   * follows that one crew, panning toward whichever is closest rather than trying to layer
   * multiple sounds (kept simple per the binding spec's one-voice ruling). Returns null if no
   * crew is currently active.
   *
   * T25 review fix: recomputing the nearest crew from scratch every frame with no hysteresis meant
   * a camera parked equidistant between two crews would flip the followed crew (and its pan)
   * frame-to-frame. Now we stick with `this.followedCrew` unless it's gone idle or a competitor is
   * meaningfully closer (by more than `CREW_SWITCH_MARGIN`), so the choice only changes when it's
   * clearly warranted.
   */
  private nearestActiveCrew(cameraX: number): { x: number; demolish: boolean } | null {
    let bestCrew: number | null = null;
    let bestEntry: { x: number; demolish: boolean } | null = null;
    let bestDist = Infinity;
    let followedDist = Infinity;
    let followedEntry: { x: number; demolish: boolean } | null = null;

    for (const [crew, { at, x, demolish }] of this.crewProgress.entries()) {
      if (this.clockTime - at >= CREW_ACTIVE_RELEASE) continue; // this crew's gone idle
      const dist = Math.abs(x - cameraX);
      if (dist < bestDist) {
        bestDist = dist;
        bestCrew = crew;
        bestEntry = { x, demolish };
      }
      if (crew === this.followedCrew) {
        followedDist = dist;
        followedEntry = { x, demolish };
      }
    }

    if (followedEntry !== null && bestDist >= followedDist - CREW_SWITCH_MARGIN) {
      // Currently-followed crew is still active and no competitor is meaningfully closer — keep it.
      return followedEntry;
    }

    // Either the followed crew went idle, or a competitor beat it by more than the margin: switch.
    this.followedCrew = bestCrew;
    return bestEntry;
  }

  private updateConstruction(dt: number, cameraX: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.beeperGain || !this.beeperPanner) return;

    const now = ctx.currentTime;
    const nearest = this.nearestActiveCrew(cameraX);
    const active = nearest !== null;

    if (active) {
      // Damped per-frame ease toward the target pan rather than a bare setValueAtTime snap —
      // otherwise a followed-crew switch (or even normal camera motion) causes an audible
      // stereo-image jump.
      const targetPan = clamp((nearest.x - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);
      this.panCurrent += (targetPan - this.panCurrent) * Math.min(1, dt / PAN_EASE_TAU);
      this.beeperPanner.pan.cancelScheduledValues(now);
      this.beeperPanner.pan.setValueAtTime(this.panCurrent, now);
    }

    // Reverse beeper: square-wave duty-cycle gate, only while the nearest active crew's job is a
    // demolish job.
    const beeperActive = active && nearest.demolish;
    if (beeperActive) {
      this.beeperPhase += dt * BEEPER_HZ;
      if (this.beeperPhase >= 1) this.beeperPhase -= Math.floor(this.beeperPhase);
      const shouldBeOn = this.beeperPhase < BEEPER_DUTY;
      if (shouldBeOn !== this.beeperOn) {
        this.beeperOn = shouldBeOn;
        const target = shouldBeOn ? dbToGain(BEEPER_GAIN_DB) : 0;
        this.beeperGain.gain.cancelScheduledValues(now);
        this.beeperGain.gain.setValueAtTime(this.beeperGain.gain.value, now);
        this.beeperGain.gain.linearRampToValueAtTime(target, now + 0.01);
      }
    } else if (this.beeperOn || this.beeperGain.gain.value > 0.0001) {
      this.beeperOn = false;
      this.beeperPhase = 0;
      this.beeperGain.gain.cancelScheduledValues(now);
      this.beeperGain.gain.setValueAtTime(this.beeperGain.gain.value, now);
      this.beeperGain.gain.linearRampToValueAtTime(0, now + 0.05);
    }
  }

  /**
   * Radio chatter (Task 26): every RADIO_MIN..MAX_INTERVAL seconds (rolled independently per crew),
   * schedules a short 2-4 blip burst of filtered noise through a bandpass — a walkie-talkie-ish
   * texture rather than anything melodic — for each currently-active crew, panned to that crew's own
   * position. Crews that go idle simply stop accumulating toward their next blip (their timer holds,
   * doesn't reset) and resume rolling once they're active again, same idle-handling style as the
   * pluck/bird schedulers elsewhere in this file.
   */
  private updateRadioChatter(dt: number, cameraX: number): void {
    if (!this.ctx || !this.sfxBus) return;

    for (const [crew, { at, x }] of this.crewProgress.entries()) {
      const active = this.clockTime - at <= CREW_ACTIVE_RELEASE;
      if (!active) continue;

      const timer = (this.radioTimer.get(crew) ?? 0) + dt;
      const nextInterval = this.radioNextInterval.get(crew) ?? (RADIO_MIN_INTERVAL + Math.random() * (RADIO_MAX_INTERVAL - RADIO_MIN_INTERVAL));
      if (timer < nextInterval) {
        this.radioTimer.set(crew, timer);
        continue;
      }

      this.radioTimer.set(crew, 0);
      this.radioNextInterval.set(crew, RADIO_MIN_INTERVAL + Math.random() * (RADIO_MAX_INTERVAL - RADIO_MIN_INTERVAL));
      this.playRadioBurst(x, cameraX);
    }
  }

  /** One radio-chatter burst: 2-4 short filtered-noise blips through a bandpass, panned to the
   * crew's world position relative to the camera. Self-contained one-shot, disconnects onended. */
  private playRadioBurst(crewX: number, cameraX: number): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    const pan = clamp((crewX - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(sfxBus);

    const blipCount = RADIO_BLIP_MIN + Math.floor(Math.random() * (RADIO_BLIP_MAX - RADIO_BLIP_MIN + 1));
    const gainLin = dbToGain(RADIO_GAIN_DB);
    let t = ctx.currentTime;

    for (let i = 0; i < blipCount; i++) {
      const dur = RADIO_BLIP_DUR_MIN + Math.random() * (RADIO_BLIP_DUR_MAX - RADIO_BLIP_DUR_MIN);
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = RADIO_FILTER_FREQ * (0.85 + Math.random() * 0.3);
      bandpass.Q.value = RADIO_FILTER_Q;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gainLin, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      source.connect(bandpass);
      bandpass.connect(g);
      g.connect(panner);
      source.start(t);
      source.stop(t + dur + 0.01);
      source.onended = () => {
        source.disconnect();
        bandpass.disconnect();
        g.disconnect();
      };

      t += dur + 0.02 + Math.random() * 0.05;
    }

    const totalDur = t - ctx.currentTime + 0.05;
    window.setTimeout(() => panner.disconnect(), Math.min(totalDur, 2) * 1000 + 50);
  }

  /** Drains any grader-scrape requests queued by the DOM CustomEvent listener (see constructor)
   * since the last frame, playing one one-shot per queued request. Queueing (rather than playing
   * directly in the event handler) keeps every audio node creation on the same per-frame `update()`
   * cadence as the rest of this class, and lets `cameraX` (only available here) drive the pan. */
  private drainGraderScrapes(cameraX: number): void {
    if (this.pendingScrapes.length === 0) return;
    const xs = this.pendingScrapes;
    this.pendingScrapes = [];
    for (const x of xs) this.playScrapeOneShot(x, cameraX);
  }

  /** Soft scrape one-shot tied to a grader pass (deliverable 6): filtered noise burst with a quick
   * attack and a longer, softer decay than the radio blips — reads as a blade dragging rather than a
   * chirp. Self-contained, disconnects onended (same lifecycle as every other one-shot here). */
  private playScrapeOneShot(graderX: number, cameraX: number): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const pan = clamp((graderX - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = SCRAPE_FILTER_FREQ;
    bandpass.Q.value = 0.8;

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    const g = ctx.createGain();
    const gainLin = dbToGain(SCRAPE_GAIN_DB);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainLin, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + SCRAPE_DUR);

    source.connect(bandpass);
    bandpass.connect(g);
    g.connect(panner);
    panner.connect(sfxBus);
    source.start(now);
    source.stop(now + SCRAPE_DUR + 0.02);
    source.onended = () => {
      source.disconnect();
      bandpass.disconnect();
      g.disconnect();
      panner.disconnect();
    };
  }
}

/** One of two reusable playback slots `MusicPlayer` crossfades between: a real `<audio>` element
 * (so the browser handles network fetch/decode/buffering itself, rather than us downloading whole
 * files via fetch()+decodeAudioData up front) wrapped in a `MediaElementAudioSourceNode`, feeding a
 * per-slot gain node used purely for the crossfade envelope. A `MediaElementAudioSourceNode` is
 * permanently bound to the element it was created from, but the element's `src` can be swapped
 * freely — so each slot's element/source/gain trio is built once and reused for every track that
 * plays in that slot for the life of the page. */
interface TrackSlot {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

type MusicPlayerPhase = 'idle' | 'loading' | 'playing' | 'crossfading';

/**
 * Task 39: slow rotation of a handful of real, pre-recorded ambient tracks (see
 * public/music/LICENSE.txt), one at a time, with a long equal-power crossfade between tracks and a
 * generous silence gap after each one — deliberately not wall-to-wall music, since silence is part
 * of this game's design. Lazy: does nothing until `beginLoading()` is called (by `AmbientAudio`,
 * itself delayed a few seconds past the first user gesture). Any track that fails to load or play
 * is simply skipped — never surfaced, never retried in a tight loop.
 *
 * Playback order is shuffled once at construction (Fisher-Yates) rather than looping the source
 * array in place, so repeat sessions don't always open on the same track; the rotation still cycles
 * indefinitely once it reaches the end.
 */
class MusicPlayer {
  private slots: [TrackSlot, TrackSlot];
  private activeSlot = 0;
  private phase: MusicPlayerPhase = 'idle';
  private order: number[];
  private orderIdx = 0;
  private loadedAny = false;
  private started = false;
  private gapTimer: ReturnType<typeof window.setTimeout> | null = null;
  /** Wall-clock deadline (`performance.now()`-style ms) at which the currently-playing track should
   * start crossfading to the next one — set once metadata/duration is known, so we can start the
   * crossfade `TRACK_CROSSFADE` seconds before the track actually ends rather than waiting for an
   * `ended` event (which would clip the outgoing tail with no gap for the fade). */
  private crossfadeAt: number | null = null;
  private endedFallbackAt: number | null = null; // safety net if duration never resolves
  /** Groundwork batch-review Finding 2(c): set once by `dispose()`, checked at the top of every
   * callback that could otherwise re-arm playback (load watchdog, canplaythrough/error listeners,
   * the `el.play()` rejection handler, and the gap timer) — a disposed player must never start a
   * new load, crossfade, or schedule another retry/gap timer, even if one of those callbacks was
   * already in flight (e.g. a network response arriving) at the moment `dispose()` ran. */
  private disposed = false;
  /** Groundwork batch-review Finding 2(b): consecutive PLAYNEXT ATTEMPTS (not tracks — see
   * `beginLoading`/`playNext`) that have failed since the last successful play, used to detect
   * "every track in the rotation has failed MUSIC_MAX_FAILED_CYCLES times in a row" without
   * tracking per-track state — simply counting attempts and dividing by rotation length is
   * equivalent since `playNext` always advances `orderIdx` first. Reset to 0 on any success. */
  private consecutiveFailures = 0;
  private watchdogTimer: ReturnType<typeof window.setTimeout> | null = null;

  constructor(private ctx: AudioContext, private destination: AudioNode) {
    this.slots = [this.makeSlot(), this.makeSlot()];
    this.order = MusicPlayer.shuffledIndices(MUSIC_TRACKS.length);
  }

  private makeSlot(): TrackSlot {
    const el = new Audio();
    el.preload = 'none';
    el.loop = false;
    el.crossOrigin = 'anonymous';
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(this.destination);
    return { el, source, gain };
  }

  private static shuffledIndices(n: number): number[] {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** True once at least one track has successfully started playing at any point this session —
   * sticky (never reverts to false once true), so the pad fallback doesn't flicker back on during
   * this player's own deliberate silence gaps between tracks. */
  hasLoadedTrack(): boolean {
    return this.loadedAny;
  }

  /** Kicks off the rotation. Safe to call only once — `AmbientAudio` guards this via its own
   * setTimeout, but guard here too since `beginLoading` isn't otherwise idempotent-safe (it would
   * restart the rotation from the top). */
  beginLoading(): void {
    if (this.started) return;
    this.started = true;
    this.playNext();
  }

  private currentTrack(): { file: string; title: string } {
    return MUSIC_TRACKS[this.order[this.orderIdx]];
  }

  private advanceOrder(): void {
    this.orderIdx = (this.orderIdx + 1) % this.order.length;
  }

  /** Loads and plays the next track in `order` into the inactive slot, then swaps `activeSlot` and
   * fades it in. On any load/playback failure, skips straight to the track after that (still
   * respecting the gap) rather than surfacing an error or retrying the same file in a hot loop.
   * "Inactive slot" on the very first call (before anything has ever played) is just `slots[1]` —
   * both slots start silent, so either would do, but staying consistent with the later
   * always-the-other-one rule keeps this simple.
   *
   * Groundwork batch-review Finding 2: guarded at the top by `disposed` (2c) and by
   * `consecutiveFailures` having already crossed `MUSIC_MAX_FAILED_CYCLES` full rotations (2b) —
   * either stops the rotation outright rather than looping forever. A per-load watchdog timer (2a)
   * treats a load that never fires `canplaythrough`/`error` (a stalled fetch) as a failure via the
   * exact same `onFailure` path, so `phase` can never wedge in 'loading' indefinitely.
   */
  private playNext(): void {
    if (this.disposed) return;
    if (MUSIC_TRACKS.length === 0) return;
    if (this.consecutiveFailures >= MUSIC_MAX_FAILED_CYCLES * MUSIC_TRACKS.length) {
      // Finding 2(b): given up retrying for the session — the pad fallback (hasLoadedTrack() is
      // false in this all-failed scenario, same as it always would be) keeps covering for it.
      this.phase = 'idle';
      return;
    }

    const nextSlotIdx = this.activeSlot === 0 ? 1 : 0;
    const slot = this.slots[nextSlotIdx];
    const track = this.currentTrack();
    this.advanceOrder();

    this.phase = 'loading';
    const el = slot.el;

    const onFailure = () => {
      if (this.disposed) return;
      cleanup();
      this.consecutiveFailures++;
      // Skip this track; try the next one after a short beat rather than hammering the network in
      // a tight loop if e.g. the whole music/ directory 404s. playNext()'s own guard above is what
      // actually stops the loop once MUSIC_MAX_FAILED_CYCLES rotations have all failed.
      this.phase = 'idle';
      this.gapTimer = window.setTimeout(() => this.playNext(), 2000);
    };
    const onReady = () => {
      if (this.disposed) return;
      cleanup();
      this.consecutiveFailures = 0;
      this.fadeInSlot(nextSlotIdx);
    };
    const cleanup = () => {
      el.removeEventListener('canplaythrough', onReady);
      el.removeEventListener('error', onFailure);
      if (this.watchdogTimer !== null) {
        window.clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
    };

    el.addEventListener('canplaythrough', onReady, { once: true });
    el.addEventListener('error', onFailure, { once: true });
    // Finding 2(a): a stalled load (neither event ever fires) would otherwise wedge `phase` in
    // 'loading' forever — treat a timeout exactly like a load failure via the same onFailure path.
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      onFailure();
    }, TRACK_LOAD_WATCHDOG_MS);
    el.preload = 'auto';
    el.src = MUSIC_BASE_URL + track.file;
    el.load();
  }

  /** Starts playback of the now-loaded slot and equal-power-crossfades it in over TRACK_CROSSFADE
   * seconds (against whatever was previously active, if anything — the very first track just fades
   * up from silence since the "outgoing" slot is already at 0 gain). */
  private fadeInSlot(slotIdx: number): void {
    const ctx = this.ctx;
    const incoming = this.slots[slotIdx];
    const outgoing = this.slots[slotIdx === 0 ? 1 : 0];

    const playResult = incoming.el.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {
        // Groundwork batch-review Finding 2(c): this promise settles asynchronously and can resolve
        // after dispose() has already torn the player down — never re-arm a retry in that case.
        if (this.disposed) return;
        // Autoplay/decoding rejection this late (post-gesture, post-delay) is rare but not
        // impossible (e.g. a mid-session permission change) — treat exactly like a load failure.
        this.consecutiveFailures++;
        this.phase = 'idle';
        this.gapTimer = window.setTimeout(() => this.playNext(), 2000);
      });
    }

    this.loadedAny = true;
    this.activeSlot = slotIdx;
    this.phase = 'crossfading';

    // Equal-power crossfade: outgoing eases from its current level (TRACK_GAIN if a previous track
    // was playing, 0 if this is the very first track) down to 0, while incoming eases from 0 up to
    // TRACK_GAIN, over TRACK_CROSSFADE seconds.
    const now = ctx.currentTime;
    const steps = 30;
    const outStart = outgoing.gain.gain.value;
    outgoing.gain.gain.cancelScheduledValues(now);
    incoming.gain.gain.cancelScheduledValues(now);
    outgoing.gain.gain.setValueAtTime(outStart, now);
    incoming.gain.gain.setValueAtTime(0, now);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const at = now + t * TRACK_CROSSFADE;
      outgoing.gain.gain.linearRampToValueAtTime(outStart * Math.cos(t * 0.5 * Math.PI), at);
      incoming.gain.gain.linearRampToValueAtTime(TRACK_GAIN * Math.sin(t * 0.5 * Math.PI), at);
    }

    window.setTimeout(() => {
      // Finding 2(c): dispose() already pauses/clears both slots synchronously — avoid touching
      // them again here (and avoid resurrecting `phase` out of dispose()'s terminal state) if this
      // timer fires after teardown.
      if (this.disposed) return;
      outgoing.el.pause();
      outgoing.el.removeAttribute('src');
      outgoing.el.load();
      if (this.phase === 'crossfading') this.phase = 'playing';
    }, TRACK_CROSSFADE * 1000 + 50);

    // Schedule the next crossfade to start TRACK_CROSSFADE seconds before this track's own natural
    // end (once duration is known), so the outgoing fade completes right as playback would end
    // rather than clipping the tail. Duration is sometimes available immediately (cached/preloaded
    // metadata) and sometimes only after `loadedmetadata`.
    const scheduleFromDuration = () => {
      const dur = incoming.el.duration;
      if (!isFinite(dur) || dur <= 0) return;
      const msUntilCrossfade = Math.max(1000, (dur - TRACK_CROSSFADE) * 1000);
      this.crossfadeAt = performance.now() + msUntilCrossfade;
      this.endedFallbackAt = performance.now() + dur * 1000 + 500;
    };
    if (isFinite(incoming.el.duration) && incoming.el.duration > 0) {
      scheduleFromDuration();
    } else {
      incoming.el.addEventListener('loadedmetadata', scheduleFromDuration, { once: true });
    }
  }

  /** Per-frame poll (called from AmbientAudio.update()) — cheap wall-clock deadline checks only, no
   * per-sample work. Starts the gap once the active track's scheduled crossfade point passes, or —
   * as a safety net, via `endedFallbackAt` — once the track's estimated natural end passes with no
   * crossfade ever having been scheduled (duration never resolved, e.g. a `loadedmetadata` that
   * never fired), so a track can't loop forever silently rather than rotating. */
  update(): void {
    if (this.disposed) return; // Finding 2(c): a disposed player must never schedule a new gap/retry
    if (this.phase !== 'playing') return;
    const now = performance.now();
    if (this.crossfadeAt !== null && now >= this.crossfadeAt) {
      this.crossfadeAt = null;
      this.endedFallbackAt = null;
      this.beginGap();
    } else if (this.crossfadeAt === null && this.endedFallbackAt !== null && now >= this.endedFallbackAt) {
      this.endedFallbackAt = null;
      this.beginGap();
    }
  }

  /** Silence gap (TRACK_GAP_MIN..MAX seconds) between one track ending and the next one starting —
   * this pause is deliberate: a zen game doesn't need wall-to-wall music. */
  private beginGap(): void {
    this.phase = 'idle';
    const gap = (TRACK_GAP_MIN + Math.random() * (TRACK_GAP_MAX - TRACK_GAP_MIN)) * 1000;
    this.gapTimer = window.setTimeout(() => this.playNext(), gap);
  }

  /** Cancels any pending gap/retry/watchdog timer and pauses both slots — mirrors AmbientAudio's
   * own dispose() pattern. Called from AmbientAudio.dispose() when tearing down the whole audio
   * system.
   *
   * Groundwork batch-review Finding 2(c): sets `disposed` FIRST, before touching timers/elements —
   * every other method in this class checks `disposed` at its own top, so once this flag flips, no
   * in-flight callback (a load's canplaythrough/error, the load watchdog, a play() rejection, a gap
   * timer, or update()'s own polling) can re-arm playback or schedule another timer, even if one of
   * those callbacks was already queued (e.g. a network response landing) at the moment this ran. */
  dispose(): void {
    this.disposed = true;
    if (this.gapTimer !== null) window.clearTimeout(this.gapTimer);
    this.gapTimer = null;
    if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const slot of this.slots) {
      slot.el.pause();
      slot.el.removeAttribute('src');
    }
  }
}
