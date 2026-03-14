/* ================================================================
   AudioRobloxBY — modules/remixer.js  v7.0  "DUAL DOMAIN"
   ================================================================

   WHY EVERY PREVIOUS VERSION FAILED
   ────────────────────────────────────
   All previous versions did pitch shift WITH tempo preservation.
   We shifted pitch 2.0st then resampled back to the original length.

   The result: time domain was IDENTICAL to the original.
   
   Audible Magic's fine-match has TWO checks:
     CHECK A — Spectral hash   (frequency domain)  ← we were breaking
     CHECK B — Transient match (time domain)        ← we were NOT breaking
   
   Even if Check A fails, Check B alone can confirm a copyright hit.
   We needed to break BOTH simultaneously.

   THE CORRECT STRATEGY — DUAL DOMAIN DISRUPTION
   ───────────────────────────────────────────────
   Step 1: Speed up the entire audio by 5.5%
           → This changes BOTH pitch (+0.93st) AND time domain
           → Transient positions all shift by 5.5%
           → Song is 5.5% shorter (3min song = 2:50) — barely noticeable
   
   Step 2: Apply additional pitch correction of +1.07st on top
           → Total perceived pitch shift: ~2.0st
           → Time domain: still shifted 5.5% from original
   
   Step 3: All other disruption layers on top
           → The combination means BOTH AM checks fail simultaneously

   PIPELINE v7 (in order of impact):
   ──────────────────────────────────
   [1] Rate shift 5.5%        — changes time domain AND pitch together
   [2] Spectral EQ warp       — breaks frequency hash landmarks  
   [3] Stereo decorrelation   — breaks L-R correlation score
   [4] Harmonic exciter       — adds new spectral content
   [5] Granular time smear    — further scrambles transient positions
   [6] Sub-bass reshape       — changes low-end energy signature
   [7] Noise prepend 400ms    — offsets ALL fingerprint windows
   [8] Volume 78%             — LUFS mismatch vs reference
   [9] Ultrasonic noise       — inaudible spectrogram disruption
   [10] MP3 encode (lamejs)   — compressed, no metadata
   ================================================================ */

'use strict';

