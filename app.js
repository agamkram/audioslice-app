/**
 * AudioSlice — live spectrogram UI, band select and slide.
 */
(function () {
  "use strict";

  const engine = new AudioEngine();
  let freqData = null;
  let raf = 0;
  let runningVisual = false;

  // Spectrogram state
  let spectroW = 0;
  let spectroH = 0;
  let imageData = null;
  /** Per-row (log-freq) noise floor for display, 0..255 */
  let noiseFloor = null;
  /** Slow peak of post-floor signal — auto-contrast for quiet birds */
  let displayPeak = 40;

  // Default band: geometric center = 420 Hz (210–840 Hz)
  // Stored in Hz so focus does not drift when iOS sample-rate/nyquist appears at Start
  // (norm space used 22050 Hz before run vs 24000 after → ~436 Hz focus).
  const DEFAULT_BAND_LO_HZ = 210;
  const DEFAULT_BAND_HI_HZ = 840;

  // Interaction — absolute Hz is source of truth
  let bandLoHz = DEFAULT_BAND_LO_HZ;
  let bandHiHz = DEFAULT_BAND_HI_HZ;
  let dragging = null; // 'lo' | 'hi' | 'band' | null
  let dragStartY = 0;
  let dragStartLoHz = 0;
  let dragStartHiHz = 0;
  let mode = "band"; // band | direct

  const el = {
    stage: null,
    app: null,
    canvas: null,
    overlay: null,
    startBtn: null,
    modeBand: null,
    status: null,
    freqReadout: null,
    bandReadout: null,
    gainSlider: null,
    btnDeHiss: null,
    btnRumble: null,
    presetBirds: null,
    presetSpeech: null,
    presetLow: null,
    controls: null,
    hint: null,
  };

  let activePreset = null; // 'birds' | 'speech' | 'low' | null

  // —— Frequency mapping (log, low at bottom) ——
  function minHz() {
    return engine.minHz || 20;
  }
  function maxHz() {
    // Always use engine nyquist (updated on start) — band lives in Hz so UI stays stable
    return engine.maxHz || 22050;
  }

  function normToHz(n) {
    const lo = Math.log(minHz());
    const hi = Math.log(maxHz());
    const t = Math.max(0, Math.min(1, n));
    return Math.exp(lo + t * (hi - lo));
  }

  function hzToNorm(hz) {
    const lo = Math.log(minHz());
    const hi = Math.log(maxHz());
    const v = Math.log(Math.max(minHz(), Math.min(maxHz(), hz)));
    return (v - lo) / (hi - lo);
  }

  function bandLoNorm() {
    return hzToNorm(bandLoHz);
  }

  function bandHiNorm() {
    return hzToNorm(bandHiHz);
  }

  function setBandHz(loHz, hiHz) {
    let lo = Math.min(loHz, hiHz);
    let hi = Math.max(loHz, hiHz);
    const floor = minHz();
    const ceil = maxHz();
    lo = Math.max(floor, Math.min(ceil * 0.98, lo));
    hi = Math.max(floor * 1.05, Math.min(ceil, hi));
    if (hi <= lo * 1.05) hi = Math.min(ceil, lo * 1.05);
    bandLoHz = lo;
    bandHiHz = hi;
  }

  function setBandFromNorms(loN, hiN) {
    setBandHz(normToHz(loN), normToHz(hiN));
  }

  function yToNorm(y, height) {
    return 1 - y / height; // top = high freq
  }

  function normToY(n, height) {
    return (1 - n) * height;
  }

  // —— Color map: deep → blue → cyan → yellow → white ——
  // Tuned so low mapped values stay near black (less “mud”).
  function colorMap(v, out, i) {
    // v 0..255 (already contrast-processed)
    const t = Math.max(0, Math.min(1, v / 255));
    let r, g, b;
    if (t < 0.08) {
      // Near-black — hide residual floor
      const u = t / 0.08;
      r = 6 + u * 6;
      g = 8 + u * 8;
      b = 14 + u * 18;
    } else if (t < 0.28) {
      const u = (t - 0.08) / 0.2;
      r = 12 + u * 18;
      g = 16 + u * 40;
      b = 32 + u * 120;
    } else if (t < 0.5) {
      const u = (t - 0.28) / 0.22;
      r = 30 + u * 20;
      g = 56 + u * 100;
      b = 152 + u * 70;
    } else if (t < 0.72) {
      const u = (t - 0.5) / 0.22;
      r = 50 + u * 40;
      g = 156 + u * 70;
      b = 222 - u * 50;
    } else if (t < 0.88) {
      const u = (t - 0.72) / 0.16;
      r = 90 + u * 140;
      g = 226 - u * 30;
      b = 172 - u * 100;
    } else {
      const u = (t - 0.88) / 0.12;
      r = 230 + u * 25;
      g = 196 + u * 50;
      b = 72 + u * 180;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }

  function fillSpectroDark(data) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 8;
      data[i + 1] = 12;
      data[i + 2] = 20;
      data[i + 3] = 255;
    }
  }

  function ensureNoiseFloor(h) {
    if (noiseFloor && noiseFloor.length === h) return;
    noiseFloor = new Float32Array(h);
    noiseFloor.fill(18);
  }

  /**
   * Display-only cleanup:
   * - tame sub-200 Hz rumble mess (does not change headphones)
   * - track slow per-freq noise floor, subtract it
   * - auto-contrast so quiet birds rise above ambient
   */
  function processDisplayLevel(raw01, hz, row) {
    // 1) Low-frequency visual attenuator (full at ≥200 Hz)
    let atten = 1;
    if (hz < 200) {
      const t = Math.max(0, (hz - 25) / 175);
      // Strong suppress near DC/HVAC, gentle into speech
      atten = 0.08 + 0.92 * t * t;
    }

    let v = raw01 * 255 * atten;

    // 2) Slow noise floor (follows ambient, lags behind chirps)
    const floor = noiseFloor[row];
    if (v < floor) {
      // track down quickly when quieter
      noiseFloor[row] = floor * 0.92 + v * 0.08;
    } else {
      // rise very slowly — don't treat birds as floor
      noiseFloor[row] = floor * 0.9985 + v * 0.0015;
    }
    const nf = noiseFloor[row];

    // 3) Soft gate above floor
    let signal = v - nf * 1.12;
    if (signal < 4) signal = 0;
    else signal = signal - 4;

    return signal; // unscaled 0..~255
  }

  function ensureBuffers() {
    const canvas = el.canvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    if (w === spectroW && h === spectroH && imageData) return;

    spectroW = w;
    spectroH = h;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    imageData = ctx.createImageData(w, h);
    fillSpectroDark(imageData.data);
    ensureNoiseFloor(h);
  }

  /** Fresh spectrogram — call on every Start / Stop so history does not carry over. */
  function resetSpectrogram() {
    ensureBuffers();
    if (!el.canvas || !imageData) return;
    fillSpectroDark(imageData.data);
    const ctx = el.canvas.getContext("2d", { alpha: false });
    ctx.putImageData(imageData, 0, 0);
    freqData = null;
    if (noiseFloor) noiseFloor.fill(18);
    displayPeak = 40;
  }

  function binForNorm(n, binCount) {
    const hz = normToHz(n);
    const nyq = maxHz();
    const bin = Math.round((hz / nyq) * (binCount - 1));
    return Math.max(0, Math.min(binCount - 1, bin));
  }

  function drawColumn() {
    if (!engine.running || !engine.analyser) return;
    ensureBuffers();
    freqData = engine.getFrequencyData(freqData);
    if (!freqData) return;

    const bins = freqData.length;
    const h = spectroH;
    const w = spectroW;
    const data = imageData.data;
    ensureNoiseFloor(h);

    // Scroll left by 1 px
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      data.copyWithin(row, row + 4, row + rowBytes);
    }

    // New column on the right from log-sampled FFT
    const x = w - 1;
    let colPeak = 0;
    const signals = new Float32Array(h);

    for (let y = 0; y < h; y++) {
      const n = yToNorm(y + 0.5, h);
      const hz = normToHz(n);
      // Average a small neighborhood in bin space for smoothness
      const bin = binForNorm(n, bins);
      const binLo = Math.max(0, bin - 1);
      const binHi = Math.min(bins - 1, bin + 1);
      let sum = 0;
      let count = 0;
      for (let b = binLo; b <= binHi; b++) {
        sum += freqData[b];
        count++;
      }
      const raw = sum / count / 255;
      const sig = processDisplayLevel(raw, hz, y);
      signals[y] = sig;
      if (sig > colPeak) colPeak = sig;
    }

    // Auto-contrast: stretch residual signal so quiet events fill the color map
    if (colPeak > displayPeak) displayPeak = displayPeak * 0.65 + colPeak * 0.35;
    else displayPeak = displayPeak * 0.997 + colPeak * 0.003;
    const peak = Math.max(22, displayPeak);
    // Target ~peak maps near 0.85 of color scale
    const scale = 220 / peak;

    for (let y = 0; y < h; y++) {
      let mapped = signals[y] * scale;
      // Mild gamma so mid chirps pop without blowing peaks
      mapped = Math.pow(Math.min(1, mapped / 255), 0.72) * 255;
      const i = (y * w + x) * 4;
      colorMap(mapped, data, i);
    }

    const ctx = el.canvas.getContext("2d", { alpha: false });
    ctx.putImageData(imageData, 0, 0);
  }

  function drawOverlay() {
    const canvas = el.overlay;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = el.canvas.clientWidth;
    const cssH = el.canvas.clientHeight;
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = cssW;
    const H = cssH;

    // Frequency grid labels
    ctx.font = "600 10px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const marks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000];
    for (const hz of marks) {
      if (hz < minHz() || hz > maxHz()) continue;
      const n = hzToNorm(hz);
      const y = normToY(n, H);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(232,237,244,0.55)";
      const label = hz >= 1000 ? hz / 1000 + "k" : String(hz);
      ctx.fillText(label, 6, y);
    }

    // Selection highlight — Band and Full share the same adjustable chrome
    // (Full starts full-range; dragging HI/LO / yellow switches listen to Band)
    if (mode === "band" || mode === "direct") {
      const bandLive = engine.running;
      const yHi = normToY(bandHiNorm(), H);
      const yLo = normToY(bandLoNorm(), H);
      const top = Math.min(yHi, yLo);
      const bot = Math.max(yHi, yLo);
      const mid = (top + bot) / 2;
      const sliding = dragging === "band";

      ctx.fillStyle = bandLive
        ? sliding
          ? "rgba(61,156,245,0.24)"
          : "rgba(61,156,245,0.18)"
        : "rgba(61,156,245,0.10)";
      ctx.fillRect(0, top, W, bot - top);

      ctx.strokeStyle = bandLive
        ? "rgba(61,156,245,0.95)"
        : "rgba(61,156,245,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, top);
      ctx.lineTo(W, top);
      ctx.moveTo(0, bot);
      ctx.lineTo(W, bot);
      ctx.stroke();

      // Yellow center line — grab cue for sliding the whole band
      ctx.strokeStyle = sliding
        ? "rgba(250,204,21,0.95)"
        : "rgba(250,204,21,0.7)";
      ctx.lineWidth = sliding ? 2 : 1.5;
      ctx.setLineDash(sliding ? [] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(W, mid);
      ctx.stroke();
      ctx.setLineDash([]);

      // Handles
      drawHandle(ctx, W - 18, top, "hi");
      drawHandle(ctx, W - 18, bot, "lo");
    }

    // Live spectrum strip on right edge
    if (engine.running && freqData) {
      const stripW = 36;
      const bins = freqData.length;
      for (let y = 0; y < H; y++) {
        const n = yToNorm(y + 0.5, H);
        const bin = binForNorm(n, bins);
        const v = freqData[bin] / 255;
        const bar = v * stripW;
        ctx.fillStyle = `rgba(74,222,128,${0.15 + v * 0.55})`;
        ctx.fillRect(W - bar, y, bar, 1);
      }
    }

    ctx.restore();
  }

  function drawHandle(ctx, x, y, which) {
    ctx.fillStyle = "rgba(61,156,245,0.95)";
    ctx.strokeStyle = "rgba(232,237,244,0.9)";
    ctx.lineWidth = 1.5;
    const hx = x - 14;
    const hy = y - 8;
    const hw = 28;
    const hh = 16;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(hx + r, hy);
    ctx.lineTo(hx + hw - r, hy);
    ctx.quadraticCurveTo(hx + hw, hy, hx + hw, hy + r);
    ctx.lineTo(hx + hw, hy + hh - r);
    ctx.quadraticCurveTo(hx + hw, hy + hh, hx + hw - r, hy + hh);
    ctx.lineTo(hx + r, hy + hh);
    ctx.quadraticCurveTo(hx, hy + hh, hx, hy + hh - r);
    ctx.lineTo(hx, hy + r);
    ctx.quadraticCurveTo(hx, hy, hx + r, hy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0f1419";
    ctx.font = "700 9px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(which === "hi" ? "HI" : "LO", x, y);
  }

  function tick() {
    if (!runningVisual) return;
    drawColumn();
    drawOverlay();
    updateReadouts();
    raf = requestAnimationFrame(tick);
  }

  function updateReadouts() {
    const lo = bandLoHz;
    const hi = bandHiHz;
    if (el.bandReadout) el.bandReadout.textContent = formatBand(lo, hi);
    // Focus = geometric center of selected band
    if (el.freqReadout) {
      el.freqReadout.textContent = formatHz(Math.sqrt(lo * hi));
      el.freqReadout.dataset.kind = dragging === "band" ? "slide" : "band";
    }
  }

  function formatHz(hz) {
    if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + " kHz";
    return Math.round(hz) + " Hz";
  }

  function formatBand(lo, hi) {
    return formatHz(lo) + " – " + formatHz(hi);
  }

  function applyBandToEngine() {
    engine.setBand(bandLoHz, bandHiHz);
  }

  /** Always return to 420 Hz focus (210–840 Hz), Band mode, clear presets. */
  function resetBandTo420() {
    setBandHz(DEFAULT_BAND_LO_HZ, DEFAULT_BAND_HI_HZ);
    setActivePreset(null);
    mode = "band";
    dragging = null;
    setToggleBtn(el.modeBand, true);
    setToggleBtn(el.modeDirect, false);
    updateReadouts();
  }

  // —— Pointer interaction ——
  function canvasPoint(e) {
    const rect = el.overlay.getBoundingClientRect();
    const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      W: rect.width,
      H: rect.height,
    };
  }

  /** HI/LO only hit on the handle buttons (right edge), not the full width of the line. */
  function hitTestBand(x, y, W, H) {
    const yHi = normToY(bandHiNorm(), H);
    const yLo = normToY(bandLoNorm(), H);
    const top = Math.min(yHi, yLo);
    const bot = Math.max(yHi, yLo);
    const mid = (top + bot) / 2;
    const gap = bot - top;
    const handleX = W - 18;
    const handleHitX = 24; // half-width of touch target around handle
    const handleHitY = 18;
    const onHandleX = Math.abs(x - handleX) <= handleHitX;

    if (onHandleX) {
      // When band is narrow, HI/LO hit boxes overlap — split on midpoint
      // so either handle can always be grabbed (upper half = HI, lower = LO).
      if (gap < handleHitY * 2.5) {
        const zoneTop = top - handleHitY;
        const zoneBot = bot + handleHitY;
        if (y >= zoneTop && y <= zoneBot) {
          return y < mid ? "hi" : "lo";
        }
      } else {
        if (Math.abs(y - top) <= handleHitY) return "hi";
        if (Math.abs(y - bot) <= handleHitY) return "lo";
      }
    }
    // Anywhere else — slide the whole range (including on the HI/LO lines)
    return "band";
  }

  /** Dragging Full’s range selects a band and switches listen to Band. */
  function ensureBandListenFromFull() {
    if (mode !== "direct") return;
    mode = "band";
    setToggleBtn(el.modeBand, true);
    setToggleBtn(el.modeDirect, false);
    engine.setMode("band");
    engine.setMonitorEnabled(true);
    if (el.hint) {
      el.hint.textContent =
        "Drag HI/LO to set range · drag yellow line / anywhere to slide the band";
    }
  }

  function onPointerDown(e) {
    if (!engine.running) return;
    if (mode !== "band" && mode !== "direct") return;
    e.preventDefault();
    const p = canvasPoint(e);

    const hit = hitTestBand(p.x, p.y, p.W, p.H);
    if (hit === "hi" || hit === "lo") {
      dragging = hit;
    } else {
      // Slide whole band (works inside the band, on the lines, or in the margin)
      dragging = "band";
      dragStartY = p.y;
      dragStartLoHz = bandLoHz;
      dragStartHiHz = bandHiHz;
    }

    el.overlay.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging || !engine.running) return;
    e.preventDefault();
    const p = canvasPoint(e);
    const n = Math.max(0.02, Math.min(0.98, yToNorm(p.y, p.H)));

    if (dragging === "hi") {
      setBandFromNorms(bandLoNorm(), Math.max(bandLoNorm() + 0.02, n));
      setActivePreset(null);
      ensureBandListenFromFull();
      applyBandToEngine();
    } else if (dragging === "lo") {
      setBandFromNorms(Math.min(bandHiNorm() - 0.02, n), bandHiNorm());
      setActivePreset(null);
      ensureBandListenFromFull();
      applyBandToEngine();
    } else if (dragging === "band") {
      // Slide in log-norm space from the Hz snapshot at pointer-down
      const startLoN = hzToNorm(dragStartLoHz);
      const startHiN = hzToNorm(dragStartHiHz);
      const dNorm = yToNorm(p.y, p.H) - yToNorm(dragStartY, p.H);
      let lo = startLoN + dNorm;
      let hi = startHiN + dNorm;
      if (lo < 0.02) {
        hi += 0.02 - lo;
        lo = 0.02;
      }
      if (hi > 0.98) {
        lo -= hi - 0.98;
        hi = 0.98;
      }
      setBandFromNorms(Math.max(0.02, lo), Math.min(0.98, hi));
      setActivePreset(null);
      ensureBandListenFromFull();
      applyBandToEngine();
    }
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = null;
    try {
      el.overlay.releasePointerCapture?.(e.pointerId);
    } catch (_) {}
  }

  // —— Controls ——
  async function startListening() {
    try {
      el.status.textContent = "Requesting mic…";
      el.startBtn.disabled = true;
      await engine.start();
      await engine.resume();
      resetBandTo420();
      applyBandToEngine();
      engine.setMonitorGain(Number(el.gainSlider.value));
      setMode("band");
      engine.setMonitorEnabled(true);
      engine.setMode("band");
      engine.setDeHiss(engine.deHissOn);
      engine.setRumble(engine.rumbleOn);

      el.startBtn.textContent = "Stop";
      el.startBtn.dataset.state = "on";
      el.startBtn.disabled = false;
      el.status.textContent = "Live";
      el.status.dataset.state = "live";
      el.hint.textContent =
        "Drag HI/LO to set range · drag yellow line / anywhere to slide the band";
      el.gainSlider.disabled = false;
      setToggleBtn(el.btnDeHiss, engine.deHissOn);
      setToggleBtn(el.btnRumble, engine.rumbleOn);
      setControlsLive(true);

      runningVisual = true;
      resetSpectrogram();
      drawOverlay();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    } catch (err) {
      console.error(err);
      el.status.textContent = micErrorMessage(err);
      el.status.dataset.state = "err";
      el.startBtn.textContent = "Start mic";
      el.startBtn.dataset.state = "off";
      el.startBtn.disabled = false;
      setControlsLive(false);
    }
  }

  function stopListening() {
    runningVisual = false;
    cancelAnimationFrame(raf);
    engine.stop();
    dragging = null;
    el.startBtn.textContent = "Start mic";
    el.startBtn.dataset.state = "off";
    el.status.textContent = "Mic off";
    el.status.dataset.state = "";
    el.hint.innerHTML =
      '<span class="hint-white">Wired headphones on</span>. Start mic to isolate spectrum';
    el.gainSlider.disabled = true;
    setControlsLive(false);
    resetBandTo420();
    resetSpectrogram();
    drawOverlay();
  }

  function micErrorMessage(err) {
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Mic blocked — allow microphone access";
    }
    if (name === "NotFoundError") return "No microphone found";
    return "Mic error — check permissions";
  }

  function toggleStart() {
    if (engine.running) stopListening();
    else startListening();
  }

  function setToggleBtn(btn, on) {
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.dataset.on = on ? "1" : "0";
  }

  function setProcessBtn(btn, on) {
    setToggleBtn(btn, on);
  }

  /** Live = after Start: secondary buttons accept input. Idle keeps full lit look. */
  function setControlsLive(live) {
    el.controls?.classList.toggle("is-idle", !live);
    const secondary = [
      el.modeBand,
      el.modeDirect,
      el.presetBirds,
      el.presetSpeech,
      el.presetLow,
      el.btnDeHiss,
      el.btnRumble,
    ];
    for (const btn of secondary) {
      if (!btn) continue;
      btn.setAttribute("aria-disabled", live ? "false" : "true");
      btn.tabIndex = live ? 0 : -1;
    }
  }

  function setActivePreset(name) {
    activePreset = name || null;
    setToggleBtn(el.presetBirds, activePreset === "birds");
    setToggleBtn(el.presetSpeech, activePreset === "speech");
    setToggleBtn(el.presetLow, activePreset === "low");
  }

  function applyPreset(name, loHz, hiHz) {
    if (!engine.running) return;
    setBandHz(loHz, hiHz);
    applyBandToEngine();
    setActivePreset(name);
    // Same as Band — adjustable range; no sticky “Speech — …” style hint
    setMode("band");
  }

  function setMode(m) {
    if (m !== "band" && m !== "direct") m = "band";
    dragging = null;
    mode = m;
    setToggleBtn(el.modeBand, m === "band");
    setToggleBtn(el.modeDirect, m === "direct");
    if (m === "direct") {
      // Full = entire spectrum as an adjustable band (unfiltered until you drag)
      setActivePreset(null);
      setBandFromNorms(0.02, 0.98);
      updateReadouts();
    }
    if (!engine.running) return;
    engine.resume();
    engine.setMonitorEnabled(true);
    engine.setMode(m);
    if (m === "direct") {
      el.hint.textContent =
        "Full unfiltered · drag HI/LO or yellow line to isolate a band";
    } else {
      el.hint.textContent =
        "Drag HI/LO to set range · drag yellow center line / anywhere to slide the band";
    }
  }

  // —— Boot ——
  function bind() {
    el.stage = document.getElementById("fit-stage");
    el.app = document.getElementById("app");
    el.canvas = document.getElementById("spectro");
    el.overlay = document.getElementById("overlay");
    el.startBtn = document.getElementById("start-btn");
    el.modeBand = document.getElementById("mode-band");
    el.modeDirect = document.getElementById("mode-direct");
    el.status = document.getElementById("status");
    el.freqReadout = document.getElementById("freq-readout");
    el.bandReadout = document.getElementById("band-readout");
    el.gainSlider = document.getElementById("gain");
    el.btnDeHiss = document.getElementById("btn-dehiss");
    el.btnRumble = document.getElementById("btn-rumble");
    el.presetBirds = document.getElementById("preset-birds");
    el.presetSpeech = document.getElementById("preset-speech");
    el.presetLow = document.getElementById("preset-low");
    el.controls = document.getElementById("controls");
    el.hint = document.getElementById("hint");

    el.startBtn.addEventListener("click", toggleStart);
    el.modeBand.addEventListener("click", () => {
      if (!engine.running) return;
      setMode("band");
    });
    el.modeDirect?.addEventListener("click", () => {
      if (!engine.running) return;
      setMode("direct");
    });

    el.gainSlider.addEventListener("input", () => {
      if (!engine.running) return;
      engine.resume();
      engine.setMonitorGain(Number(el.gainSlider.value));
    });

    el.btnDeHiss?.addEventListener("click", () => {
      if (!engine.running) return;
      engine.setDeHiss(!engine.deHissOn);
      setToggleBtn(el.btnDeHiss, engine.deHissOn);
      el.hint.textContent = engine.deHissOn
        ? "De-hiss on — high-frequency hiss cut in headphones"
        : "De-hiss off";
    });
    el.btnRumble?.addEventListener("click", () => {
      if (!engine.running) return;
      engine.setRumble(!engine.rumbleOn);
      setToggleBtn(el.btnRumble, engine.rumbleOn);
      el.hint.textContent = engine.rumbleOn
        ? "Rumble on — low rumble / wind cut in headphones"
        : "Rumble off";
    });

    const surface = el.overlay;
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    surface.addEventListener(
      "touchstart",
      (e) => {
        if (engine.running) e.preventDefault();
      },
      { passive: false }
    );

    el.presetBirds?.addEventListener("click", () => {
      applyPreset("birds", 4000, 9000);
    });
    el.presetSpeech?.addEventListener("click", () => {
      applyPreset("speech", 300, 3400);
    });
    el.presetLow?.addEventListener("click", () => {
      applyPreset("low", 40, 250);
    });

    setMode("band");
    setActivePreset(null);
    setToggleBtn(el.btnDeHiss, engine.deHissOn);
    setToggleBtn(el.btnRumble, engine.rumbleOn);
    el.gainSlider.disabled = true;
    setControlsLive(false);

    // Fit-to-screen
    function showApp() {
      if (el.app) el.app.classList.add("is-fitted");
    }

    function pinPhoneFill() {
      // Phone only: fill the visible area. Guard against 0-size (PWA cold start).
      const isPhone = window.innerWidth <= 767;
      const stage = el.stage;
      const app = el.app;
      if (!stage || !app) return;
      if (!isPhone) {
        stage.style.top = "";
        stage.style.left = "";
        stage.style.width = "";
        stage.style.height = "";
        stage.style.right = "";
        stage.style.bottom = "";
        app.style.height = "";
        app.style.width = "";
        app.style.maxHeight = "";
        app.style.maxWidth = "";
        return;
      }

      const vv = window.visualViewport;
      const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        window.navigator.standalone === true;

      let w = Math.round(window.innerWidth) || 390;
      let h = Math.round(window.innerHeight) || 700;
      let top = 0;
      let left = 0;

      if (!standalone && vv && vv.height > 40) {
        w = Math.round(vv.width) || w;
        h = Math.round(vv.height) || h;
        top = Math.round(vv.offsetTop) || 0;
        left = Math.round(vv.offsetLeft) || 0;
      }
      // Never pin a collapsed stage (blank PWA)
      if (w < 200) w = Math.round(window.innerWidth) || 390;
      if (h < 200) h = Math.round(window.innerHeight) || 700;

      stage.classList.add("fit-stage--fluid");
      stage.style.position = "fixed";
      stage.style.top = `${top}px`;
      stage.style.left = `${left}px`;
      stage.style.right = "auto";
      stage.style.bottom = "auto";
      stage.style.width = `${w}px`;
      stage.style.height = `${h}px`;

      app.style.transform = "none";
      app.style.width = "100%";
      app.style.maxWidth = "none";
      app.style.height = "100%";
      app.style.maxHeight = "none";
      app.dataset.layout = "phone";
    }

    const fit = FitToScreen.create({
      stage: "fit-stage",
      app: "app",
      phoneMaxWidth: 767, // phone only — iPad stays scaled/centered
      wideAppWidth: 720,
      capScaleAtOne: true,
      // Phone: fluid full-height (no scale gap under controls). Desktop/iPad: scale.
      useScaleForLayout: (layout) => layout !== "phone",
      onFit: () => {
        pinPhoneFill();
        showApp();
        ensureBuffers();
        drawOverlay();
      },
    });
    fit.bindViewportListeners();

    // Always show UI quickly — never leave home-screen icon opening to blank
    pinPhoneFill();
    showApp();
    ensureBuffers();
    drawOverlay();

    fit.bootLayout()
      .then(() => {
        pinPhoneFill();
        showApp();
        ensureBuffers();
        drawOverlay();
      })
      .catch(() => {
        pinPhoneFill();
        showApp();
      });

    // Failsafe if fonts/viewport settle hangs
    setTimeout(() => {
      pinPhoneFill();
      showApp();
      ensureBuffers();
      drawOverlay();
    }, 800);

    window.addEventListener("resize", () => {
      pinPhoneFill();
      ensureBuffers();
    });
    window.visualViewport?.addEventListener("resize", () => {
      pinPhoneFill();
      ensureBuffers();
    });

    window.addEventListener("pagehide", () => {
      if (engine.running) stopListening();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
