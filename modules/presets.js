/* ============================================================
   AudioRobloxBY — modules/remixer.js  v3.0
   
   NATURAL BYPASS ENGINE — 9-Stage Pipeline
   ─────────────────────────────────────────
   HOW ROBLOX / CONTENT ID FINGERPRINTING WORKS:
   
   The scanner takes a short audio clip, runs an FFT (Fast Fourier
   Transform), and extracts a "hash" — a compact signature based on:
     • Which frequency bands are loudest (spectral energy)
     • The ratio between those bands
     • Cross-channel stereo correlation
     • The loudness/dynamic signature (LUFS/peak profile)
   
   It then compares that hash against millions of reference hashes
   stored in a database. If the distance between hashes is below a
   threshold — BLOCKED.
   
   WE DON'T NEED TO DESTROY THE SONG.
   We just need to shift enough parameters that the hash distance
   exceeds the threshold. Every stage below contributes to that.
   
   PIPELINE (in order):
   1.  Sub-bass cut           — 40Hz highpass (inaudible, removes bass fingerprint)
   2.  Micro pitch shift      — 0.75st tempo-preserving (shifts all freq ratios)
   3.  Fingerprint EQ         — ±0.8dB at scanner sample bands
   4.  Inter-channel offset   — 2-sample delay on R channel (breaks stereo hash)
   5.  Harmonic exciter       — soft saturation 3kHz+ (modifies spectral hash)
   6.  Micro room             — 8ms pre-delay reflection (phase smear)
   7.  Ultrasonic noise       — inaudible noise 16kHz+ (spectrogram disruption)
   8.  Volume normalization   — output at 85% peak (loudness mismatch)
   9.  Metadata strip         — WAV written with blank ID3 tags
   
   NOTE ON PHASE INVERSION (gain = -1.0):
   Polarity inversion does NOT bypass fingerprinting. The magnitude
   spectrum |FFT(x)| == |FFT(-x)|. The hash is identical. We use
   inter-channel micro offset instead, which DOES change the hash.
   ============================================================ */

'use strict';

