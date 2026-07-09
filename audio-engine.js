/**
 * AudioEngine — mic → analyse + filtered monitor.
 * Band / Full gates · dual-mono out · AGC off · user gain only.
 */
(function (root) {
  "use strict";

  const MIN_HZ = 20;
  const DEFAULT_BAND_Q = 0.707;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
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
      this.effectSlot = null;
      this.running = false;
      this.mode = "off"; // off | band | direct
      this.bandLowHz = 2000;
      this.bandHighHz = 8000;
      this._monitorOn = false;
      this._savedMonitorGain = 1.4;
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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      try {
        await stream.getAudioTracks()[0]?.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
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
      analyser.smoothingTimeConstant = 0.35;
      analyser.minDecibels = -95;
      analyser.maxDecibels = -15;

      const inputGain = ctx.createGain();
      // Fixed mic preamp (no UI slider) — room/ambient levels are much quieter than close speech
      inputGain.gain.value = 4;

      const effectSlot = ctx.createGain();
      effectSlot.gain.value = 1;

      const bandHigh = ctx.createBiquadFilter();
      bandHigh.type = "highpass";
      bandHigh.Q.value = DEFAULT_BAND_Q;
      const bandHigh2 = ctx.createBiquadFilter();
      bandHigh2.type = "highpass";
      bandHigh2.Q.value = DEFAULT_BAND_Q;
      const bandLow = ctx.createBiquadFilter();
      bandLow.type = "lowpass";
      bandLow.Q.value = DEFAULT_BAND_Q;
      const bandLow2 = ctx.createBiquadFilter();
      bandLow2.type = "lowpass";
      bandLow2.Q.value = DEFAULT_BAND_Q;

      const bandGate = ctx.createGain();
      bandGate.gain.value = 0;
      const directGate = ctx.createGain();
      directGate.gain.value = 0;

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
      bandGate.connect(monitorGain);

      effectSlot.connect(directGate);
      directGate.connect(monitorGain);

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
      this.monitorGain = monitorGain;
      this.stereoOut = stereoOut;
      this.running = true;

      this._applyBand();
      this._routeMode();
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
      this.monitorGain = null;
      this.stereoOut = null;
      this.running = false;
      this.mode = "off";
      this._monitorOn = false;
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

    _applyBand() {
      if (!this.bandHigh || !this.ctx) return;
      const t = this.ctx.currentTime;
      const lo = this.bandLowHz;
      const hi = this.bandHighHz;
      for (const n of [this.bandHigh, this.bandHigh2]) {
        n.frequency.setTargetAtTime(lo, t, 0.012);
      }
      for (const n of [this.bandLow, this.bandLow2]) {
        n.frequency.setTargetAtTime(hi, t, 0.012);
      }
    }

    _setGate(gate, open) {
      if (!gate || !this.ctx) return;
      gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.008);
    }

    _routeMode() {
      if (!this.running || !this.monitorGain) return;

      const useBand = this._monitorOn && this.mode === "band";
      const useDirect = this._monitorOn && this.mode === "direct";

      this._setGate(this.bandGate, useBand);
      this._setGate(this.directGate, useDirect);

      const hear = useBand || useDirect;
      const g = hear ? this._savedMonitorGain : 0;
      this.monitorGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
    }
  }

  root.AudioEngine = AudioEngine;
})(typeof window !== "undefined" ? window : globalThis);
