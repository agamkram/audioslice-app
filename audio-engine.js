/**
 * AudioEngine — mic → analyse + filtered monitor.
 * Band / Full gates · dual-mono out · AGC off · user gain only.
 */
(function (root) {
  "use strict";

  const MIN_HZ = 20;
  const DEFAULT_BAND_Q = 0.707;
  /** Fixed mic preamp — same on phone/Mac */
  const PREAMP_DEFAULT = 4;
  /**
   * iPad mics / Web Audio path often quieter with same headphones.
   * Boost only on iPad so phone/Mac stay as-is.
   */
  const PREAMP_IPAD = 7;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function isIPad() {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    if (/iPad/i.test(ua)) return true;
    // iPadOS 13+ can report as MacIntel with touch
    if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) {
      return true;
    }
    return false;
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.stream = null;
      this.source = null;
      this.analyser = null;
      this.inputGain = null;
      this.monitorGain = null;
      this.stereoOut = null;
      this.bandGate = null;
      this.directGate = null;
      this.bandHigh = null;
      this.bandLow = null;
      this.bandHigh2 = null;
      this.bandLow2 = null;
      this.rumbleFilter = null; // highpass when rumble cut on
      this.deHissFilter = null; // highshelf cut when de-hiss on
      this.effectSlot = null;
      this.running = false;
      this.mode = "off"; // off | band | direct
      this.bandLowHz = 210; // default focus ~420 Hz geometric center
      this.bandHighHz = 840;
      this._monitorOn = false;
      this._savedMonitorGain = 1.4;
      this._rumbleOn = false;
      this._deHissOn = false;
      this.sampleRate = 48000;
      this.nyquist = 24000;
    }

    get isRunning() {
      return this.running;
    }

    get minHz() {
      return MIN_HZ;
    }

    get maxHz() {
      return this.nyquist;
    }

    get contextState() {
      return this.ctx ? this.ctx.state : "closed";
    }

    async resume() {
      if (this.ctx && this.ctx.state === "suspended") {
        try {
          await this.ctx.resume();
        } catch (_) {}
      }
    }

    async start() {
      if (this.running) return;

      // Simple constraints only — repeated applyConstraints / exact:false reconfigures
      // the Mac capture path and adds noticeable monitor latency.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      try {
        if (track && "contentHint" in track) track.contentHint = "music";
      } catch (_) {}

      const Ctx = root.AudioContext || root.webkitAudioContext;
      const ctx = new Ctx({ latencyHint: "interactive" });
      await ctx.resume();

      this.ctx = ctx;
      this.stream = stream;
      this.sampleRate = ctx.sampleRate;
      this.nyquist = ctx.sampleRate / 2;

      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      // Less temporal smear so short bird notes stay sharp on the spectrogram
      analyser.smoothingTimeConstant = 0.22;
      // Tighter dB window → weak tones map higher (display still noise-floored in UI)
      analyser.minDecibels = -88;
      analyser.maxDecibels = -22;

      const inputGain = ctx.createGain();
      // Fixed mic preamp (no UI slider). iPad gets a higher fixed gain (see PREAMP_*).
      const preamp = isIPad() ? PREAMP_IPAD : PREAMP_DEFAULT;
      inputGain.gain.value = preamp;
      this._preamp = preamp;

      const effectSlot = ctx.createGain();
      effectSlot.gain.value = 1;

      // Biquad defaults to 350 Hz — set target band immediately so first audio isn't wrong
      const lo0 = this.bandLowHz;
      const hi0 = this.bandHighHz;

      const bandHigh = ctx.createBiquadFilter();
      bandHigh.type = "highpass";
      bandHigh.Q.value = DEFAULT_BAND_Q;
      bandHigh.frequency.value = lo0;
      const bandHigh2 = ctx.createBiquadFilter();
      bandHigh2.type = "highpass";
      bandHigh2.Q.value = DEFAULT_BAND_Q;
      bandHigh2.frequency.value = lo0;
      const bandLow = ctx.createBiquadFilter();
      bandLow.type = "lowpass";
      bandLow.Q.value = DEFAULT_BAND_Q;
      bandLow.frequency.value = hi0;
      const bandLow2 = ctx.createBiquadFilter();
      bandLow2.type = "lowpass";
      bandLow2.Q.value = DEFAULT_BAND_Q;
      bandLow2.frequency.value = hi0;

      const bandGate = ctx.createGain();
      bandGate.gain.value = 0;
      const directGate = ctx.createGain();
      directGate.gain.value = 0;

      // Listen-path only (spectrum stays raw): rumble cut + de-hiss
      const rumbleFilter = ctx.createBiquadFilter();
      rumbleFilter.type = "highpass";
      rumbleFilter.Q.value = 0.7;
      rumbleFilter.frequency.value = this._rumbleOn ? 150 : 20;

      const deHissFilter = ctx.createBiquadFilter();
      deHissFilter.type = "highshelf";
      deHissFilter.frequency.value = 5500;
      deHissFilter.gain.value = this._deHissOn ? -12 : 0;

      const monitorGain = ctx.createGain();
      monitorGain.gain.value = 0;

      // Mono → both ears (iOS often left-only otherwise)
      const stereoOut = ctx.createChannelMerger(2);

      source.connect(analyser);
      source.connect(inputGain);
      inputGain.connect(effectSlot);

      effectSlot.connect(bandHigh);
      bandHigh.connect(bandHigh2);
      bandHigh2.connect(bandLow);
      bandLow.connect(bandLow2);
      bandLow2.connect(bandGate);
      bandGate.connect(rumbleFilter);

      effectSlot.connect(directGate);
      directGate.connect(rumbleFilter);

      rumbleFilter.connect(deHissFilter);
      deHissFilter.connect(monitorGain);

      monitorGain.connect(stereoOut, 0, 0);
      monitorGain.connect(stereoOut, 0, 1);
      stereoOut.connect(ctx.destination);

      this.source = source;
      this.analyser = analyser;
      this.inputGain = inputGain;
      this.effectSlot = effectSlot;
      this.bandHigh = bandHigh;
      this.bandHigh2 = bandHigh2;
      this.bandLow = bandLow;
      this.bandLow2 = bandLow2;
      this.bandGate = bandGate;
      this.directGate = directGate;
      this.rumbleFilter = rumbleFilter;
      this.deHissFilter = deHissFilter;
      this.monitorGain = monitorGain;
      this.stereoOut = stereoOut;
      this.running = true;

      // Instant (not ramped) so first samples match the UI band
      this._applyBand(true);
      this._applyRumble(true);
      this._applyDeHiss(true);
      this._routeMode(true);
      requestAnimationFrame(() => this.resume());
    }

    stop() {
      if (!this.running) return;
      try {
        this.source?.disconnect();
      } catch (_) {}
      try {
        this.monitorGain?.disconnect();
      } catch (_) {}
      try {
        this.stereoOut?.disconnect();
      } catch (_) {}
      try {
        this.inputGain?.disconnect();
      } catch (_) {}
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.ctx) {
        try {
          this.ctx.close();
        } catch (_) {}
      }
      this.ctx = null;
      this.stream = null;
      this.source = null;
      this.analyser = null;
      this.bandGate = null;
      this.directGate = null;
      this.rumbleFilter = null;
      this.deHissFilter = null;
      this.monitorGain = null;
      this.stereoOut = null;
      this.running = false;
      this.mode = "off";
      this._monitorOn = false;
    }

    get rumbleOn() {
      return this._rumbleOn;
    }

    get deHissOn() {
      return this._deHissOn;
    }

    setRumble(on) {
      this._rumbleOn = !!on;
      this._applyRumble();
    }

    setDeHiss(on) {
      this._deHissOn = !!on;
      this._applyDeHiss();
    }

    _applyRumble(immediate) {
      if (!this.rumbleFilter || !this.ctx) return;
      // On: highpass cut below ~150 Hz; off: essentially full band (~20 Hz)
      const hz = this._rumbleOn ? 150 : 20;
      const t = this.ctx.currentTime;
      if (immediate) this.rumbleFilter.frequency.setValueAtTime(hz, t);
      else this.rumbleFilter.frequency.setTargetAtTime(hz, t, 0.02);
    }

    _applyDeHiss(immediate) {
      if (!this.deHissFilter || !this.ctx) return;
      // On: gentle high-shelf cut (hiss); off: flat
      const g = this._deHissOn ? -12 : 0;
      const t = this.ctx.currentTime;
      if (immediate) this.deHissFilter.gain.setValueAtTime(g, t);
      else this.deHissFilter.gain.setTargetAtTime(g, t, 0.02);
    }

    setMonitorEnabled(on) {
      this._monitorOn = !!on;
      this.resume();
      this._routeMode();
    }

    get monitorEnabled() {
      return this._monitorOn;
    }

    setMode(mode) {
      if (mode !== "off" && mode !== "band" && mode !== "direct") return;
      this.mode = mode;
      this.resume();
      this._routeMode();
    }

    setBand(lowHz, highHz) {
      let lo = Math.min(lowHz, highHz);
      let hi = Math.max(lowHz, highHz);
      lo = clamp(lo, MIN_HZ, this.nyquist * 0.98);
      hi = clamp(hi, MIN_HZ * 1.05, this.nyquist);
      if (hi <= lo * 1.05) hi = Math.min(this.nyquist, lo * 1.05);
      this.bandLowHz = lo;
      this.bandHighHz = hi;
      this._applyBand();
    }

    setMonitorGain(linear) {
      const g = clamp(linear, 0, 4);
      this._savedMonitorGain = g;
      if (!this.monitorGain || !this.ctx) return;
      if (this._shouldHear()) {
        this.monitorGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
      }
    }

    getFrequencyData(out) {
      if (!this.analyser) return null;
      if (!out || out.length !== this.analyser.frequencyBinCount) {
        out = new Uint8Array(this.analyser.frequencyBinCount);
      }
      this.analyser.getByteFrequencyData(out);
      return out;
    }

    get binCount() {
      return this.analyser ? this.analyser.frequencyBinCount : 0;
    }

    _shouldHear() {
      if (!this._monitorOn) return false;
      return this.mode === "band" || this.mode === "direct";
    }

    _applyBand(immediate) {
      if (!this.bandHigh || !this.ctx) return;
      const t = this.ctx.currentTime;
      const lo = this.bandLowHz;
      const hi = this.bandHighHz;
      for (const n of [this.bandHigh, this.bandHigh2]) {
        if (immediate) n.frequency.setValueAtTime(lo, t);
        else n.frequency.setTargetAtTime(lo, t, 0.012);
      }
      for (const n of [this.bandLow, this.bandLow2]) {
        if (immediate) n.frequency.setValueAtTime(hi, t);
        else n.frequency.setTargetAtTime(hi, t, 0.012);
      }
    }

    _setGate(gate, open, immediate) {
      if (!gate || !this.ctx) return;
      const v = open ? 1 : 0;
      const t = this.ctx.currentTime;
      if (immediate) gate.gain.setValueAtTime(v, t);
      else gate.gain.setTargetAtTime(v, t, 0.008);
    }

    _routeMode(immediate) {
      if (!this.running || !this.monitorGain) return;

      const useBand = this._monitorOn && this.mode === "band";
      const useDirect = this._monitorOn && this.mode === "direct";

      this._setGate(this.bandGate, useBand, immediate);
      this._setGate(this.directGate, useDirect, immediate);

      const hear = useBand || useDirect;
      const g = hear ? this._savedMonitorGain : 0;
      const t = this.ctx.currentTime;
      if (immediate) this.monitorGain.gain.setValueAtTime(g, t);
      else this.monitorGain.gain.setTargetAtTime(g, t, 0.012);
    }
  }

  root.AudioEngine = AudioEngine;
})(typeof window !== "undefined" ? window : globalThis);