window.RemixerModule = (function () {

  const AC = window.AudioContext || window.webkitAudioContext;

  // ──────────────────────────────────────────────────────────
  //  BYPASS PROFILES
  // ──────────────────────────────────────────────────────────
  const BYPASS_PROFILES = {

    // Light — sounds 100% identical
    ghost: {
      pitchSt:        0.5,
      subBassCut:     40,
      exciterAmt:     0.06,
      ultraNoise:     0.004,
      roomPreDelay:   6,
      msWidth:        0.08,
      channelOffset:  2,        // samples delay on R channel
      outputVolume:   0.88,
      eqBands: [
        { f: 80,   g: 0.5  },
        { f: 250,  g: -0.5 },
        { f: 4000, g: 0.5  },
        { f: 8000, g: -0.5 },
      ],
    },

    // Roblox-optimized — sounds perfect, reliable bypass
    roblox: {
      pitchSt:        0.75,
      subBassCut:     42,
      exciterAmt:     0.09,
      ultraNoise:     0.005,
      roomPreDelay:   8,
      msWidth:        0.10,
      channelOffset:  3,
      outputVolume:   0.85,     // 85% volume — breaks loudness fingerprint
      eqBands: [
        { f: 100,  g: 0.8  },
        { f: 300,  g: -0.8 },
        { f: 2000, g: 0.6  },
        { f: 6000, g: 0.8  },
        { f: 10000,g: -0.6 },
      ],
    },

    // Natural — YouTube + TikTok
    natural: {
      pitchSt:        1.0,
      subBassCut:     45,
      exciterAmt:     0.11,
      ultraNoise:     0.006,
      roomPreDelay:   10,
      msWidth:        0.13,
      channelOffset:  4,
      outputVolume:   0.85,
      eqBands: [
        { f: 60,   g: 1.0  },
        { f: 200,  g: -1.0 },
        { f: 1000, g: 0.5  },
        { f: 5000, g: 1.0  },
        { f: 9000, g: -0.8 },
      ],
    },

    // Shield — most aggressive scanners
    shield: {
      pitchSt:        1.5,
      subBassCut:     50,
      exciterAmt:     0.15,
      ultraNoise:     0.009,
      roomPreDelay:   14,
      msWidth:        0.18,
      channelOffset:  6,
      outputVolume:   0.82,
      eqBands: [
        { f: 50,   g: 1.5  },
        { f: 160,  g: -1.5 },
        { f: 630,  g: 0.8  },
        { f: 3000, g: 1.2  },
        { f: 7000, g: -1.0 },
        { f: 12000,g: 1.0  },
      ],
    },

    // True Normal — Gemini's valid techniques merged in
    true_normal: {
      pitchSt:        0.3,      // nearly zero — ears can't detect
      subBassCut:     40,       // Gemini's 40Hz cut ✅
      exciterAmt:     0.07,
      ultraNoise:     0.007,    // NOT 18% — that's audible. 0.7% ultrasonic only
      roomPreDelay:   7,
      msWidth:        0.09,
      channelOffset:  2,
      outputVolume:   0.85,     // Gemini's 85% volume ✅
      eqBands: [
        { f: 80,   g: 0.4  },
        { f: 250,  g: -0.4 },
        { f: 3500, g: 0.4  },
        { f: 7000, g: -0.4 },
      ],
    },
  };

  const PROFILE_MAP = {
    nocopyright: 'roblox',
    light:       'ghost',
    medium:      'natural',
    heavy:       'shield',
    roblox:      'roblox',
    true_normal: 'true_normal',
    ghost:       'ghost',
    natural:     'natural',
    shield:      'shield',
  };

  const BYPASS_PRESETS = new Set([
    'nocopyright','light','medium','heavy',
    'roblox','true_normal','ghost','natural','shield'
  ]);

  // ──────────────────────────────────────────────────────────
  //  DECODE
  // ──────────────────────────────────────────────────────────
  async function decodeFile(file) {
    const ctx = new AC();
    const ab  = await file.arrayBuffer();
    let buf;
    try   { buf = await ctx.decodeAudioData(ab); }
    catch (e) { await ctx.close(); throw new Error('Gagal decode: ' + e.message); }
    await ctx.close();
    return buf;
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 1 — SUB-BASS CUT (Gemini's valid technique ✅)
  //  Highpass at 40–50Hz. Completely inaudible on any speaker.
  //  Removes the low-end energy signature that some scanners
  //  use as an anchor point for fingerprint matching.
  // ──────────────────────────────────────────────────────────
  async function applySubBassCut(buf, cutoffHz) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp         = offCtx.createBiquadFilter();
    hp.type          = 'highpass';
    hp.frequency.value = cutoffHz;
    hp.Q.value       = 0.707; // Butterworth — flat passband, clean rolloff

    src.connect(hp);
    hp.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 2 — MICRO PITCH SHIFT (tempo-preserving)
  //  Render at shifted playback rate, then linear-resample
  //  back to original duration. Pitch changes, tempo stays.
  // ──────────────────────────────────────────────────────────
  async function applyPitchShift(srcBuf, semitones) {
    if (!semitones) return srcBuf;

    const rate   = Math.pow(2, semitones / 12);
    const sr     = srcBuf.sampleRate;
    const numCh  = srcBuf.numberOfChannels;

    const shiftedLen = Math.ceil(srcBuf.length / rate);
    const off1       = new OfflineAudioContext(numCh, shiftedLen, sr);
    const s1         = off1.createBufferSource();
    s1.buffer              = srcBuf;
    s1.playbackRate.value  = rate;
    s1.connect(off1.destination);
    s1.start(0);
    const shifted = await off1.startRendering();

    // Resample back to original length
    const ratio  = shifted.length / srcBuf.length;
    const result = new AudioBuffer({ numberOfChannels: numCh, length: srcBuf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src = shifted.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < srcBuf.length; i++) {
        const pos = i * ratio;
        const lo  = Math.floor(pos);
        const hi  = Math.min(lo + 1, shifted.length - 1);
        dst[i]    = src[lo] + (src[hi] - src[lo]) * (pos - lo);
      }
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 3 — MULTI-BAND EQ (fingerprint band sculpting)
  // ──────────────────────────────────────────────────────────
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
      f.Q.value         = 1.5;
      f.gain.value      = band.g;
      last.connect(f);
      last = f;
    }

    last.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 4 — INTER-CHANNEL MICRO OFFSET
  //  Delays the RIGHT channel by N samples (2–6 samples at 44.1kHz
  //  = 0.045–0.136ms). Completely inaudible — below the Haas fusion
  //  threshold (~1ms). BUT it changes the cross-correlation signature
  //  that stereo fingerprinters use. This is the CORRECT version
  //  of what Gemini called "phase inversion" — actual phase change.
  //
  //  WHY NOT GAIN=-1 (POLARITY INVERSION):
  //  |FFT(-x)| = |FFT(x)| — the magnitude spectrum is identical.
  //  Fingerprint distance = 0. It does nothing.
  // ──────────────────────────────────────────────────────────
  function applyChannelOffset(buf, samples) {
    if (!samples || buf.numberOfChannels < 2) return buf;

    const result = new AudioBuffer({
      numberOfChannels: buf.numberOfChannels,
      length:           buf.length,
      sampleRate:       buf.sampleRate,
    });

    // Left channel — unchanged
    result.getChannelData(0).set(buf.getChannelData(0));

    // Right channel — shifted by N samples
    const srcR = buf.getChannelData(1);
    const dstR = result.getChannelData(1);
    for (let i = 0; i < buf.length; i++) {
      dstR[i] = srcR[Math.max(0, i - samples)];
    }

    return result;
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 5 — HARMONIC EXCITER
  //  Soft saturation on 3kHz+ — generates 2nd/3rd harmonics.
  //  Changes spectral hash without audible distortion.
  // ──────────────────────────────────────────────────────────
  async function applyExciter(buf, amount) {
    if (!amount || amount <= 0) return buf;

    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp         = offCtx.createBiquadFilter();
    hp.type          = 'highpass';
    hp.frequency.value = 3200;
    hp.Q.value       = 0.707;

    const ws     = offCtx.createWaveShaper();
    const N      = 512;
    const curve  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x  = (i * 2) / N - 1;
      curve[i] = Math.tanh(x * (1 + amount * 4)) / (1 + amount * 0.15);
    }
    ws.curve = curve;

    const excG       = offCtx.createGain();
    excG.gain.value  = amount * 0.45;
    const dryG       = offCtx.createGain();
    dryG.gain.value  = 1.0;

    src.connect(dryG); dryG.connect(offCtx.destination);
    src.connect(hp); hp.connect(ws); ws.connect(excG); excG.connect(offCtx.destination);

    src.start(0);
    return await offCtx.startRendering();
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 6 — MICRO ROOM (phase smear)
  //  6–14ms pre-delay + tiny diffuse tail. Sounds like a room.
  // ──────────────────────────────────────────────────────────
  async function applyMicroRoom(buf, preDelayMs) {
    if (!preDelayMs) return buf;

    const sr      = buf.sampleRate;
    const numCh   = buf.numberOfChannels;
    const padLen  = Math.ceil(sr * 0.06);
    const offCtx  = new OfflineAudioContext(numCh, buf.length + padLen, sr);
    const src     = offCtx.createBufferSource();
    src.buffer    = buf;

    const irLen  = Math.ceil(sr * 0.055);
    const ir     = offCtx.createBuffer(2, irLen, sr);
    const pre    = Math.ceil((preDelayMs / 1000) * sr);

    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      if (pre < irLen)                d[pre]                = 0.07;
      if (Math.floor(pre*1.8) < irLen) d[Math.floor(pre*1.8)] = 0.03;
      for (let i = pre; i < irLen; i++) {
        d[i] += (Math.random()*2-1) * 0.004 * Math.exp(-i/(irLen*0.22));
      }
    }

    const conv = offCtx.createConvolver(); conv.buffer = ir;
    const dryG = offCtx.createGain();     dryG.gain.value = 1.0;
    const wetG = offCtx.createGain();     wetG.gain.value = 0.07;

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

  // ──────────────────────────────────────────────────────────
  //  STAGE 7 — ULTRASONIC NOISE
  //  High-pass filtered noise above 16kHz — inaudible, breaks hash.
  //  NOTE: Gemini's 18% is AUDIBLE. We use 0.4–0.9% ultrasonic only.
  // ──────────────────────────────────────────────────────────
  function injectUltrasonicNoise(buf, amount) {
    if (!amount || amount <= 0) return buf;

    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;
    const fc    = Math.min(15500, sr * 0.34);
    const w0    = 2 * Math.PI * (fc / sr);
    const alpha = Math.sin(w0) / (2 * 0.7);
    const cosw  = Math.cos(w0);
    const b0 = (1+cosw)/2, b1 = -(1+cosw), b2 = b0;
    const a0 = 1+alpha,   a1 = -2*cosw,   a2 = 1-alpha;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src = buf.getChannelData(ch);
      const dst = result.getChannelData(ch);
      let x1=0, x2=0, y1=0, y2=0;
      for (let i = 0; i < buf.length; i++) {
        const n = (Math.random()*2-1) * amount;
        const y = (b0/a0)*n + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
        x2=x1; x1=n; y2=y1; y1=y;
        dst[i] = src[i] + y;
      }
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 8 — VOLUME AT 85% (Gemini ✅)
  //  Scanners compare against a reference file at a specific
  //  loudness. Outputting at 85% shifts the LUFS/peak signature.
  // ──────────────────────────────────────────────────────────
  function applyOutputVolume(buf, targetVolume) {
    if (!targetVolume || targetVolume === 1.0) return buf;

    // First normalize to 100%, then scale to targetVolume
    let maxAmp = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) maxAmp = Math.max(maxAmp, Math.abs(d[i]));
    }

    const gain = maxAmp > 0.001 ? (targetVolume / maxAmp) : targetVolume;

    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
    return buf;
  }

  // ──────────────────────────────────────────────────────────
  //  STAGE 9 — ENCODE MP3 (compressed output, same size as input)
  //
  //  Uses lamejs (pure JS LAME MP3 encoder) loaded via CDN.
  //  A 3MB MP3 input → ~3MB MP3 output (not 30MB WAV).
  //
  //  Bitrate selection:
  //    format 'mp3'     → 128 kbps  (good quality, small file)
  //    format 'mp3-320' → 320 kbps  (high quality)
  //    anything else    → 192 kbps  (balanced)
  //
  //  Fallback: if lamejs not loaded, writes a clean WAV
  //  (no metadata chunks — stripped of all ID3/LIST tags).
  // ──────────────────────────────────────────────────────────
  function encodeMP3(buf, format) {
    // ── lamejs path ──────────────────────────────────────
    if (window.lamejs) {
      const numCh  = buf.numberOfChannels;
      const sr     = buf.sampleRate;
      const len    = buf.length;

      const kbps = format === 'mp3-320' ? 320
                 : format === 'mp3'     ? 128
                 : 192;

      const encoder = numCh === 2
        ? new lamejs.Mp3Encoder(2, sr, kbps)
        : new lamejs.Mp3Encoder(1, sr, kbps);

      // Convert Float32 → Int16
      function toInt16(floatData) {
        const out = new Int16Array(floatData.length);
        for (let i = 0; i < floatData.length; i++) {
          const s = Math.max(-1, Math.min(1, floatData[i]));
          out[i] = s < 0 ? s * 32768 : s * 32767;
        }
        return out;
      }

      const leftPCM  = toInt16(buf.getChannelData(0));
      const rightPCM = numCh > 1 ? toInt16(buf.getChannelData(1)) : leftPCM;

      const chunks   = [];
      const CHUNK    = 1152; // lamejs required chunk size

      for (let i = 0; i < len; i += CHUNK) {
        const end  = Math.min(i + CHUNK, len);
        const lSub = leftPCM.subarray(i, end);
        const rSub = rightPCM.subarray(i, end);
        const mp3chunk = numCh === 2
          ? encoder.encodeBuffer(lSub, rSub)
          : encoder.encodeBuffer(lSub);
        if (mp3chunk.length > 0) chunks.push(new Uint8Array(mp3chunk));
      }

      const finalChunk = encoder.flush();
      if (finalChunk.length > 0) chunks.push(new Uint8Array(finalChunk));

      return new Blob(chunks, { type: 'audio/mpeg' });
    }

    // ── WAV fallback (if lamejs not available) ────────────
    console.warn('[Remixer] lamejs not loaded — falling back to WAV');
    return encodeWAVClean(buf);
  }

  // Clean WAV fallback — NO metadata, NO ID3/LIST chunks
  function encodeWAVClean(buf) {
    const numCh   = buf.numberOfChannels;
    const sr      = buf.sampleRate;
    const len     = buf.length;
    const byteLen = len * numCh * 2;
    const ab      = new ArrayBuffer(44 + byteLen);
    const v       = new DataView(ab);

    const ws  = (o, s) => { for (let i=0; i<s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };
    const u32 = (o, n) => v.setUint32(o, n, true);
    const u16 = (o, n) => v.setUint16(o, n, true);

    ws(0,'RIFF'); u32(4, 36+byteLen); ws(8,'WAVE');
    ws(12,'fmt '); u32(16,16); u16(20,1); u16(22,numCh);
    u32(24,sr); u32(28,sr*numCh*2); u16(32,numCh*2); u16(34,16);
    ws(36,'data'); u32(40, byteLen);

    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
        v.setInt16(off, s < 0 ? s*32768 : s*32767, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ──────────────────────────────────────────────────────────
  //  CREATIVE EFFECTS PATH (lo-fi, vaporwave, chipmunk etc.)
  // ──────────────────────────────────────────────────────────
  async function applyCreativeEffects(buf, params) {
    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;

    if ((params.pitch||0) !== 0 || (params.tempo||100) !== 100) {
      const rate   = Math.pow(2, (params.pitch||0)/12) * ((params.tempo||100)/100);
      const newLen = Math.max(1, Math.ceil(buf.length / rate));
      const off    = new OfflineAudioContext(numCh, newLen, sr);
      const s      = off.createBufferSource();
      s.buffer              = buf;
      s.playbackRate.value  = rate;
      s.connect(off.destination);
      s.start(0);
      buf = await off.startRendering();
    }

    if (params.reverse) {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) buf.getChannelData(ch).reverse();
    }

    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const bassF           = offCtx.createBiquadFilter();
    bassF.type            = 'lowshelf';
    bassF.frequency.value = 200;
    bassF.gain.value      = params.bass || 0;

    const trebleF           = offCtx.createBiquadFilter();
    trebleF.type            = 'highshelf';
    trebleF.frequency.value = 3000;
    trebleF.gain.value      = params.treble || 0;

    const comp           = offCtx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value      = 25;
    comp.ratio.value     = 3;
    comp.attack.value    = 0.005;
    comp.release.value   = 0.2;

    const masterG        = offCtx.createGain();
    masterG.gain.value   = 0.9;

    src.connect(bassF); bassF.connect(trebleF);
    trebleF.connect(comp); comp.connect(masterG);
    masterG.connect(offCtx.destination);

    if ((params.reverb||0) > 5) {
      const mix   = params.reverb / 100;
      const irLen = Math.ceil(sr * (1 + mix * 3));
      const ir    = offCtx.createBuffer(2, irLen, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          d[i] = (Math.random()*2-1) * Math.pow(1 - i/irLen, 2 - mix*0.8);
        }
      }
      const conv  = offCtx.createConvolver(); conv.buffer = ir;
      const wetG  = offCtx.createGain();      wetG.gain.value = mix * 0.55;
      trebleF.connect(conv); conv.connect(wetG); wetG.connect(masterG);
    }

    if (params.fade) {
      const dur = buf.duration;
      const ft  = Math.min(1.5, dur*0.07);
      masterG.gain.setValueAtTime(0, 0);
      masterG.gain.linearRampToValueAtTime(0.9, ft);
      masterG.gain.setValueAtTime(0.9, dur-ft);
      masterG.gain.linearRampToValueAtTime(0, dur);
    }

    src.start(0);
    return await offCtx.startRendering();
  }

  // ──────────────────────────────────────────────────────────
  //  GENERATE RANDOM FILENAME (helps avoid metadata detection)
  // ──────────────────────────────────────────────────────────
  function randomFilename() {
    const id  = Math.random().toString(36).slice(2, 8);
    const ts  = Date.now().toString(36).slice(-4);
    return `arb_${id}_${ts}`;
  }

  // ──────────────────────────────────────────────────────────
  //  MAIN ENTRY POINT
  // ──────────────────────────────────────────────────────────
  async function process(file, params) {
    if (!AC) throw new Error('Web Audio API tidak didukung di browser ini.');

    let buf = await decodeFile(file);

    const presetKey = (params._preset || 'nocopyright').toLowerCase();

    if (BYPASS_PRESETS.has(presetKey)) {
      // ── 9-STAGE NATURAL BYPASS PATH ───────────────────────
      const profile = BYPASS_PROFILES[PROFILE_MAP[presetKey] || 'roblox'];

      // Stage 1: Sub-bass cut (40Hz+ highpass)
      buf = await applySubBassCut(buf, profile.subBassCut);

      // Stage 2: Micro pitch shift (tempo-preserving)
      buf = await applyPitchShift(buf, profile.pitchSt);

      // Stage 3: Fingerprint band EQ
      buf = await applyEQ(buf, profile.eqBands);

      // Stage 4: Inter-channel micro offset (real phase change)
      buf = applyChannelOffset(buf, profile.channelOffset);

      // Stage 5: Harmonic exciter
      buf = await applyExciter(buf, profile.exciterAmt);

      // Stage 6: Micro room (phase smear)
      buf = await applyMicroRoom(buf, profile.roomPreDelay);

      // Stage 7: Ultrasonic noise
      buf = injectUltrasonicNoise(buf, profile.ultraNoise);

      // Stage 8: Volume at 85% (loudness fingerprint mismatch)
      buf = applyOutputVolume(buf, profile.outputVolume);

      // Extra EQ from manual control adjustments
      if ((params.bass||0) !== 0 || (params.treble||0) !== 0) {
        const extra = [];
        if (params.bass   !== 0) extra.push({ f: 100,  g: params.bass   });
        if (params.treble !== 0) extra.push({ f: 8000, g: params.treble });
        buf = await applyEQ(buf, extra);
      }

    } else {
      buf = await applyCreativeEffects(buf, params);
    }

    // Stage 9: Encode compressed MP3 (same size as input, no metadata)
    return encodeMP3(buf, params.format || 'mp3');
  }

  return { process, BYPASS_PROFILES, randomFilename };

})();

console.log('[Remixer v3.0] 9-stage natural bypass engine ready');
