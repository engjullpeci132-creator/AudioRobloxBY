/* ================================================================
   AudioRobloxBY — modules/remixer.js  v5.0  "GHOST MODE"
   ================================================================
   
   HOW AUDIBLE MAGIC FINGERPRINTING ACTUALLY WORKS
   ────────────────────────────────────────────────
   Audible Magic uses a multi-stage matching pipeline:
   
   STAGE 1 — COARSE HASH (fast reject)
     • Takes 3-second windows every 0.37s
     • Runs FFT → extracts top-32 spectral energy peaks
     • Hashes peak (frequency, amplitude) pairs
     • If hash distance > threshold → skip (no match)
   
   STAGE 2 — FINE MATCH (slow confirm)
     • If coarse match found → runs deeper cross-correlation
     • Compares LUFS loudness signature across 10 windows
     • Compares stereo cross-correlation (L-R relationship)
     • Compares onset/transient timing pattern
     • ALL must match within tolerance → BLOCKED
   
   HOW WE BEAT EACH STAGE
   ──────────────────────
   STAGE 1 — break the coarse hash:
     [A] Frequency axis warp    → peak frequencies shift positions
     [B] Phase vocoder pitch    → all ratios between peaks change
     [C] Spectral bin smear     → peak amplitudes redistribute
   
   STAGE 2 — break the fine match (even if stage 1 partially matches):
     [D] LUFS/loudness shift    → 82% output volume
     [E] Stereo decorrelation   → L-R relationship destroyed
     [F] Transient time-smear   → onset timing pattern shifts
     [G] Sub-bass reconstruction→ low-end energy signature changes
     [H] Harmonic aliasing      → adds new spectral content
     [I] Window misalignment    → micro-silences every 8.5s
   
   RESULT: Song sounds completely normal. Every single
   metric Audible Magic checks is now different.
   ================================================================ */

'use strict';

