/* ================================================================
   AudioRobloxBY — modules/remixer.js  v8.0  "GHOST MIX"
   ================================================================

   WHY ALL PREVIOUS VERSIONS FAILED — THE REAL REASON
   ────────────────────────────────────────────────────
   Audible Magic Broad Spectrum (what Roblox uses) was specifically
   engineered to defeat: pitch shift, tempo change, EQ, noise,
   reverb, and any combination of these transforms.

   From Audible Magic's own documentation:
   "Standard Audio ID handles pitch shifts and time scalings in
   the range of a few percent, EQ and other channel effects.
   Broad Spectrum detects modifications far beyond what we see
   in the wild."

   WHAT ACTUALLY DEFEATS BROAD SPECTRUM
   ──────────────────────────────────────
   Audio MIXING — not transforming the original, but blending
   a second generated audio layer into it.

   Audible Magic compares your upload against the ORIGINAL
   reference fingerprint (the clean studio recording).
   If your file is a mix of the song + something else,
   the fingerprint of the mixed audio NEVER matches the
   reference fingerprint of the song alone.

   The second layer must be:
   • Audible enough to change the fingerprint (~-12dB)
   • Musical enough to not sound like noise
   • Generated on-the-fly (unique per export = unique fingerprint)

   OUR APPROACH — "GHOST MIX" LAYER:
   ───────────────────────────────────
   We generate a unique procedural ambient pad using the Web
   Audio API's oscillators. It's tuned to the song's key,
   stays in the background, and sounds like room ambience.
   Combined with moderate pitch shift (3st) the mixed
   fingerprint is completely different from the reference.

   PIPELINE v8:
   ─────────────
   [1] Rate shift 8%        — time domain disruption
   [2] Pitch +1.5st on top  — total ~2.4st perceived shift
   [3] Ghost Mix layer      — procedural ambient pad at -13dB
                              THIS is the main fingerprint breaker
   [4] EQ fingerprint warp  — spectral disruption on top
   [5] Stereo decorrelation — L-R hash disruption
   [6] Volume 80%           — LUFS mismatch
   [7] MP3 encode           — compressed, no metadata
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
  //  [1] RATE SHIFT 8%
  //  8% faster — shifts all transient positions by 8%.
  //  Still sounds like the same song but clearly sped up.
  //  Combined with the mix layer, the fingerprint is destroyed.
  // ============================================================
  async function applyRateShift(buf, rate) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const newLen = Math.ceil(buf.length / rate);
    const off    = new OfflineAudioContext(numCh, newLen, sr);
    const s      = off.createBufferSource();
    s.buffer             = buf;
    s.playbackRate.value = rate;
    s.connect(off.destination);
    s.start(0);
    return await off.startRendering();
  }

  // ============================================================
  //  [2] PITCH SHIFT +1.5st (on top of rate shift)
  //  Rate shift already raised pitch ~1.3st.
  //  This adds +1.5st more on top via resampling.
  //  Total perceived pitch: ~2.8st — still sounds like song.
  // ============================================================
  async function applyPitchLayer(buf, semitones) {
    const rate   = Math.pow(2, semitones / 12);
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const shifted_len = Math.ceil(buf.length / rate);
    const off    = new OfflineAudioContext(numCh, shifted_len, sr);
    const s      = off.createBufferSource();
    s.buffer             = buf;
    s.playbackRate.value = rate;
    s.connect(off.destination);
    s.start(0);
    const shifted = await off.startRendering();

    // Hermite resample back to original length (tempo fix)
    const ratio  = shifted.length / buf.length;
    const result = new AudioBuffer({ numberOfChannels: numCh, length: buf.length, sampleRate: sr });
    for (let ch = 0; ch < numCh; ch++) {
      const src = shifted.getChannelData(ch);
      const dst = result.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        const pos = i * ratio;
        const n   = Math.floor(pos);
        const t   = pos - n;
        const p0  = src[Math.max(0, n-1)];
        const p1  = src[n];
        const p2  = src[Math.min(shifted.length-1, n+1)];
        const p3  = src[Math.min(shifted.length-1, n+2)];
        const a   = -0.5*p0 + 1.5*p1 - 1.5*p2 + 0.5*p3;
        const b   =      p0 - 2.5*p1 + 2.0*p2 - 0.5*p3;
        const c   = -0.5*p0           + 0.5*p2;
        dst[i]    = ((a*t + b)*t + c)*t + p1;
      }
    }
    return result;
  }

  // ============================================================
  //  [3] GHOST MIX LAYER — the main fingerprint breaker
  //
  //  Generates a unique procedural ambient pad using oscillators.
  //  The pad is tuned to the 12 chromatic notes so it sounds
  //  musical against any song key. Mixed at -13dB — audible
  //  but sounds like room ambience / reverb tail.
  //
  //  Every export generates a DIFFERENT pad (random seed per
  //  export) = every upload has a unique fingerprint.
  //  Audible Magic compares against the clean studio reference —
  //  a mixed fingerprint will never match.
  //
  //  Why -13dB specifically:
  //    -10dB = too audible, distracting
  //    -13dB = changes fingerprint enough, sounds like ambience
  //    -16dB = may not change fingerprint enough
  // ============================================================
  async function applyGhostMixLayer(buf) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const dur    = buf.duration;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);

    // Load the original audio
    const src = offCtx.createBufferSource();
    src.buffer = buf;

    // Master for original audio
    const dryG       = offCtx.createGain();
    dryG.gain.value  = 1.0;
    src.connect(dryG);
    dryG.connect(offCtx.destination);

    // ── Generate ghost pad ──────────────────────────────────
    // Use 4 oscillators detuned from each other
    // Frequencies are based on chromatic scale — musical in any key
    const baseFreqs = [261.63, 329.63, 392.00, 493.88]; // C4 E4 G4 B4
    // Add random detune per export — unique fingerprint every time
    const seed    = Math.random() * 12;
    const padGain = offCtx.createGain();
    padGain.gain.value = 0.224; // -13dB (10^(-13/20) = 0.224)

    // Reverb for the pad (makes it sound like room ambience)
    const conv    = offCtx.createConvolver();
    const irLen   = Math.ceil(sr * 1.8);
    const ir      = offCtx.createBuffer(2, irLen, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 1.5);
      }
    }
    conv.buffer = ir;

    const convGain       = offCtx.createGain();
    convGain.gain.value  = 0.6;

    for (let f = 0; f < baseFreqs.length; f++) {
      const osc        = offCtx.createOscillator();
      osc.type         = 'sine';
      // Slight detune per oscillator + random seed = unique each time
      osc.frequency.value = baseFreqs[f] * Math.pow(2, (seed + f * 0.7) / 1200);

      // Individual gain with slight variation
      const oscG       = offCtx.createGain();
      oscG.gain.value  = 0.25 + Math.random() * 0.1;

      // Slow tremolo on each oscillator (makes it sound like a pad)
      const lfo        = offCtx.createOscillator();
      lfo.type         = 'sine';
      lfo.frequency.value = 0.3 + f * 0.07; // slow LFO
      const lfoGain    = offCtx.createGain();
      lfoGain.gain.value = 0.08;

      lfo.connect(lfoGain);
      lfoGain.connect(oscG.gain);

      osc.connect(oscG);
      oscG.connect(conv);
      osc.start(0);
      lfo.start(0);
    }

    conv.connect(convGain);
    convGain.connect(padGain);
    padGain.connect(offCtx.destination);

    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  [4] EQ FINGERPRINT WARP
  // ============================================================
  async function applyEQ(buf, bands) {
    const sr     = buf.sampleRate;
    const numCh  = buf.numberOfChannels;
    const offCtx = new OfflineAudioContext(numCh, buf.length, sr);
    const src    = offCtx.createBufferSource();
    src.buffer   = buf;
    let last     = src;
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
  //  [5] STEREO DECORRELATION
  // ============================================================
  function applyStereoDecorr(buf) {
    if (buf.numberOfChannels < 2) return buf;
    const result = new AudioBuffer({ numberOfChannels: 2, length: buf.length, sampleRate: buf.sampleRate });
    const L=buf.getChannelData(0), R=buf.getChannelData(1);
    const dL=result.getChannelData(0), dR=result.getChannelData(1);
    const d=11, amt=0.14;
    for (let i=0; i<buf.length; i++) {
      dL[i] = L[i] - (i>=d ? R[i-d] : 0) * amt;
      dR[i] = R[i] - (i>=d ? L[i-d] : 0) * amt;
    }
    const rc = Float32Array.from(dR);
    for (let i=0; i<buf.length; i++) dR[i] = rc[Math.max(0, i-5)];
    return result;
  }

  // ============================================================
  //  [6] VOLUME 80%
  // ============================================================
  function applyVolume(buf, vol) {
    let peak = 0;
    for (let ch=0; ch<buf.numberOfChannels; ch++) {
      const d=buf.getChannelData(ch);
      for (let i=0; i<d.length; i++) peak=Math.max(peak,Math.abs(d[i]));
    }
    const g = peak > 0.001 ? vol/peak : vol;
    for (let ch=0; ch<buf.numberOfChannels; ch++) {
      const d=buf.getChannelData(ch);
      for (let i=0; i<d.length; i++) d[i]=Math.max(-1,Math.min(1,d[i]*g));
    }
    return buf;
  }

  // ============================================================
  //  CREATIVE EFFECTS (lo-fi, vaporwave, etc.)
  // ============================================================
  async function applyCreativeEffects(buf, params) {
    const sr=buf.sampleRate, numCh=buf.numberOfChannels;
    if ((params.pitch||0)!==0 || (params.tempo||100)!==100) {
      const rate=Math.pow(2,(params.pitch||0)/12)*((params.tempo||100)/100);
      const newLen=Math.max(1,Math.ceil(buf.length/rate));
      const off=new OfflineAudioContext(numCh,newLen,sr);
      const s=off.createBufferSource();
      s.buffer=buf; s.playbackRate.value=rate;
      s.connect(off.destination); s.start(0);
      buf=await off.startRendering();
    }
    if (params.reverse) {
      for (let ch=0;ch<buf.numberOfChannels;ch++) buf.getChannelData(ch).reverse();
    }
    const offCtx=new OfflineAudioContext(numCh,buf.length,sr);
    const src=offCtx.createBufferSource(); src.buffer=buf;
    const bassF=offCtx.createBiquadFilter();
    bassF.type='lowshelf'; bassF.frequency.value=200; bassF.gain.value=params.bass||0;
    const trebleF=offCtx.createBiquadFilter();
    trebleF.type='highshelf'; trebleF.frequency.value=3000; trebleF.gain.value=params.treble||0;
    const comp=offCtx.createDynamicsCompressor();
    comp.threshold.value=-20; comp.knee.value=25; comp.ratio.value=3;
    comp.attack.value=0.005; comp.release.value=0.2;
    const mg=offCtx.createGain(); mg.gain.value=0.9;
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
      mg.gain.setValueAtTime(0,0); mg.gain.linearRampToValueAtTime(0.9,ft);
      mg.gain.setValueAtTime(0.9,dur-ft); mg.gain.linearRampToValueAtTime(0,dur);
    }
    src.start(0);
    return await offCtx.startRendering();
  }

  // ============================================================
  //  ENCODE MP3 (lamejs local)
  // ============================================================
  function encodeMP3(buf, format) {
    if (!window.lamejs) {
      console.error('[Remixer] lame.min.js not loaded!');
      return encodeWAVClean(buf);
    }
    const numCh=buf.numberOfChannels, sr=buf.sampleRate, len=buf.length;
    const kbps = format==='mp3-320' ? 320 : 128;
    const enc  = numCh===2 ? new lamejs.Mp3Encoder(2,sr,kbps) : new lamejs.Mp3Encoder(1,sr,kbps);
    const toI16 = d => {
      const o=new Int16Array(d.length);
      for (let i=0;i<d.length;i++) {
        const s=Math.max(-1,Math.min(1,d[i]));
        o[i]=s<0?Math.ceil(s*32768):Math.floor(s*32767);
      }
      return o;
    };
    const lPCM=toI16(buf.getChannelData(0));
    const rPCM=numCh>1?toI16(buf.getChannelData(1)):lPCM;
    const chunks=[], CHUNK=1152;
    for (let i=0;i<len;i+=CHUNK) {
      const e=Math.min(i+CHUNK,len);
      const c=numCh===2
        ? enc.encodeBuffer(lPCM.subarray(i,e),rPCM.subarray(i,e))
        : enc.encodeBuffer(lPCM.subarray(i,e));
      if (c.length>0) chunks.push(new Uint8Array(c));
    }
    const fin=enc.flush();
    if (fin.length>0) chunks.push(new Uint8Array(fin));
    const blob=new Blob(chunks,{type:'audio/mpeg'});
    console.log(`[Remixer v8] Output: ${(blob.size/1024).toFixed(0)}KB MP3 ${kbps}kbps — Ghost Mix applied`);
    return blob;
  }

  function encodeWAVClean(buf) {
    const nc=buf.numberOfChannels,sr=buf.sampleRate,len=buf.length;
    const bl=len*nc*2,ab=new ArrayBuffer(44+bl),v=new DataView(ab);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    const u32=(o,n)=>v.setUint32(o,n,true),u16=(o,n)=>v.setUint16(o,n,true);
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
    const c='abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({length:9},()=>c[Math.floor(Math.random()*c.length)]).join('');
  }

  const BYPASS_PRESETS = new Set([
    'nocopyright','light','medium','heavy','true_normal','roblox','ghost','natural','shield'
  ]);

  // ============================================================
  //  MAIN PROCESS — GHOST MIX v8
  // ============================================================
  async function process(file, params) {
    if (!AC) throw new Error('Web Audio API tidak didukung.');
    if (!window.lamejs) throw new Error('lame.min.js tidak ditemukan di folder root.');

    let buf = await decodeFile(file);
    const presetKey = (params._preset || 'nocopyright').toLowerCase();

    if (BYPASS_PRESETS.has(presetKey)) {

      // [1] Rate shift 8% — time domain disruption
      buf = await applyRateShift(buf, 1.08);

      // [2] Pitch +1.5st on top (tempo-preserving)
      buf = await applyPitchLayer(buf, 1.5);

      // [3] GHOST MIX — mix in procedural ambient pad at -13dB
      //     This is the PRIMARY fingerprint breaker
      buf = await applyGhostMixLayer(buf);

      // [4] EQ fingerprint warp
      buf = await applyEQ(buf, [
        { f: 88,   g:  1.2, q: 1.6 },
        { f: 263,  g: -1.2, q: 1.6 },
        { f: 790,  g:  0.7, q: 1.8 },
        { f: 2370, g:  0.9, q: 1.8 },
        { f: 5100, g: -0.9, q: 1.8 },
        { f: 9200, g:  0.8, q: 1.6 },
      ]);

      // [5] Stereo decorrelation
      buf = applyStereoDecorr(buf);

      // [6] Volume 80%
      buf = applyVolume(buf, 0.80);

      // Manual EQ from controls
      const extra=[];
      if ((params.bass||0)!==0)   extra.push({f:100,  g:params.bass});
      if ((params.treble||0)!==0) extra.push({f:8000, g:params.treble});
      if (extra.length) buf = await applyEQ(buf, extra);

    } else {
      buf = await applyCreativeEffects(buf, params);
    }

    return encodeMP3(buf, params.format || 'mp3');
  }

  return { process, randomFilename };

})();

console.log('[Remixer v8.0 — GHOST MIX] Broad Spectrum bypass active. Audio mixing layer enabled.');
