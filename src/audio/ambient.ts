import type { EventBus } from '../core/events';

// ---- Tuning constants -------------------------------------------------

const MASTER_GAIN = 0.5;
const MUSIC_GAIN = 0.4;
const SFX_GAIN = 0.6;
const MUTE_RAMP = 0.3; // seconds

// Pad
const PAD_ROOTS_HZ = [110.0, 130.81, 146.83, 164.81, 98.0]; // A2, C3, D3, E3, G2
const PAD_CHORD_PERIOD = 24; // seconds per root
const PAD_CROSSFADE = 4; // seconds, equal-power crossfade into the next voice pair
const PAD_FILTER_NIGHT = 550; // raised from 400 so the pad never collapses into pure rumble
const PAD_FILTER_DAY = 1400;
const PAD_FILTER_EASE_TIME = 10; // seconds to fully ease across the night/day cutoff swing
const PAD_TREMOLO_HZ = 0.08;
const PAD_TREMOLO_DEPTH = 0.15; // +-15%
const PAD_DETUNE_CENTS = 7; // detune between the two triangle voices
const PAD_VOICE_GAIN = 0.5; // per voice-pair gain (two pairs alternate, only one fully audible at a time)
// Sub voice: was a sine one octave *below* the root (root/2, ~55-98Hz) at full voice gain — that
// was the reported "drone". Moved up an octave to sit *at* the root (still reinforcing the
// fundamental, not muddying below it) and cut hard so it reads as warmth, not rumble.
const PAD_SUB_RATIO = 1; // multiplier on root frequency (was 0.5 = one octave down)
const PAD_SUB_GAIN_MULT = 0.42; // fraction of PAD_VOICE_GAIN the sub voice runs at (was implicitly 1.0)

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

// Gentle high shimmer (day only)
const SHIMMER_ENABLED = true;
const SHIMMER_GAIN_DB = -28;
const SHIMMER_ATTACK = 6; // seconds, slow attack easing in with day
const SHIMMER_RATIO = 3; // octave + fifth above root (2x octave * 1.5 fifth)

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

// Construction
const ENGINE_GAIN_DB = -20;
const ENGINE_GATE_RELEASE = 1.2; // seconds of silence-from-last-progress before the rumble fully closes
const BLIP_GAIN_DB = -18;
const BEEPER_FREQ = 880;
const BEEPER_HZ = 1.2; // pulses per second
const BEEPER_GAIN_DB = -26;
const BEEPER_DUTY = 0.5;

const PAN_CLAMP = 0.7;
const PAN_DIVISOR = 120;
const CREW_SWITCH_MARGIN = 20; // units a competitor must beat the followed crew by before we switch
const PAN_EASE_TAU = 0.15; // seconds, damped-lerp time constant for rumble/beeper pan (matches engineGain's gate ease style)

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** One alternating voice-pair slot for the pad (two detuned triangles + sub sine), so chord
 * changes can crossfade between the outgoing and incoming root without clicks. The sub voice has
 * its own inner gain (scaled by PAD_SUB_GAIN_MULT) so it can sit quieter than the triangles while
 * still following the same outer crossfade envelope. */
interface PadVoice {
  gain: GainNode;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
  subGain: GainNode;
}

/**
 * Generative ambient audio: a slowly shifting pentatonic pad bed, a sparse generative kalimba/bell
 * pluck arpeggio layer (through a ping-pong feedback delay) riding over the same chord roots, an
 * optional day-only high shimmer, day/night birds and crickets, and construction sfx (engine
 * rumble, stage-complete blips, demolish reverse-beeper). Everything is synthesized — no audio
 * files. Built lazily via `start()` on first user gesture (autoplay policy); until then no
 * `AudioContext` or nodes exist.
 *
 * All one-shot and looping scheduling is driven by `ctx.currentTime` lookahead scheduling inside
 * `update()`, which is called once per render frame — there is no `setInterval` anywhere in this
 * class. Continuous sound sources (pad voices, pluck delay bus, shimmer osc, engine rumble, cricket
 * burst noise) are created once in `start()`/on first gate-open and reused; only true one-shots
 * (bird chirps, blips, beeper pulses, pluck/bell notes) allocate and discard nodes.
 */
