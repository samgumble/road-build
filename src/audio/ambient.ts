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
const PAD_FILTER_NIGHT = 400;
const PAD_FILTER_DAY = 1400;
const PAD_FILTER_EASE_TIME = 10; // seconds to fully ease across the night/day cutoff swing
const PAD_TREMOLO_HZ = 0.08;
const PAD_TREMOLO_DEPTH = 0.15; // +-15%
const PAD_DETUNE_CENTS = 7; // detune between the two triangle voices
const PAD_VOICE_GAIN = 0.5; // per voice-pair gain (two pairs alternate, only one fully audible at a time)

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

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** One alternating voice-pair slot for the pad (two detuned triangles + sub sine), so chord
 * changes can crossfade between the outgoing and incoming root without clicks. */
interface PadVoice {
  gain: GainNode;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
}

/**
 * Generative ambient audio: a slowly shifting pentatonic pad bed, day/night birds and crickets,
 * and construction sfx (engine rumble, stage-complete blips, demolish reverse-beeper). Everything
 * is synthesized — no audio files. Built lazily via `start()` on first user gesture (autoplay
 * policy); until then no `AudioContext` or nodes exist.
 *
 * All one-shot and looping scheduling is driven by `ctx.currentTime` lookahead scheduling inside
 * `update()`, which is called once per render frame — there is no `setInterval` anywhere in this
 * class. Continuous sound sources (pad voices, engine rumble, cricket burst noise) are created
 * once in `start()`/on first gate-open and reused; only true one-shots (bird chirps, blips, beeper
 * pulses) allocate and discard nodes.
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

  // Birds / crickets
  private birdTimer = 0;
  private birdNextInterval = BIRD_MIN_INTERVAL;
  private cricketTimer = 0;
  private cricketNextInterval = CRICKET_MIN_INTERVAL;
  private cricketBurstRemaining = 0;
  private cricketPulsePhase = 0;

  // Construction
  private engineGain: GainNode | null = null;
  private enginePanner: StereoPannerNode | null = null;
  private lastProgressAt = -Infinity;
  private lastProgressPanX = 0;
  private lastProgressDemolish = false;
  private clockTime = 0; // ctx.currentTime substitute tracked via update(dt), used for gating

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

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.connect(gain);

    const root = PAD_ROOTS_HZ[0];
    oscA.frequency.value = root;
    oscB.frequency.value = root;
    sub.frequency.value = root / 2;

    oscA.start();
    oscB.start();
    sub.start();

    return { gain, oscA, oscB, sub };
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

  private onConstructionProgress(payload: { pos: { x: number }; demolish: boolean }): void {
    this.lastProgressAt = this.clockTime;
    this.lastProgressDemolish = payload.demolish;
    this.lastProgressPanX = payload.pos.x;
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
    incoming.sub.frequency.setValueAtTime(nextRoot / 2, now);

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

  private updateConstruction(dt: number, cameraX: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.enginePanner || !this.beeperGain || !this.beeperPanner) return;

    const now = ctx.currentTime;
    const recency = this.clockTime - this.lastProgressAt;
    const active = recency < ENGINE_GATE_RELEASE;

    const targetGain = active ? dbToGain(ENGINE_GAIN_DB) : 0;
    const cur = this.engineGain.gain.value;
    const rate = dt / 0.4; // ~0.4s gate ease
    const nextGain = cur + (targetGain - cur) * Math.min(1, rate * 4);
    this.engineGain.gain.cancelScheduledValues(now);
    this.engineGain.gain.setValueAtTime(nextGain, now);

    if (active) {
      const pan = clamp((this.lastProgressPanX - cameraX) / PAN_DIVISOR, -PAN_CLAMP, PAN_CLAMP);
      this.enginePanner.pan.cancelScheduledValues(now);
      this.enginePanner.pan.setValueAtTime(pan, now);
      this.beeperPanner.pan.cancelScheduledValues(now);
      this.beeperPanner.pan.setValueAtTime(pan, now);
    }

    // Reverse beeper: square-wave duty-cycle gate, only while an active job is a demolish job.
    const beeperActive = active && this.lastProgressDemolish;
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