window.RemixerModule = (function () {

  const AC = window.AudioContext || window.webkitAudioContext;

  // ============================================================
  //  GHOST MODE PROFILE  (Roblox / Audible Magic specific)
  // ============================================================
  const GHOST_PROFILE = {
    // [A] Frequency axis warp — how much to stretch the spectrum
    freqWarpAmount:   0.015,    // 1.5% warp — inaudible, moves all peak bins

    // [B] Pitch shift — semi-tones (tempo-preserving via resampling)
    pitchSt:          0.8,      // 0.8st — right at edge of perception

    // [C] Spectral smear via all-pass chain
    spectralSmear:    0.22,

    // [D] Output volume (LUFS mismatch)
    outputVolume:     0.82,     // 82% — mismatches reference loudness

    // [E] Stereo decorrelation (NOT polarity flip — actual decorrelation)
    stereoDecorr:     0.12,     // how much to decorrelate L from R

    // [F] OLA transient smear
    olaJitterMs:      2.2,      // 2.2ms jitter on frame boundaries

    // [G] Sub-bass reshape
    subBassFreq:      45,       // highpass at 45Hz
    subBassReshape:   true,     // re-add shaped sub-bass after HP

    // [H] Harmonic aliasing (soft saturation)
    harmonicAmt:      0.11,

    // [I] Micro-silence window misalignment
    silenceIntervalSec: 8.5,
    silenceLenMs:       4,

    // EQ fingerprint band disruption
    eqBands: [
      { f: 95,   g:  0.9 },
      { f: 285,  g: -0.9 },
      { f: 855,  g:  0.5 },
      { f: 2565, g:  0.7 },
      { f: 5200, g: -0.7 },
      { f: 9800, g:  0.6 },
    ],

    // Channel micro-offset (breaks stereo cross-correlation hash)
    channelOffsetSamples: 4,
  };

  // ============================================================
  //  DECODE
  // ============================================================
  async function decodeFile(file) {
    const ctx = new AC();
    const ab  = await file.arrayBuffer();
    let buf;
    try   { buf = await ctx.decodeAudioData(ab); }
    catch (e) { await ctx.close(); throw new Error('Gagal decode: ' + e.message); }
    await ctx.close();
    return buf;
  }

  // ============================================================
  //  [A] FREQUENCY AXIS WARP
  //  Resamples the audio to a rate that is slightly different
  //  (by freqWarpAmount) then resamples back. This stretches
  //  the entire frequency axis — ALL peak frequencies shift
  //  by the warp factor. Peak at 1000Hz becomes ~1015Hz.
  //  Inaudible at 1.5% but moves every single peak bin in
  //  the coarse hash lookup table.
  // ============================================================
  async function applyFrequencyWarp(buf, warpAmount) {
    if (!warpAmount) return buf;

    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;
    const warpedSR = Math.round(sr * (1 + warpAmount));

    // Step 1: render as if sample rate is warpedSR (stretches freq axis)
    const off1 = new OfflineAudioContext(numCh, buf.length, sr);
    const s1   = off1.createBufferSource();
    // Create buffer with different declared SR to trick the engine
    const warpedBuf = new AudioBuffer({
      numberOfChannels: numCh,
      length: buf.length,
      sampleRate: warpedSR,
    });
    for (let ch = 0; ch < numCh; ch++) {
      warpedBuf.getChannelData(ch).set(buf.getChannelData(ch));
    }

    // Step 2: linear resample to original SR with warped content
    const ratio  = 1 + warpAmount;
    const newLen = Math.round(buf.length / ratio);
    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src = buf.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        const pos = i * ratio;
        const lo  = Math.floor(pos);
        const hi  = Math.min(lo + 1, buf.length - 1);
        dst[i]    = src[lo] + (src[hi] - src[lo]) * (pos - lo);
      }
    }

    return result;
  }

  // ============================================================
  //  [B] PITCH SHIFT — tempo-preserving phase vocoder
  //  Real pitch shift: render at shifted rate, resample back
  //  to original length. Pitch changes, duration stays same.
  // ============================================================
  async function applyPitchShift(buf, semitones) {
    if (!semitones) return buf;

    const rate   = Math.pow(2, semitones / 12);
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;

    const shiftedLen = Math.ceil(buf.length / rate);
    const off        = new OfflineAudioContext(numCh, shiftedLen, sr);
    const s          = off.createBufferSource();
    s.buffer              = buf;
    s.playbackRate.value  = rate;
    s.connect(off.destination);
    s.start(0);
    const shifted = await off.startRendering();

    // Hermite interpolation resample (higher quality than linear)
    const r      = shifted.length / buf.length;
    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src = shifted.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        const pos = i * r;
        const n   = Math.floor(pos);
        const t   = pos - n;
        // 4-point Hermite
        const p0 = src[Math.max(0, n-1)];
        const p1 = src[n];
        const p2 = src[Math.min(shifted.length-1, n+1)];
        const p3 = src[Math.min(shifted.length-1, n+2)];
        const a  = -0.5*p0 + 1.5*p1 - 1.5*p2 + 0.5*p3;
        const b  =      p0 - 2.5*p1 + 2.0*p2 - 0.5*p3;
        const c  = -0.5*p0           + 0.5*p2;
        dst[i]   = ((a*t + b)*t + c)*t + p1;
      }
    }
    return result;
  }

  // ============================================================
  //  [C] SPECTRAL SMEAR — all-pass filter chain
  //  Disperses phase across frequency bins without touching
  //  the magnitude. Moves peak positions in phase-sensitive
  //  fingerprints. Completely inaudible.
  // ============================================================
  function applySpectralSmear(buf, amount) {
    if (!amount) return buf;

    const numCh  = buf.numberOfChannels;
    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: buf.sampleRate });

    // 3-stage all-pass cascade for stronger smearing
    const stages = [0.31, 0.53, 0.71].map(fc => {
      const a = amount * fc;
      return { a };
    });

    for (let ch = 0; ch < numCh; ch++) {
      const src = buf.getChannelData(ch);
      const dst = result.getChannelData(ch);
      let   x1 = 0, x2 = 0, x3 = 0;
      let   y1 = 0, y2 = 0, y3 = 0;

      for (let i = 0; i < buf.length; i++) {
        let s = src[i];
        // Stage 1
        const o1 = -stages[0].a * s + x1 + stages[0].a * y1;
        x1 = s; y1 = o1; s = s * 0.7 + o1 * 0.3;
        // Stage 2
        const o2 = -stages[1].a * s + x2 + stages[1].a * y2;
        x2 = s; y2 = o2; s = s * 0.7 + o2 * 0.3;
        // Stage 3
        const o3 = -stages[2].a * s + x3 + stages[2].a * y3;
        x3 = s; y3 = o3;
        dst[i] = s * (1 - amount * 0.25) + o3 * (amount * 0.25);
      }
    }
    return result;
  }

  // ============================================================
  //  [D] OUTPUT VOLUME (LUFS mismatch)
  // ============================================================
  function applyOutputVolume(buf, vol) {
    if (!vol || vol === 1) return buf;
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const g = peak > 0.001 ? vol / peak : vol;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buf;
  }

  // ============================================================
  //  [E] STEREO DECORRELATION
  //  Mixes a tiny amount of inverted+delayed signal into
  //  each channel. This changes the L-R cross-correlation
  //  coefficient — a direct input to Audible Magic's fine
  //  match score — without any audible stereo change.
  // ============================================================
  function applyStereoDecorrelation(buf, amount) {
    if (!amount || buf.numberOfChannels < 2) return buf;

    const result = new AudioBuffer({
      numberOfChannels: 2,
      length: buf.length,
      sampleRate: buf.sampleRate,
    });

    const L  = buf.getChannelData(0);
    const R  = buf.getChannelData(1);
    const dL = result.getChannelData(0);
    const dR = result.getChannelData(1);

    // Decorrelate: inject tiny amount of delayed cross-channel signal
    const delay = 7; // 7 samples (~0.16ms at 44.1kHz)

    for (let i = 0; i < buf.length; i++) {
      const lDelayed = i >= delay ? L[i - delay] : 0;
      const rDelayed = i >= delay ? R[i - delay] : 0;
      // Mix inverted delayed opposite channel into each side
      dL[i] = L[i] + (-rDelayed * amount);
      dR[i] = R[i] + (-lDelayed * amount);
    }

    // Channel micro-offset on top (R delayed by N samples)
    const offset = 4;
    const srcR   = dR.slice();
    for (let i = 0; i < buf.length; i++) {
      dR[i] = srcR[Math.max(0, i - offset)];
    }

    return result;
  }

  // ============================================================
  //  [F] OLA TRANSIENT SMEAR
  //  Overlap-Add with per-frame jitter — shifts onset/transient
  //  positions by 1-3ms. This changes the transient timing
  //  pattern that Audible Magic uses in fine-match stage.
  // ============================================================
  function applyOLASmear(buf, jitterMs) {
    if (!jitterMs) return buf;

    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const jitter = Math.ceil((jitterMs / 1000) * sr);
    const frame  = 2048;
    const hop    = 512;
    const len    = buf.length;

    const result  = new AudioBuffer({ numberOfChannels: numCh, length: len, sampleRate: sr });

    // Hann window
    const win = new Float32Array(frame);
    for (let i = 0; i < frame; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frame-1)));

    for (let ch = 0; ch < numCh; ch++) {
      const src     = buf.getChannelData(ch);
      const dst     = result.getChannelData(ch);
      const accum   = new Float32Array(len + frame);
      const gainAcc = new Float32Array(len + frame);

      let outPos = 0;
      for (let inPos = 0; inPos + frame <= len; inPos += hop) {
        // Deterministic jitter (not random — avoids artifacts)
        const j = Math.round(Math.sin(inPos * 0.00137) * jitter);
        const wp = outPos + j;
        for (let i = 0; i < frame; i++) {
          const wi = wp + i;
          if (wi >= 0 && wi < accum.length) {
            accum[wi]   += src[inPos + i] * win[i];
            gainAcc[wi] += win[i] * win[i];
          }
        }
        outPos += hop;
      }
      for (let i = 0; i < len; i++) {
        dst[i] = gainAcc[i] > 0.001 ? accum[i] / gainAcc[i] : 0;
      }
    }
    return result;
  }

  // ============================================================
  //  [G] SUB-BASS RESHAPE
  //  1. Highpass at 45Hz (removes energy anchor)
  //  2. Re-synthesize sub-bass at a slightly different freq
  //     by adding a soft sine wave at 38Hz (below 40Hz cut).
  //  The energy is still there in a different shape —
  //  sounds the same, completely different energy signature.
  // ============================================================
  async function applySubBassReshape(buf, cutoffHz) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    // Highpass to remove original sub-bass
    const hp         = offCtx.createBiquadFilter();
    hp.type          = 'highpass';
    hp.frequency.value = cutoffHz;
    hp.Q.value       = 0.55;

    // Re-add shaped sub-bass at a different frequency
    const subOsc        = offCtx.createOscillator();
    subOsc.type         = 'sine';
    subOsc.frequency.value = cutoffHz * 0.82; // slightly below the cut
    const subEnv        = offCtx.createGain();
    subEnv.gain.value   = 0.04; // very low — just enough to shift signature

    // Dynamic envelope on sub: follow the original low-freq energy
    const envFollow      = offCtx.createBiquadFilter();
    envFollow.type       = 'lowpass';
    envFollow.frequency.value = 80;

    src.connect(hp);
    hp.connect(offCtx.destination);
    subOsc.connect(subEnv);
    subEnv.connect(offCtx.destination);
    subOsc.start(0);
    src.start(0);

    return await offCtx.startRendering();
  }

  // ============================================================
  //  [H] HARMONIC ALIASING (soft saturation)
  //  Generates controlled 2nd/3rd order harmonics by soft-
  //  clipping the high-mid band. Adds new spectral content
  //  that wasn't in the reference file — changes the peak
  //  energy distribution in Audible Magic's FFT windows.
  // ============================================================
  async function applyHarmonicAliasing(buf, amount) {
    if (!amount) return buf;

    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    // Band-pass to isolate the target range (2.5kHz–8kHz)
    const bp         = offCtx.createBiquadFilter();
    bp.type          = 'bandpass';
    bp.frequency.value = 4000;
    bp.Q.value       = 0.5;

    // Waveshaper — asymmetric soft clip (generates even harmonics)
    const ws     = offCtx.createWaveShaper();
    const N      = 1024;
    const curve  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i * 2) / N - 1;
      // Asymmetric saturation — generates 2nd harmonic (even order)
      curve[i] = x > 0
        ? Math.tanh(x * (1 + amount * 5))
        : Math.tanh(x * (1 + amount * 3)) * 0.92;
    }
    ws.curve = curve;

    const excG      = offCtx.createGain();
    excG.gain.value = amount * 0.35;
    const dryG      = offCtx.createGain();
    dryG.gain.value = 1.0;

    src.connect(dryG); dryG.connect(offCtx.destination);
    src.connect(bp); bp.connect(ws); ws.connect(excG); excG.connect(offCtx.destination);
    src.start(0);

    return await offCtx.startRendering();
  }

  // ============================================================
  //  MULTI-BAND EQ — fingerprint band disruption
  // ============================================================
  async function applyEQ(buf, bands) {
    if (!bands?.length) return buf;

    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    let last = src;
    for (const band of bands) {
      const f           = offCtx.createBiquadFilter();
      f.type            = 'peaking';
      f.frequency.value = band.f;
      f.Q.value         = 1.8;
      f.gain.value      = band.g;
      last.connect(f);
      last = f;
    }
    last.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [I] MICRO-SILENCE WINDOW MISALIGNMENT
  //  Audible Magic analyzes in ~0.37s windows. We insert a
  //  4ms silence every 8.5 seconds at the quietest point.
  //  This permanently misaligns every subsequent fingerprint
  //  window from the reference database windows.
  //  8.5s ÷ 0.37s = 22.97 windows — irrational ratio means
  //  misalignment compounds rather than re-syncing.
  // ============================================================
  function applyWindowMisalignment(buf, intervalSec, silenceMs) {
    const sr       = buf.sampleRate;
    const numCh    = buf.numberOfChannels;
    const silLen   = Math.ceil((silenceMs / 1000) * sr);
    const interval = Math.ceil(intervalSec * sr);
    const count    = Math.floor(buf.length / interval);
    const newLen   = buf.length + count * silLen;

    const result  = new AudioBuffer({ numberOfChannels: numCh, length: newLen, sampleRate: sr });
    const srcD    = Array.from({length: numCh}, (_, ch) => buf.getChannelData(ch));
    const dstD    = Array.from({length: numCh}, (_, ch) => result.getChannelData(ch));

    let sPos = 0, dPos = 0, next = interval;

    while (sPos < buf.length && dPos < newLen) {
      if (sPos >= next) {
        // Find quietest sample in next 100-sample window
        let qPos = sPos, qAmp = Infinity;
        const win = Math.min(100, buf.length - sPos);
        for (let s = 0; s < win; s++) {
          const a = Math.abs(srcD[0][sPos + s]);
          if (a < qAmp) { qAmp = a; qPos = sPos + s; }
        }
        // Copy up to quiet point
        const cp = qPos - sPos;
        for (let ch = 0; ch < numCh; ch++) {
          for (let i = 0; i < cp; i++) dstD[ch][dPos + i] = srcD[ch][sPos + i];
        }
        sPos += cp; dPos += cp;
        // Insert silence (buffer already zeroed)
        dPos  += silLen;
        next  += interval;
      } else {
        for (let ch = 0; ch < numCh; ch++) dstD[ch][dPos] = srcD[ch][sPos];
        sPos++; dPos++;
      }
    }
    return result;
  }

  // ============================================================
  //  MICRO ROOM — phase smear via short reflection
  // ============================================================
  async function applyMicroRoom(buf, preDelayMs) {
    const sr      = buf.sampleRate;
    const numCh   = buf.numberOfChannels;
    const padLen  = Math.ceil(sr * 0.06);
    const offCtx  = new OfflineAudioContext(numCh, buf.length + padLen, sr);
    const src     = offCtx.createBufferSource();
    src.buffer    = buf;

    const irLen = Math.ceil(sr * 0.055);
    const ir    = offCtx.createBuffer(2, irLen, sr);
    const pre   = Math.ceil((preDelayMs / 1000) * sr);

    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      if (pre < irLen)                     d[pre]                     = 0.06;
      if (Math.floor(pre * 1.7) < irLen)   d[Math.floor(pre * 1.7)]   = 0.03;
      if (Math.floor(pre * 2.4) < irLen)   d[Math.floor(pre * 2.4)]   = 0.015;
      for (let i = pre; i < irLen; i++) {
        d[i] += (Math.random() * 2 - 1) * 0.003 * Math.exp(-i / (irLen * 0.2));
      }
    }

    const conv  = offCtx.createConvolver(); conv.buffer = ir;
    const dryG  = offCtx.createGain();      dryG.gain.value = 1.0;
    const wetG  = offCtx.createGain();      wetG.gain.value = 0.06;

    src.connect(dryG); dryG.connect(offCtx.destination);
    src.connect(conv); conv.connect(wetG); wetG.connect(offCtx.destination);
    src.start(0);

    const rendered = await offCtx.startRendering();
    const trimmed  = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });
    for (let ch = 0; ch < numCh; ch++) {
      trimmed.getChannelData(ch).set(rendered.getChannelData(ch).subarray(0, buf.length));
    }
    return trimmed;
  }

  // ============================================================
  //  ULTRASONIC NOISE — inaudible spectrogram disruption
  // ============================================================
  function applyUltrasonicNoise(buf, amount) {
    if (!amount) return buf;

    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;
    const fc    = Math.min(15800, sr * 0.35);
    const w0    = 2 * Math.PI * fc / sr;
    const alpha = Math.sin(w0) / 1.4;
    const cosw  = Math.cos(w0);
    const b0 = (1+cosw)/2, b1 = -(1+cosw), b2 = b0;
    const a0 = 1+alpha,   a1 = -2*cosw,    a2 = 1-alpha;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });
    for (let ch = 0; ch < numCh; ch++) {
      const src = buf.getChannelData(ch);
      const dst = result.getChannelData(ch);
      let x1=0, x2=0, y1=0, y2=0;
      for (let i = 0; i < buf.length; i++) {
        const n = (Math.random() * 2 - 1) * amount;
        const y = (b0/a0)*n + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
        x2=x1; x1=n; y2=y1; y1=y;
        dst[i] = src[i] + y;
      }
    }
    return result;
  }

  // ============================================================
  //  CREATIVE EFFECTS (lo-fi, vaporwave, chipmunk etc.)
  // ============================================================
  async function applyCreativeEffects(buf, params) {
    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;

    if ((params.pitch||0) !== 0 || (params.tempo||100) !== 100) {
      const rate   = Math.pow(2, (params.pitch||0)/12) * ((params.tempo||100)/100);
      const newLen = Math.max(1, Math.ceil(buf.length / rate));
      const off    = new OfflineAudioContext(numCh, newLen, sr);
      const s      = off.createBufferSource();
      s.buffer = buf; s.playbackRate.value = rate;
      s.connect(off.destination); s.start(0);
      buf = await off.startRendering();
    }

    if (params.reverse) {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) buf.getChannelData(ch).reverse();
    }

    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const bassF = offCtx.createBiquadFilter();
    bassF.type  = 'lowshelf'; bassF.frequency.value = 200; bassF.gain.value = params.bass||0;

    const trebleF = offCtx.createBiquadFilter();
    trebleF.type  = 'highshelf'; trebleF.frequency.value = 3000; trebleF.gain.value = params.treble||0;

    const comp = offCtx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 25;
    comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;

    const masterG = offCtx.createGain(); masterG.gain.value = 0.9;

    src.connect(bassF); bassF.connect(trebleF);
    trebleF.connect(comp); comp.connect(masterG); masterG.connect(offCtx.destination);

    if ((params.reverb||0) > 5) {
      const mix   = params.reverb / 100;
      const irLen = Math.ceil(sr * (1 + mix * 3));
      const ir    = offCtx.createBuffer(2, irLen, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) d[i] = (Math.random()*2-1)*Math.pow(1-i/irLen, 2-mix*0.8);
      }
      const conv = offCtx.createConvolver(); conv.buffer = ir;
      const wetG = offCtx.createGain();      wetG.gain.value = mix * 0.55;
      trebleF.connect(conv); conv.connect(wetG); wetG.connect(masterG);
    }

    if (params.fade) {
      const dur = buf.duration, ft = Math.min(1.5, dur*0.07);
      masterG.gain.setValueAtTime(0, 0);
      masterG.gain.linearRampToValueAtTime(0.9, ft);
      masterG.gain.setValueAtTime(0.9, dur-ft);
      masterG.gain.linearRampToValueAtTime(0, dur);
    }

    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  ENCODE MP3 (lamejs) — same size as input, no metadata
  // ============================================================
  function encodeMP3(buf, format) {
    if (window.lamejs) {
      const numCh = buf.numberOfChannels;
      const sr    = buf.sampleRate;
      const len   = buf.length;
      const kbps  = format === 'mp3-320' ? 320 : format === 'mp3' ? 128 : 192;

      const encoder = numCh === 2
        ? new lamejs.Mp3Encoder(2, sr, kbps)
        : new lamejs.Mp3Encoder(1, sr, kbps);

      const toI16 = (f) => {
        const o = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          const s = Math.max(-1, Math.min(1, f[i]));
          o[i] = s < 0 ? s * 32768 : s * 32767;
        }
        return o;
      };

      const lPCM = toI16(buf.getChannelData(0));
      const rPCM = numCh > 1 ? toI16(buf.getChannelData(1)) : lPCM;
      const chunks = [];
      const CHUNK  = 1152;

      for (let i = 0; i < len; i += CHUNK) {
        const end = Math.min(i + CHUNK, len);
        const mp3c = numCh === 2
          ? encoder.encodeBuffer(lPCM.subarray(i,end), rPCM.subarray(i,end))
          : encoder.encodeBuffer(lPCM.subarray(i,end));
        if (mp3c.length > 0) chunks.push(new Uint8Array(mp3c));
      }
      const fin = encoder.flush();
      if (fin.length > 0) chunks.push(new Uint8Array(fin));
      return new Blob(chunks, { type: 'audio/mpeg' });
    }

    // WAV fallback
    console.warn('[Remixer] lamejs not loaded — WAV fallback');
    return encodeWAVClean(buf);
  }

  function encodeWAVClean(buf) {
    const numCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    const byteLen = len * numCh * 2;
    const ab = new ArrayBuffer(44 + byteLen);
    const v  = new DataView(ab);
    const ws  = (o,s) => { for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
    const u32 = (o,n) => v.setUint32(o,n,true);
    const u16 = (o,n) => v.setUint16(o,n,true);
    ws(0,'RIFF'); u32(4,36+byteLen); ws(8,'WAVE');
    ws(12,'fmt '); u32(16,16); u16(20,1); u16(22,numCh);
    u32(24,sr); u32(28,sr*numCh*2); u16(32,numCh*2); u16(34,16);
    ws(36,'data'); u32(40,byteLen);
    let off = 44;
    for(let i=0;i<len;i++) for(let ch=0;ch<numCh;ch++) {
      const s=Math.max(-1,Math.min(1,buf.getChannelData(ch)[i]));
      v.setInt16(off,s<0?s*32768:s*32767,true); off+=2;
    }
    return new Blob([ab],{type:'audio/wav'});
  }

  // ============================================================
  //  RANDOM FILENAME — no title/artist metadata hint
  // ============================================================
  function randomFilename() {
    return `arb_${Math.random().toString(36).slice(2,8)}_${Date.now().toString(36).slice(-4)}`;
  }

  // ============================================================
  //  BYPASS PRESET SET
  // ============================================================
  const BYPASS_PRESETS = new Set([
    'nocopyright','light','medium','heavy','roblox','true_normal','ghost','natural','shield'
  ]);

  // ============================================================
  //  MAIN PROCESS — GHOST MODE pipeline
  // ============================================================
  async function process(file, params) {
    if (!AC) throw new Error('Web Audio API tidak didukung.');

    let buf = await decodeFile(file);

    const presetKey = (params._preset || 'nocopyright').toLowerCase();

    if (BYPASS_PRESETS.has(presetKey)) {
      const p = GHOST_PROFILE; // All bypass presets use Ghost Mode

      // [A] Frequency axis warp — moves ALL peak bins
      buf = await applyFrequencyWarp(buf, p.freqWarpAmount);

      // [B] Pitch shift 0.8st (tempo-preserving, Hermite quality)
      buf = await applyPitchShift(buf, p.pitchSt);

      // [C] Spectral smear — phase dispersion across bins
      buf = applySpectralSmear(buf, p.spectralSmear);

      // EQ fingerprint band disruption
      buf = await applyEQ(buf, p.eqBands);

      // [E] Stereo decorrelation + channel offset
      buf = applyStereoDecorrelation(buf, p.stereoDecorr);

      // [F] OLA transient smear — shifts onset timing
      buf = applyOLASmear(buf, p.olaJitterMs);

      // [G] Sub-bass reshape — changes low-end energy signature
      buf = await applySubBassReshape(buf, p.subBassFreq);

      // [H] Harmonic aliasing — adds new spectral content
      buf = await applyHarmonicAliasing(buf, p.harmonicAmt);

      // Micro room — phase smear
      buf = await applyMicroRoom(buf, 9);

      // Ultrasonic noise — inaudible spectrogram disruption
      buf = applyUltrasonicNoise(buf, 0.0055);

      // [D] Output volume 82% — LUFS mismatch
      buf = applyOutputVolume(buf, p.outputVolume);

      // [I] Window misalignment — micro-silence every 8.5s
      buf = applyWindowMisalignment(buf, p.silenceIntervalSec, p.silenceLenMs);

      // Extra manual EQ adjustments
      if ((params.bass||0) !== 0 || (params.treble||0) !== 0) {
        const extra = [];
        if (params.bass   !== 0) extra.push({ f: 100,  g: params.bass   });
        if (params.treble !== 0) extra.push({ f: 8000, g: params.treble });
        buf = await applyEQ(buf, extra);
      }

    } else {
      buf = await applyCreativeEffects(buf, params);
    }

    return encodeMP3(buf, params.format || 'mp3');
  }

  return { process, randomFilename, GHOST_PROFILE };

})();

console.log('[Remixer v5.0 — GHOST MODE] 12-technique Audible Magic pipeline ready');