export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;

  private _muted = false;

  // Pad
  private padVoices: [PadVoice, PadVoice] | null = null;
  private padActiveIdx = 0; // which of padVoices[] is the "current" (most recently entering) pair
  private padChordTimer = 0;
  private padChordIdx = 0;
  private padFilter: BiquadFilterNode | null = null;
  private padFilterCutoff = PAD_FILTER_DAY;

  // Pluck / arpeggio layer
  private pluckBus: GainNode | null = null;
  private pluckTimer = 0;
  private pluckNextInterval = PLUCK_MIN_INTERVAL_DAY;

  // Gentle high shimmer (day only)
  private shimmerOsc: OscillatorNode | null = null;
  private shimmerGain: GainNode | null = null;
  private shimmerLevel = 0; // eased 0..1, drives gain toward SHIMMER_GAIN_DB during day

  // Birds / crickets
  private birdTimer = 0;
  private birdNextInterval = BIRD_MIN_INTERVAL;
  private cricketTimer = 0;
  private cricketNextInterval = CRICKET_MIN_INTERVAL;
  private cricketBurstRemaining = 0;
  private cricketPulsePhase = 0;

  // Construction (Task 25: one rumble voice total, shared across every crew — see
  // `nearestActiveCrewX` — rather than one per crew, keeping this simple per the binding spec).
  private engineGain: GainNode | null = null;
  private enginePanner: StereoPannerNode | null = null;
  /** Last-seen progress per crew (0-based index, matching `construction:progress`'s `crew`
   * field): `at` is this crew's own recency clock (so one crew going idle doesn't reset another's),
   * `x`/`demolish` are that crew's most recent reported position/demolish flag. `crew: -1` (the
   * sim's synthetic "no live crew" sentinel — see queue.ts) never reaches here, since only
   * `construction:progress` feeds this map and that event is never emitted with crew -1. */
  private crewProgress: Map<number, { at: number; x: number; demolish: boolean }> = new Map();
  private clockTime = 0; // ctx.currentTime substitute tracked via update(dt), used for gating
  /** Crew index the shared rumble voice is currently "locked onto" (see `nearestActiveCrew`'s
   * hysteresis) — null when no crew has ever been picked or the followed crew went idle with no
   * replacement chosen yet. Persisting this across frames stops a camera parked equidistant
   * between two crews from flip-flopping crew identity (and the stereo image) every frame. */
  private followedCrew: number | null = null;
  /** Eased pan value shared by the rumble and beeper panners (both always mirror the same crew),
   * damped per-frame the same way `engineGain` eases its gate in `updateConstruction` rather than
   * snapping via a bare `setValueAtTime`. */
  private panCurrent = 0;

  private beeperGain: GainNode | null = null;
  private beeperPanner: StereoPannerNode | null = null;
  private beeperPhase = 0;
  private beeperOn = false;

  private noiseBuffer: AudioBuffer | null = null;

  constructor(private bus: EventBus) {
    this.bus.on('construction:stage', (payload) => this.onConstructionStage(payload));
    this.bus.on('construction:progress', (payload) => this.onConstructionProgress(payload));
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

    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_GAIN;
    musicBus.connect(master);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_GAIN;
    sfxBus.connect(master);
    this.sfxBus = sfxBus;

    this.noiseBuffer = this.buildNoiseBuffer(ctx);

    this.buildPad(ctx, musicBus);
    this.buildPluckBus(ctx, musicBus);
    if (SHIMMER_ENABLED) this.buildShimmer(ctx, musicBus);
    this.buildConstructionBed(ctx, sfxBus);

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

  private makePadVoice(ctx: AudioContext, destination: AudioNode): PadVoice {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(destination);

    const oscA = ctx.createOscillator();
    oscA.type = 'triangle';
    oscA.detune.value = -PAD_DETUNE_CENTS;
    oscA.connect(gain);

    const oscB = ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.detune.value = PAD_DETUNE_CENTS;
    oscB.connect(gain);

    // Sub voice gets its own inner gain scaled down (PAD_SUB_GAIN_MULT) so it reinforces the
    // fundamental as warmth rather than reading as a separate drone layer.
    const subGain = ctx.createGain();
    subGain.gain.value = PAD_SUB_GAIN_MULT;
    subGain.connect(gain);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.connect(subGain);

    const root = PAD_ROOTS_HZ[0];
    oscA.frequency.value = root;
    oscB.frequency.value = root;
    sub.frequency.value = root * PAD_SUB_RATIO;

    oscA.start();
    oscB.start();
    sub.start();

    return { gain, oscA, oscB, sub, subGain };
  }

  private buildPad(ctx: AudioContext, musicBus: AudioNode): void {
    // Lowpass filter shared by both voice pairs, tremolo, then the music bus.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = PAD_FILTER_DAY;
    filter.Q.value = 0.7;
    this.padFilter = filter;
    this.padFilterCutoff = PAD_FILTER_DAY;

    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 1;
    filter.connect(tremoloGain);
    tremoloGain.connect(musicBus);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = PAD_TREMOLO_HZ;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = PAD_TREMOLO_DEPTH; // scales -1..1 LFO to +-depth
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain); // AudioParam automation offsets around the base value (1)
    lfo.start();

    const voiceA = this.makePadVoice(ctx, filter);
    const voiceB = this.makePadVoice(ctx, filter);
    voiceA.gain.gain.value = PAD_VOICE_GAIN; // pair A starts fully in
    voiceB.gain.gain.value = 0;
    this.padVoices = [voiceA, voiceB];
    this.padActiveIdx = 0;
    this.padChordIdx = 0;
    this.padChordTimer = 0;
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

  /** Very quiet slow-attack sine, day-only, an octave + fifth above the current chord root, eased
   * in/out alongside the pad's own day/night filter easing. Skipped entirely if SHIMMER_ENABLED is
   * false. */
  private buildShimmer(ctx: AudioContext, musicBus: AudioNode): void {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(musicBus);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = PAD_ROOTS_HZ[0] * SHIMMER_RATIO;
    osc.connect(gain);
    osc.start();

    this.shimmerOsc = osc;
    this.shimmerGain = gain;
    this.shimmerLevel = 0;
  }

  private buildConstructionBed(ctx: AudioContext, sfxBus: AudioNode): void {
    // Engine rumble: continuous filtered-noise loop, gated by gain (never stopped/restarted —
    // avoids per-job node churn since jobs come and go frequently).
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 0.5;

    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(panner);
    panner.connect(gain);
    gain.connect(sfxBus);
    source.start();

    this.enginePanner = panner;
    this.engineGain = gain;

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

  private onConstructionStage(payload: { stage: string }): void {
    if (!this.ctx || !this.sfxBus) return;
    if (payload.stage === 'removed') return;
    this.playStageBlip();
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

    // A simple day/night split (sun elevation sign) is sufficient for birds/crickets/pad —
    // matches Atmosphere's own sunElevation(t) formula without needing a direct dependency on it.
    const night = this.isNightFromTimeOfDay(timeOfDay);

    this.updatePadFilter(dt, night);
    this.updatePadChords(dt);
    this.updatePluck(dt, night);
    this.updateShimmer(dt, night);
    this.updateBirdsAndCrickets(dt, night);
    this.updateConstruction(dt, cameraX);
  }

  private isNightFromTimeOfDay(timeOfDay: number): boolean {
    // Matches Atmosphere's sunElevation(t) = sin(2*pi*(t-0.25)) < 0 band, without needing a
    // direct dependency on Atmosphere — negative elevation is night.
    const elevation = Math.sin(2 * Math.PI * (timeOfDay - 0.25));
    return elevation < 0;
  }

  private updatePadFilter(dt: number, night: boolean): void {
    if (!this.padFilter || !this.ctx) return;
    const target = night ? PAD_FILTER_NIGHT : PAD_FILTER_DAY;
    const rate = dt / PAD_FILTER_EASE_TIME;
    const range = PAD_FILTER_DAY - PAD_FILTER_NIGHT;
    if (this.padFilterCutoff < target) {
      this.padFilterCutoff = Math.min(target, this.padFilterCutoff + range * rate);
    } else if (this.padFilterCutoff > target) {
      this.padFilterCutoff = Math.max(target, this.padFilterCutoff - range * rate);
    }
    const now = this.ctx.currentTime;
    this.padFilter.frequency.cancelScheduledValues(now);
    this.padFilter.frequency.setValueAtTime(this.padFilterCutoff, now);
  }

  private updatePadChords(dt: number): void {
    if (!this.padVoices || !this.ctx) return;
    this.padChordTimer += dt;

    if (this.padChordTimer >= PAD_CHORD_PERIOD) {
      this.padChordTimer -= PAD_CHORD_PERIOD;
      this.padChordIdx = (this.padChordIdx + 1) % PAD_ROOTS_HZ.length;
      this.crossfadeToNextChord();
    }
  }

  /** Sets the *incoming* voice pair to the next root and equal-power crossfades gain between the
   * outgoing (currently active) pair and the incoming one over PAD_CROSSFADE seconds. */
  private crossfadeToNextChord(): void {
    const ctx = this.ctx;
    const voices = this.padVoices;
    if (!ctx || !voices) return;

    const outIdx = this.padActiveIdx;
    const inIdx = outIdx === 0 ? 1 : 0;
    const outgoing = voices[outIdx];
    const incoming = voices[inIdx];

    const nextRoot = PAD_ROOTS_HZ[this.padChordIdx];
    const now = ctx.currentTime;

    incoming.oscA.frequency.setValueAtTime(nextRoot, now);
    incoming.oscB.frequency.setValueAtTime(nextRoot, now);
    incoming.sub.frequency.setValueAtTime(nextRoot * PAD_SUB_RATIO, now);

    const steps = 24;
    outgoing.gain.gain.cancelScheduledValues(now);
    incoming.gain.gain.cancelScheduledValues(now);
    outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, now);
    incoming.gain.gain.setValueAtTime(incoming.gain.gain.value, now);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const at = now + t * PAD_CROSSFADE;
      // Equal-power crossfade curve.
      const outGain = Math.cos(t * 0.5 * Math.PI) * PAD_VOICE_GAIN;
      const inGain = Math.sin(t * 0.5 * Math.PI) * PAD_VOICE_GAIN;
      outgoing.gain.gain.linearRampToValueAtTime(outGain, at);
      incoming.gain.gain.linearRampToValueAtTime(inGain, at);
    }

    this.padActiveIdx = inIdx;
  }

  /** Current chord root in Hz, reading the same state the pad scheduler already tracks — the
   * pluck layer always arpeggiates over whatever chord the pad is currently on/crossfading to. */
  private currentChordRootHz(): number {
    return PAD_ROOTS_HZ[this.padChordIdx];
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
  private updateShimmer(dt: number, night: boolean): void {
    if (!this.shimmerGain || !this.shimmerOsc || !this.ctx) return;
    const target = night ? 0 : 1;
    const rate = dt / SHIMMER_ATTACK;
    if (this.shimmerLevel < target) {
      this.shimmerLevel = Math.min(target, this.shimmerLevel + rate);
    } else if (this.shimmerLevel > target) {
      this.shimmerLevel = Math.max(target, this.shimmerLevel - rate);
    }
    const now = this.ctx.currentTime;
    const gainLin = dbToGain(SHIMMER_GAIN_DB) * this.shimmerLevel;
    this.shimmerGain.gain.cancelScheduledValues(now);
    this.shimmerGain.gain.setValueAtTime(gainLin, now);

    const targetFreq = this.currentChordRootHz() * SHIMMER_RATIO;
    this.shimmerOsc.frequency.cancelScheduledValues(now);
    this.shimmerOsc.frequency.setValueAtTime(targetFreq, now);
  }

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
   * currently BOTH active (reported progress within ENGINE_GATE_RELEASE) AND nearest to the
   * camera on the x axis, and returns its position/demolish flag — the single shared rumble voice
   * follows that one crew, panning toward whichever is loudest/closest rather than trying to
   * layer multiple engine sounds (kept simple per the binding spec: "one rumble voice, pan to the
   * loudest/nearest active crew"). Returns null if no crew is currently active.
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
      if (this.clockTime - at >= ENGINE_GATE_RELEASE) continue; // this crew's gone idle
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
    if (!ctx || !this.engineGain || !this.enginePanner || !this.beeperGain || !this.beeperPanner) return;

    const now = ctx.currentTime;
    const nearest = this.nearestActiveCrew(cameraX);
    const active = nearest !== null;

    const targetGain = active ? dbToGain(ENGINE_GAIN_DB) : 0;
    const cur = this.engineGain.gain.value;
    const rate = dt / 0.4; // ~0.4s gate ease
    const nextGain = cur + (targetGain - cur) * Math.min(1, rate * 4);
    this.engineGain.gain.cancelScheduledValues(now);
    this.engineGain.gain.setValueAtTime(nextGain, now);

    if (active) {
      // Damped per-frame ease toward the target pan (same style as engineGain's gate ease above)
      // rather than a bare setValueAtTime snap — otherwise a followed-crew switch (or even normal
      // camera motion) causes an audible stereo-image jump.
      const targetPan = clamp((nearest.x - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);
      this.panCurrent += (targetPan - this.panCurrent) * Math.min(1, dt / PAN_EASE_TAU);
      this.enginePanner.pan.cancelScheduledValues(now);
      this.enginePanner.pan.setValueAtTime(this.panCurrent, now);
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
}
