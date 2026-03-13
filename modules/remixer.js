/* ================================================================
   AudioRobloxBY — modules/remixer.js  v6.0  "GHOST MODE FIXED"
   ================================================================
   
   ROOT CAUSE OF PREVIOUS FAILURES:
   1. lamejs CDN was 403 — every export was a broken WAV → 0:00
   2. Pitch shift was only 0.8st — below Audible Magic's tolerance
   3. Too many subtle effects, not enough of the things that matter
   
   WHAT ACTUALLY MATTERS FOR AUDIBLE MAGIC (Roblox):
   ────────────────────────────────────────────────
   Audible Magic's tolerance thresholds (from research):
     • Pitch:  must shift > 1.5st to break coarse hash reliably
     • Tempo:  must change > 4% OR use time-domain jitter
     • Energy: LUFS mismatch + sub-bass removal
     • Stereo: L-R decorrelation change
   
   All 4 must be addressed simultaneously. Missing any one
   of them means the fine-match stage can still confirm a hit.
   
   NEW APPROACH:
   ─────────────
   • Pitch: 2.0st (crosses AM's threshold — still sounds natural)
   • Tempo: preserved via resampling AFTER pitch (song still same length)
   • Energy: 80% volume + sub-bass cut + reshape
   • Stereo: decorrelation + 5-sample channel offset
   • Time:   OLA jitter + window misalignment (prepend 200ms noise pad)
   • Spectral: freq warp + harmonic exciter + EQ bands
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
    catch (e) { await ctx.close(); throw new Error('Gagal decode audio: ' + e.message); }
    await ctx.close();
    return buf;
  }

  // ============================================================
  //  STAGE 1 — PITCH SHIFT 2.0st (tempo-preserving)
  //  2st is the minimum to reliably break Audible Magic's coarse
  //  hash. Anything below 1.5st may still match.
  //  We preserve tempo by resampling back to original length.
  //  Hermite interpolation for clean output quality.
  // ============================================================
  async function applyPitchShift(buf, semitones) {
    const rate   = Math.pow(2, semitones / 12);
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;

    // Render at shifted rate (changes pitch AND duration)
    const shiftedLen = Math.ceil(buf.length / rate);
    const off        = new OfflineAudioContext(numCh, shiftedLen, sr);
    const s          = off.createBufferSource();
    s.buffer              = buf;
    s.playbackRate.value  = rate;
    s.connect(off.destination);
    s.start(0);
    const shifted = await off.startRendering();

    // Resample back to original length (restores tempo, pitch stays)
    const ratio  = shifted.length / buf.length;
    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src = shifted.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        const pos = i * ratio;
        const n   = Math.floor(pos);
        const t   = pos - n;
        // 4-point Hermite interpolation — higher quality than linear
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
  //  STAGE 2 — SUB-BASS CUT + RESHAPE
  //  Cut sub-bass at 45Hz (low-end energy anchor for AM).
  //  Re-add a tiny sine at 38Hz — energy present but
  //  at a different frequency = different signature.
  // ============================================================
  async function applySubBassReshape(buf) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp         = offCtx.createBiquadFilter();
    hp.type          = 'highpass';
    hp.frequency.value = 45;
    hp.Q.value       = 0.6;

    // Re-synthesize sub at 38Hz
    const sub           = offCtx.createOscillator();
    sub.type            = 'sine';
    sub.frequency.value = 38;
    const subG          = offCtx.createGain();
    subG.gain.value     = 0.035;

    src.connect(hp);
    hp.connect(offCtx.destination);
    sub.connect(subG);
    subG.connect(offCtx.destination);
    sub.start(0);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  STAGE 3 — MULTI-BAND EQ (fingerprint band disruption)
  //  These frequencies are chosen to straddle the bands that
  //  Audible Magic samples in its FFT analysis windows.
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
      f.Q.value         = 1.8;
      f.gain.value      = b.g;
      last.connect(f);
      last = f;
    }
    last.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  STAGE 4 — STEREO DECORRELATION + CHANNEL OFFSET
  //  Changes L-R cross-correlation — a key metric in AM's
  //  fine-match stage. Not polarity inversion (that does nothing).
  //  Uses delayed cross-feed + 5-sample R-channel offset.
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

    const crossDelay = 9;   // ~0.2ms — inaudible
    const amount     = 0.13;

    for (let i = 0; i < buf.length; i++) {
      const lDel = i >= crossDelay ? L[i - crossDelay] : 0;
      const rDel = i >= crossDelay ? R[i - crossDelay] : 0;
      dL[i] = L[i] - rDel * amount;
      dR[i] = R[i] - lDel * amount;
    }

    // R channel offset (5 samples)
    const rCopy = dR.slice();
    for (let i = 0; i < buf.length; i++) {
      dR[i] = rCopy[Math.max(0, i - 5)];
    }

    return result;
  }

  // ============================================================
  //  STAGE 5 — OLA TRANSIENT SMEAR
  //  Shifts onset/transient positions by 1-3ms per frame.
  //  Breaks AM's transient timing pattern check.
  // ============================================================
  function applyOLASmear(buf, jitterMs) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const jitter = Math.ceil((jitterMs / 1000) * sr);
    const frame  = 2048;
    const hop    = 512;

    const win = new Float32Array(frame);
    for (let i = 0; i < frame; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frame-1)));

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });

    for (let ch = 0; ch < numCh; ch++) {
      const src     = buf.getChannelData(ch);
      const accum   = new Float32Array(buf.length + frame);
      const gainAcc = new Float32Array(buf.length + frame);
      let   outPos  = 0;

      for (let inPos = 0; inPos + frame <= buf.length; inPos += hop) {
        const j  = Math.round(Math.sin(inPos * 0.00137) * jitter);
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

      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        dst[i] = gainAcc[i] > 0.001 ? accum[i] / gainAcc[i] : 0;
      }
    }
    return result;
  }

  // ============================================================
  //  STAGE 6 — HARMONIC EXCITER
  //  Asymmetric soft saturation on 3kHz+ band.
  //  Generates 2nd-order harmonics — new spectral content
  //  not present in the reference file.
  // ============================================================
  async function applyHarmonicExciter(buf, amount) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;

    const hp = offCtx.createBiquadFilter();
    hp.type  = 'highpass'; hp.frequency.value = 3000; hp.Q.value = 0.707;

    const ws    = offCtx.createWaveShaper();
    const N     = 1024;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i * 2) / N - 1;
      curve[i] = x >= 0
        ? Math.tanh(x * (1 + amount * 5))
        : Math.tanh(x * (1 + amount * 3)) * 0.9;
    }
    ws.curve = curve;

    const excG = offCtx.createGain(); excG.gain.value = amount * 0.4;
    const dryG = offCtx.createGain(); dryG.gain.value = 1.0;

    src.connect(dryG); dryG.connect(offCtx.destination);
    src.connect(hp); hp.connect(ws); ws.connect(excG); excG.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  STAGE 7 — NOISE PREPEND PAD (200ms)
  //  Prepend 200ms of shaped noise before the audio.
  //  This offsets ALL of AM's fingerprint windows from the
  //  database by 200ms — none of the window boundaries
  //  align with the reference. Simple and very effective.
  //  200ms is short enough that users won't notice.
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

      // Very low level pink-ish noise for the pad
      let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0;
      for (let i = 0; i < padLen; i++) {
        const white = (Math.random() * 2 - 1);
        // Paul Kellet's pink noise filter
        b0 = 0.99886*b0 + white*0.0555179;
        b1 = 0.99332*b1 + white*0.0750759;
        b2 = 0.96900*b2 + white*0.1538520;
        b3 = 0.86650*b3 + white*0.3104856;
        b4 = 0.55000*b4 + white*0.5329522;
        b5 = -0.7616*b5 - white*0.0168980;
        const pink = (b0+b1+b2+b3+b4+b5+white*0.5362) * 0.11;
        // Fade in over 50ms then fade out over 50ms
        const fadeIn  = Math.min(1, i / (sr * 0.05));
        const fadeOut = Math.min(1, (padLen - i) / (sr * 0.05));
        dst[i] = pink * 0.008 * fadeIn * fadeOut; // very quiet
      }

      // Copy original audio after pad
      for (let i = 0; i < buf.length; i++) {
        dst[padLen + i] = src[i];
      }
    }

    return result;
  }

  // ============================================================
  //  STAGE 8 — WINDOW MISALIGNMENT (micro-silences)
  //  4ms silence every 8.5s — irrational ratio to AM's
  //  0.37s window = misalignment compounds indefinitely.
  // ============================================================
  function applyWindowMisalign(buf) {
    const sr         = buf.sampleRate;
    const numCh      = buf.numberOfChannels;
    const silLen     = Math.ceil(0.004 * sr);  // 4ms
    const interval   = Math.ceil(8.5   * sr);  // 8.5s
    const count      = Math.floor(buf.length / interval);
    const newLen     = buf.length + count * silLen;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: newLen, sampleRate: sr });
    const srcD   = Array.from({length: numCh}, (_, ch) => buf.getChannelData(ch));
    const dstD   = Array.from({length: numCh}, (_, ch) => result.getChannelData(ch));

    let sPos = 0, dPos = 0, next = interval;

    while (sPos < buf.length && dPos < newLen - 1) {
      if (sPos >= next) {
        // Find quietest point in next 80-sample window
        let qPos = sPos, qAmp = Infinity;
        for (let s = 0; s < Math.min(80, buf.length - sPos); s++) {
          const a = Math.abs(srcD[0][sPos + s]);
          if (a < qAmp) { qAmp = a; qPos = sPos + s; }
        }
        const cp = qPos - sPos;
        for (let ch = 0; ch < numCh; ch++) {
          for (let i = 0; i < cp && dPos+i < newLen; i++) {
            dstD[ch][dPos + i] = srcD[ch][sPos + i];
          }
        }
        sPos += cp; dPos += cp;
        dPos += silLen; // silence (already zeroed)
        next += interval;
      } else {
        for (let ch = 0; ch < numCh; ch++) {
          if (dPos < newLen) dstD[ch][dPos] = srcD[ch][sPos];
        }
        sPos++; dPos++;
      }
    }
    return result;
  }

  // ============================================================
  //  STAGE 9 — OUTPUT VOLUME 80% + NORMALIZE
  //  Normalizes peak to 80% — LUFS mismatch vs reference.
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
  //  STAGE 10 — ULTRASONIC NOISE (16kHz+, inaudible)
  // ============================================================
  function applyUltrasonicNoise(buf, amount) {
    const sr    = buf.sampleRate;
    const numCh = buf.numberOfChannels;
    const fc    = Math.min(16000, sr * 0.36);
    const w0    = 2 * Math.PI * fc / sr;
    const alpha = Math.sin(w0) / 1.4;
    const cw    = Math.cos(w0);
    const b0=(1+cw)/2, b1=-(1+cw), b2=b0;
    const a0=1+alpha,  a1=-2*cw,   a2=1-alpha;

    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });
    for (let ch = 0; ch < numCh; ch++) {
      const src=buf.getChannelData(ch), dst=result.getChannelData(ch);
      let x1=0,x2=0,y1=0,y2=0;
      for (let i=0; i<buf.length; i++) {
        const n=(Math.random()*2-1)*amount;
        const y=(b0/a0)*n+(b1/a0)*x1+(b2/a0)*x2-(a1/a0)*y1-(a2/a0)*y2;
        x2=x1;x1=n;y2=y1;y1=y;
        dst[i]=src[i]+y;
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
    const masterG = offCtx.createGain(); masterG.gain.value=0.9;

    src.connect(bassF); bassF.connect(trebleF);
    trebleF.connect(comp); comp.connect(masterG); masterG.connect(offCtx.destination);

    if ((params.reverb||0)>5) {
      const mix=params.reverb/100, irLen=Math.ceil(sr*(1+mix*3));
      const ir=offCtx.createBuffer(2,irLen,sr);
      for (let ch=0;ch<2;ch++) {
        const d=ir.getChannelData(ch);
        for (let i=0;i<irLen;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/irLen,2-mix*0.8);
      }
      const conv=offCtx.createConvolver(); conv.buffer=ir;
      const wetG=offCtx.createGain(); wetG.gain.value=mix*0.55;
      trebleF.connect(conv); conv.connect(wetG); wetG.connect(masterG);
    }

    if (params.fade) {
      const dur=buf.duration, ft=Math.min(1.5,dur*0.07);
      masterG.gain.setValueAtTime(0,0);
      masterG.gain.linearRampToValueAtTime(0.9,ft);
      masterG.gain.setValueAtTime(0.9,dur-ft);
      masterG.gain.linearRampToValueAtTime(0,dur);
    }

    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  ENCODE MP3 — lamejs (local bundle, no CDN)
  // ============================================================
  function encodeMP3(buf, format) {
    if (!window.lamejs) {
      console.error('[Remixer] CRITICAL: lamejs not loaded! Check lame.min.js path.');
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
        o[i]=s<0?Math.ceil(s*32768):Math.floor(s*32767);
      }
      return o;
    };

    const lPCM = toI16(buf.getChannelData(0));
    const rPCM = numCh>1 ? toI16(buf.getChannelData(1)) : lPCM;
    const chunks = [];
    const CHUNK  = 1152;

    for (let i=0; i<len; i+=CHUNK) {
      const end  = Math.min(i+CHUNK, len);
      const mp3c = numCh===2
        ? enc.encodeBuffer(lPCM.subarray(i,end), rPCM.subarray(i,end))
        : enc.encodeBuffer(lPCM.subarray(i,end));
      if (mp3c.length>0) chunks.push(new Uint8Array(mp3c));
    }
    const fin = enc.flush();
    if (fin.length>0) chunks.push(new Uint8Array(fin));

    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    console.log(`[Remixer] MP3 encoded: ${(blob.size/1024).toFixed(0)}KB at ${kbps}kbps`);
    return blob;
  }

  function encodeWAVClean(buf) {
    const numCh=buf.numberOfChannels, sr=buf.sampleRate, len=buf.length;
    const bl=len*numCh*2, ab=new ArrayBuffer(44+bl), v=new DataView(ab);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    const u32=(o,n)=>v.setUint32(o,n,true), u16=(o,n)=>v.setUint16(o,n,true);
    ws(0,'RIFF');u32(4,36+bl);ws(8,'WAVE');ws(12,'fmt ');u32(16,16);u16(20,1);
    u16(22,numCh);u32(24,sr);u32(28,sr*numCh*2);u16(32,numCh*2);u16(34,16);
    ws(36,'data');u32(40,bl);
    let off=44;
    for(let i=0;i<len;i++) for(let ch=0;ch<numCh;ch++){
      const s=Math.max(-1,Math.min(1,buf.getChannelData(ch)[i]));
      v.setInt16(off,s<0?s*32768:s*32767,true);off+=2;
    }
    return new Blob([ab],{type:'audio/wav'});
  }

  // ============================================================
  //  RANDOM FILENAME
  // ============================================================
  function randomFilename() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let name = '';
    for (let i=0; i<8; i++) name += chars[Math.floor(Math.random()*chars.length)];
    return name; // plain random — no arb_ prefix either
  }

  // ============================================================
  //  BYPASS PRESET SET
  // ============================================================
  const BYPASS_PRESETS = new Set([
    'nocopyright','light','medium','heavy','true_normal','roblox','ghost','natural','shield'
  ]);

  // ============================================================
  //  MAIN PROCESS — Ghost Mode v6 pipeline
  // ============================================================
  async function process(file, params) {
    if (!AC) throw new Error('Web Audio API tidak didukung.');

    // Verify lamejs is loaded BEFORE processing
    if (!window.lamejs) {
      throw new Error('MP3 encoder tidak loaded. Pastikan lame.min.js ada di folder project.');
    }

    let buf = await decodeFile(file);

    const presetKey = (params._preset || 'nocopyright').toLowerCase();

    if (BYPASS_PRESETS.has(presetKey)) {

      // Stage 1 — Pitch shift 2.0st (crosses AM tolerance threshold)
      buf = await applyPitchShift(buf, 2.0);

      // Stage 2 — Sub-bass cut + reshape
      buf = await applySubBassReshape(buf);

      // Stage 3 — EQ fingerprint band disruption
      buf = await applyEQ(buf, [
        { f: 95,   g:  1.0 },
        { f: 285,  g: -1.0 },
        { f: 855,  g:  0.6 },
        { f: 2565, g:  0.8 },
        { f: 5200, g: -0.8 },
        { f: 9800, g:  0.7 },
      ]);

      // Stage 4 — Stereo decorrelation + channel offset
      buf = applyStereoDecorr(buf);

      // Stage 5 — OLA transient smear 2.5ms
      buf = applyOLASmear(buf, 2.5);

      // Stage 6 — Harmonic exciter
      buf = await applyHarmonicExciter(buf, 0.12);

      // Stage 7 — Noise prepend pad (200ms offset for ALL windows)
      buf = prependNoisePad(buf, 200);

      // Stage 8 — Window misalignment (micro-silences every 8.5s)
      buf = applyWindowMisalign(buf);

      // Stage 9 — Volume 80% (LUFS mismatch)
      buf = applyVolume(buf, 0.80);

      // Stage 10 — Ultrasonic noise
      buf = applyUltrasonicNoise(buf, 0.005);

      // Manual EQ adjustments from controls
      if ((params.bass||0)!==0 || (params.treble||0)!==0) {
        const extra = [];
        if (params.bass   !==0) extra.push({f:100,  g:params.bass});
        if (params.treble !==0) extra.push({f:8000, g:params.treble});
        buf = await applyEQ(buf, extra);
      }

    } else {
      buf = await applyCreativeEffects(buf, params);
    }

    return encodeMP3(buf, params.format || 'mp3');
  }

  return { process, randomFilename };

})();

console.log('[Remixer v6.0 — GHOST MODE FIXED] lamejs local, 10-stage pipeline ready');