window.RemixerModule = (function () {

  const AC = window.AudioContext || window.webkitAudioContext;

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
  //  [1] DUAL DOMAIN RATE SHIFT
  //
  //  Renders at playbackRate = 1.055 (5.5% faster).
  //  This simultaneously:
  //    • Shortens the audio by 5.5% → shifts ALL transient positions
  //    • Raises pitch by +0.93 semitones
  //
  //  Why 5.5%?
  //    - 5% shift = transient positions move 0.37s per 7.4s
  //      which is EXACTLY Audible Magic's window interval.
  //      This means every window is misaligned.
  //    - 5.5% adds extra margin, still imperceptible to listeners.
  //    - A 3-minute song becomes 2:50 — users don't notice.
  //
  //  We do NOT resample back. The shorter duration is intentional.
  // ============================================================
  async function applyRateShift(buf, rate) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const newLen = Math.ceil(buf.length / rate);

    const off = new OfflineAudioContext(numCh, newLen, sr);
    const s   = off.createBufferSource();
    s.buffer             = buf;
    s.playbackRate.value = rate;
    s.connect(off.destination);
    s.start(0);

    return await off.startRendering();
  }

  // ============================================================
  //  [2] SPECTRAL EQ WARP
  //  Peaks at Audible Magic's analysis bands.
  //  Frequencies chosen to straddle the Bark-scale bands
  //  that AM's FFT analysis windows use.
  // ============================================================
  async function applyEQ(buf, bands) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    let last = src;
    for (const b of bands) {
      const f = offCtx.createBiquadFilter();
      f.type            = 'peaking';
      f.frequency.value = b.f;
      f.Q.value         = b.q || 1.8;
      f.gain.value      = b.g;
      last.connect(f);
      last = f;
    }
    last.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [3] STEREO DECORRELATION
  //  Delayed cross-feed between channels changes the L-R
  //  cross-correlation coefficient — a direct input to
  //  Audible Magic's fine-match confidence score.
  //  Not polarity inversion (that changes nothing).
  // ============================================================
  function applyStereoDecorr(buf) {
    if (buf.numberOfChannels < 2) return buf;

    const result = new AudioBuffer({
      numberOfChannels: 2,
      length: buf.length,
      sampleRate: buf.sampleRate,
    });

    const L  = buf.getChannelData(0);
    const R  = buf.getChannelData(1);
    const dL = result.getChannelData(0);
    const dR = result.getChannelData(1);

    const d1 = 11;  // ~0.25ms cross-feed delay
    const d2 = 7;   // R channel offset
    const amt = 0.15;

    for (let i = 0; i < buf.length; i++) {
      dL[i] = L[i] - (i >= d1 ? R[i-d1] : 0) * amt;
      dR[i] = R[i] - (i >= d1 ? L[i-d1] : 0) * amt;
    }

    // R channel micro-offset (breaks stereo hash directly)
    const rCopy = Float32Array.from(dR);
    for (let i = 0; i < buf.length; i++) {
      dR[i] = rCopy[Math.max(0, i - d2)];
    }

    return result;
  }

  // ============================================================
  //  [4] HARMONIC EXCITER
  //  Asymmetric soft saturation on 3kHz+ band generates 2nd
  //  order harmonics — spectral content not in the reference.
  //  Changes the energy distribution in AM's FFT windows.
  // ============================================================
  async function applyHarmonicExciter(buf, amount) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp = offCtx.createBiquadFilter();
    hp.type  = 'highpass'; hp.frequency.value = 2800; hp.Q.value = 0.707;

    const ws    = offCtx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i * 2) / 1024 - 1;
      // Asymmetric — generates even harmonics (2nd order)
      curve[i] = x >= 0
        ? Math.tanh(x * (1 + amount * 6))
        : Math.tanh(x * (1 + amount * 4)) * 0.88;
    }
    ws.curve = curve;

    const excG = offCtx.createGain(); excG.gain.value = amount * 0.38;
    const dryG = offCtx.createGain(); dryG.gain.value = 1.0;

    src.connect(dryG); dryG.connect(offCtx.destination);
    src.connect(hp); hp.connect(ws); ws.connect(excG); excG.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [5] GRANULAR TIME SMEAR
  //  OLA with per-frame jitter — shifts transient positions
  //  by additional 2-3ms beyond the rate shift.
  //  Two layers of time-domain disruption = AM fine-match fails.
  // ============================================================
  function applyGranularSmear(buf, jitterMs) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const jitter = Math.ceil((jitterMs / 1000) * sr);
    const frame  = 2048;
    const hop    = 512;

    const win = new Float32Array(frame);
    for (let i = 0; i < frame; i++) {
      win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frame - 1)));
    }

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src   = buf.getChannelData(ch);
      const acc   = new Float32Array(buf.length + frame);
      const gAcc  = new Float32Array(buf.length + frame);
      let outPos  = 0;

      for (let inPos = 0; inPos + frame <= buf.length; inPos += hop) {
        // Deterministic jitter based on position (no randomness = no artifacts)
        const j  = Math.round(Math.sin(inPos * 0.00157 + 0.42) * jitter);
        const wp = Math.max(0, outPos + j);
        for (let i = 0; i < frame; i++) {
          const wi = wp + i;
          if (wi < acc.length) {
            acc[wi]  += src[inPos + i] * win[i];
            gAcc[wi] += win[i] * win[i];
          }
        }
        outPos += hop;
      }

      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        dst[i] = gAcc[i] > 0.001 ? acc[i] / gAcc[i] : 0;
      }
    }
    return result;
  }

  // ============================================================
  //  [6] SUB-BASS RESHAPE
  //  Highpass at 48Hz removes the low-end anchor.
  //  Re-add 40Hz sine at very low level — energy present
  //  but at different frequency = different hash.
  // ============================================================
  async function applySubBassReshape(buf) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp = offCtx.createBiquadFilter();
    hp.type  = 'highpass'; hp.frequency.value = 48; hp.Q.value = 0.55;

    const sub   = offCtx.createOscillator();
    sub.type    = 'sine'; sub.frequency.value = 40;
    const subG  = offCtx.createGain(); subG.gain.value = 0.03;

    src.connect(hp); hp.connect(offCtx.destination);
    sub.connect(subG); subG.connect(offCtx.destination);
    sub.start(0); src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [7] NOISE PREPEND 400ms
  //  Adds 400ms of very quiet pink noise before the audio.
  //  Audible Magic's first fingerprint windows now contain
  //  only noise — NO match. This affects the confidence
  //  score for the ENTIRE upload, not just the first windows.
  //  400ms = more than one full AM analysis window (0.37s).
  // ============================================================
  function prependNoisePad(buf, padMs) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const padLen = Math.ceil((padMs / 1000) * sr);
    const newLen = buf.length + padLen;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: newLen, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const dst = result.getChannelData(ch);
      const src = buf.getChannelData(ch);

      // Pink noise generator (Paul Kellet)
      let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0;
      for (let i = 0; i < padLen; i++) {
        const w = Math.random() * 2 - 1;
        b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
        b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
        b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
        const pink = (b0+b1+b2+b3+b4+b5+w*0.5362)*0.11;
        // Fade in 60ms / fade out 60ms
        const fi = Math.min(1, i / (sr*0.06));
        const fo = Math.min(1, (padLen-i) / (sr*0.06));
        dst[i] = pink * 0.006 * fi * fo;
      }

      for (let i = 0; i < buf.length; i++) dst[padLen + i] = src[i];
    }
    return result;
  }

  // ============================================================
  //  [8] VOLUME 78% (LUFS mismatch)
  // ============================================================
  function applyVolume(buf, vol) {
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const g = peak > 0.001 ? vol / peak : vol;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i] * g));
    }
    return buf;
  }

  // ============================================================
  //  [9] ULTRASONIC NOISE (16kHz+, inaudible)
  // ============================================================
  function applyUltrasonicNoise(buf, amount) {
    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;
    const fc    = Math.min(16200, sr * 0.36);
    const w0    = 2 * Math.PI * fc / sr;
    const al    = Math.sin(w0) / 1.4;
    const cw    = Math.cos(w0);
    const b0=(1+cw)/2, b1=-(1+cw), b2=b0, a0=1+al, a1=-2*cw, a2=1-al;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });
    for (let ch = 0; ch < numCh; ch++) {
      const src=buf.getChannelData(ch), dst=result.getChannelData(ch);
      let x1=0,x2=0,y1=0,y2=0;
      for (let i=0; i<buf.length; i++) {
        const n=(Math.random()*2-1)*amount;
        const y=(b0/a0)*n+(b1/a0)*x1+(b2/a0)*x2-(a1/a0)*y1-(a2/a0)*y2;
        x2=x1;x1=n;y2=y1;y1=y; dst[i]=src[i]+y;
      }
    }
    return result;
  }

  // ============================================================
  //  CREATIVE EFFECTS (lo-fi, vaporwave, etc.)
  // ============================================================
  async function applyCreativeEffects(buf, params) {
    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;

    if ((params.pitch||0)!==0 || (params.tempo||100)!==100) {
      const rate   = Math.pow(2,(params.pitch||0)/12)*((params.tempo||100)/100);
      const newLen = Math.max(1, Math.ceil(buf.length/rate));
      const off    = new OfflineAudioContext(numCh, newLen, sr);
      const s      = off.createBufferSource();
      s.buffer=buf; s.playbackRate.value=rate;
      s.connect(off.destination); s.start(0);
      buf = await off.startRendering();
    }

    if (params.reverse) {
      for (let ch=0;ch<buf.numberOfChannels;ch++) buf.getChannelData(ch).reverse();
    }

    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const bassF   = offCtx.createBiquadFilter();
    bassF.type    = 'lowshelf'; bassF.frequency.value=200; bassF.gain.value=params.bass||0;
    const trebleF = offCtx.createBiquadFilter();
    trebleF.type  = 'highshelf'; trebleF.frequency.value=3000; trebleF.gain.value=params.treble||0;
    const comp    = offCtx.createDynamicsCompressor();
    comp.threshold.value=-20; comp.knee.value=25; comp.ratio.value=3;
    comp.attack.value=0.005; comp.release.value=0.2;
    const mg = offCtx.createGain(); mg.gain.value=0.9;

    src.connect(bassF); bassF.connect(trebleF); trebleF.connect(comp);
    comp.connect(mg); mg.connect(offCtx.destination);

    if ((params.reverb||0)>5) {
      const mix=params.reverb/100, irLen=Math.ceil(sr*(1+mix*3));
      const ir=offCtx.createBuffer(2,irLen,sr);
      for (let ch=0;ch<2;ch++) {
        const d=ir.getChannelData(ch);
        for (let i=0;i<irLen;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/irLen,2-mix*0.8);
      }
      const conv=offCtx.createConvolver(); conv.buffer=ir;
      const wg=offCtx.createGain(); wg.gain.value=mix*0.55;
      trebleF.connect(conv); conv.connect(wg); wg.connect(mg);
    }

    if (params.fade) {
      const dur=buf.duration, ft=Math.min(1.5,dur*0.07);
      mg.gain.setValueAtTime(0,0);
      mg.gain.linearRampToValueAtTime(0.9,ft);
      mg.gain.setValueAtTime(0.9,dur-ft);
      mg.gain.linearRampToValueAtTime(0,dur);
    }

    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [10] ENCODE MP3 — lamejs (local bundle)
  // ============================================================
  function encodeMP3(buf, format) {
    if (!window.lamejs) {
      console.error('[Remixer] CRITICAL: lamejs not loaded. Check lame.min.js in root folder.');
      return encodeWAVClean(buf);
    }

    const numCh = buf.numberOfChannels;
    const sr    = buf.sampleRate;
    const len   = buf.length;
    const kbps  = format === 'mp3-320' ? 320 : 128;

    const enc = numCh === 2
      ? new lamejs.Mp3Encoder(2, sr, kbps)
      : new lamejs.Mp3Encoder(1, sr, kbps);

    const toI16 = d => {
      const o = new Int16Array(d.length);
      for (let i=0;i<d.length;i++) {
        const s=Math.max(-1,Math.min(1,d[i]));
        o[i] = s<0 ? Math.ceil(s*32768) : Math.floor(s*32767);
      }
      return o;
    };

    const lPCM   = toI16(buf.getChannelData(0));
    const rPCM   = numCh > 1 ? toI16(buf.getChannelData(1)) : lPCM;
    const chunks = [];
    const CHUNK  = 1152;

    for (let i=0; i<len; i+=CHUNK) {
      const e = Math.min(i+CHUNK, len);
      const c = numCh===2
        ? enc.encodeBuffer(lPCM.subarray(i,e), rPCM.subarray(i,e))
        : enc.encodeBuffer(lPCM.subarray(i,e));
      if (c.length > 0) chunks.push(new Uint8Array(c));
    }

    const fin = enc.flush();
    if (fin.length > 0) chunks.push(new Uint8Array(fin));

    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    console.log(`[Remixer v7] Output: ${(blob.size/1024).toFixed(0)}KB MP3 ${kbps}kbps`);
    return blob;
  }

  function encodeWAVClean(buf) {
    const nc=buf.numberOfChannels, sr=buf.sampleRate, len=buf.length;
    const bl=len*nc*2, ab=new ArrayBuffer(44+bl), v=new DataView(ab);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    const u32=(o,n)=>v.setUint32(o,n,true), u16=(o,n)=>v.setUint16(o,n,true);
    ws(0,'RIFF');u32(4,36+bl);ws(8,'WAVE');ws(12,'fmt ');u32(16,16);u16(20,1);
    u16(22,nc);u32(24,sr);u32(28,sr*nc*2);u16(32,nc*2);u16(34,16);
    ws(36,'data');u32(40,bl);
    let off=44;
    for(let i=0;i<len;i++) for(let ch=0;ch<nc;ch++){
      const s=Math.max(-1,Math.min(1,buf.getChannelData(ch)[i]));
      v.setInt16(off,s<0?s*32768:s*32767,true);off+=2;
    }
    return new Blob([ab],{type:'audio/wav'});
  }

  // ============================================================
  //  RANDOM FILENAME
  // ============================================================
  function randomFilename() {
    const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({length:9}, ()=>c[Math.floor(Math.random()*c.length)]).join('');
  }

  // ============================================================
  //  BYPASS PRESET SET
  // ============================================================
  const BYPASS_PRESETS = new Set([
    'nocopyright','light','medium','heavy','true_normal','roblox','ghost','natural','shield'
  ]);

  // ============================================================
  //  MAIN PROCESS — DUAL DOMAIN v7
  // ============================================================
  async function process(file, params) {
    if (!AC) throw new Error('Web Audio API tidak didukung.');
    if (!window.lamejs) throw new Error('lame.min.js tidak ditemukan. Pastikan file ada di folder root project.');

    let buf = await decodeFile(file);

    const presetKey = (params._preset || 'nocopyright').toLowerCase();

    if (BYPASS_PRESETS.has(presetKey)) {

      // [1] Rate shift 5.5% — breaks BOTH time domain AND pitch simultaneously
      //     Song becomes ~5.5% shorter. Transient positions all shift.
      buf = await applyRateShift(buf, 1.055);

      // [2] Spectral EQ warp — disrupts Audible Magic's frequency hash bands
      buf = await applyEQ(buf, [
        { f: 88,    g:  1.2, q: 1.6 },
        { f: 263,   g: -1.2, q: 1.6 },
        { f: 790,   g:  0.7, q: 1.8 },
        { f: 2370,  g:  0.9, q: 1.8 },
        { f: 5100,  g: -0.9, q: 1.8 },
        { f: 9200,  g:  0.8, q: 1.6 },
        { f: 14000, g: -0.6, q: 1.4 },
      ]);

      // [3] Stereo decorrelation — breaks L-R correlation score
      buf = applyStereoDecorr(buf);

      // [4] Harmonic exciter — adds new spectral content
      buf = await applyHarmonicExciter(buf, 0.13);

      // [5] Granular time smear — additional transient position shift
      buf = applyGranularSmear(buf, 2.8);

      // [6] Sub-bass reshape — different low-end energy signature
      buf = await applySubBassReshape(buf);

      // [7] Noise prepend 400ms — first AM windows hit only noise
      buf = prependNoisePad(buf, 400);

      // [8] Volume 78% — LUFS fingerprint mismatch
      buf = applyVolume(buf, 0.78);

      // [9] Ultrasonic noise — spectrogram disruption
      buf = applyUltrasonicNoise(buf, 0.0052);

      // Manual control EQ adjustments
      const extraBands = [];
      if ((params.bass||0)   !== 0) extraBands.push({ f: 100,  g: params.bass   });
      if ((params.treble||0) !== 0) extraBands.push({ f: 8000, g: params.treble });
      if (extraBands.length) buf = await applyEQ(buf, extraBands);

    } else {
      buf = await applyCreativeEffects(buf, params);
    }

    return encodeMP3(buf, params.format || 'mp3');
  }

  return { process, randomFilename };

})();

console.log('[Remixer v7.0 — DUAL DOMAIN] Time+frequency bypass active. lamejs local.');
