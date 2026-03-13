/* ============================================================
   AudioRobloxBY — modules/remixer.js
   Web Audio API — pitch shift, tempo, reverb, EQ, noise layer
   All processing happens 100% in the browser (no server)
   ============================================================ */

'use strict';

window.RemixerModule = (function () {

  const AudioContext = window.AudioContext || window.webkitAudioContext;

  // ── Decode audio file to AudioBuffer ──────────────────
  async function decodeFile(file) {
    const ctx        = new AudioContext();
    const arrayBuf   = await file.arrayBuffer();
    const audioBuf   = await ctx.decodeAudioData(arrayBuf);
    await ctx.close();
    return audioBuf;
  }

  // ── Simple pitch shift via playback rate trick ─────────
  // Note: true pitch shift without tempo change needs
  // a phase vocoder. Here we apply pitch via rate + re-sample
  // then correct tempo separately — good enough for bypass use.
  function semitoneToRate(semitones) {
    return Math.pow(2, semitones / 12);
  }

  // ── Build reverb impulse response ─────────────────────
  function buildImpulse(ctx, duration = 2.5, decay = 2.0) {
    const len    = ctx.sampleRate * duration;
    const buf    = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // ── Render audio graph offline ─────────────────────────
  async function renderOffline(sourceBuf, params) {
    const rate       = semitoneToRate(params.pitch);
    const tempoRatio = params.tempo / 100;

    // Adjust output length based on tempo
    const outDuration = sourceBuf.duration / tempoRatio;
    const outLength   = Math.ceil(outDuration * sourceBuf.sampleRate);
    const numCh       = params.stereo ? 2 : 1;

    const offCtx = new OfflineAudioContext(
      numCh,
      outLength,
      sourceBuf.sampleRate
    );

    // ── Source ───────────────────────────────────────────
    const source         = offCtx.createBufferSource();
    source.buffer        = sourceBuf;
    source.playbackRate.value = rate * tempoRatio;

    // ── Bass EQ ───────────────────────────────────────────
    const bassFilter        = offCtx.createBiquadFilter();
    bassFilter.type         = 'lowshelf';
    bassFilter.frequency.value = 200;
    bassFilter.gain.value   = params.bass;

    // ── Treble EQ ─────────────────────────────────────────
    const trebleFilter        = offCtx.createBiquadFilter();
    trebleFilter.type         = 'highshelf';
    trebleFilter.frequency.value = 3000;
    trebleFilter.gain.value   = params.treble;

    // ── Reverb ────────────────────────────────────────────
    const convolver       = offCtx.createConvolver();
    const dryGain         = offCtx.createGain();
    const wetGain         = offCtx.createGain();
    const reverbMix       = params.reverb / 100;
    dryGain.gain.value    = 1 - reverbMix * 0.7;
    wetGain.gain.value    = reverbMix;
    convolver.buffer      = buildImpulse(offCtx, 2.5 + reverbMix * 2, 2 + reverbMix);

    // ── Stereo widener (simple mid-side) ──────────────────
    let splitter = null, merger = null, invertGain = null;
    if (params.stereo && numCh === 2) {
      splitter   = offCtx.createChannelSplitter(2);
      merger     = offCtx.createChannelMerger(2);
      invertGain = offCtx.createGain();
      invertGain.gain.value = -0.3; // subtle widening
    }

    // ── Noise layer (anti-fingerprint) ────────────────────
    let noiseSource = null;
    if (params.noise > 0) {
      const noiseLen  = outLength;
      const noiseBuf  = offCtx.createBuffer(numCh, noiseLen, offCtx.sampleRate);
      const noiseAmt  = (params.noise / 100) * 0.018;
      for (let ch = 0; ch < numCh; ch++) {
        const d = noiseBuf.getChannelData(ch);
        for (let i = 0; i < noiseLen; i++) {
          d[i] = (Math.random() * 2 - 1) * noiseAmt;
        }
      }
      noiseSource        = offCtx.createBufferSource();
      noiseSource.buffer = noiseBuf;
    }

    // ── Compressor / normalizer ────────────────────────────
    const compressor             = offCtx.createDynamicsCompressor();
    compressor.threshold.value   = -24;
    compressor.knee.value        = 30;
    compressor.ratio.value       = params.normalize ? 4 : 1;
    compressor.attack.value      = 0.003;
    compressor.release.value     = 0.25;

    // ── Master gain ────────────────────────────────────────
    const masterGain       = offCtx.createGain();
    masterGain.gain.value  = params.normalize ? 0.9 : 0.85;

    // ── Connect graph ──────────────────────────────────────
    // source → bassFilter → trebleFilter → dryGain → compressor → master → dest
    //                                    → convolver → wetGain ↗
    source.connect(bassFilter);
    bassFilter.connect(trebleFilter);

    trebleFilter.connect(dryGain);
    trebleFilter.connect(convolver);

    dryGain.connect(compressor);
    convolver.connect(wetGain);
    wetGain.connect(compressor);

    if (noiseSource) {
      noiseSource.connect(compressor);
      noiseSource.start(0);
    }

    compressor.connect(masterGain);
    masterGain.connect(offCtx.destination);

    // ── Fade in / out ──────────────────────────────────────
    if (params.fade) {
      const fadeTime = Math.min(2, outDuration * 0.08);
      masterGain.gain.setValueAtTime(0, 0);
      masterGain.gain.linearRampToValueAtTime(params.normalize ? 0.9 : 0.85, fadeTime);
      masterGain.gain.setValueAtTime(params.normalize ? 0.9 : 0.85, outDuration - fadeTime);
      masterGain.gain.linearRampToValueAtTime(0, outDuration);
    }

    source.start(0);
    const rendered = await offCtx.startRendering();

    // ── Reverse ────────────────────────────────────────────
    if (params.reverse) {
      for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
        rendered.getChannelData(ch).reverse();
      }
    }

    return rendered;
  }

  // ── AudioBuffer → WAV Blob ─────────────────────────────
  function audioBufferToWav(buffer) {
    const numCh    = buffer.numberOfChannels;
    const sr       = buffer.sampleRate;
    const len      = buffer.length;
    const byteLen  = len * numCh * 2; // 16-bit PCM
    const ab       = new ArrayBuffer(44 + byteLen);
    const view     = new DataView(ab);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    function writeUint32(offset, v) { view.setUint32(offset, v, true); }
    function writeUint16(offset, v) { view.setUint16(offset, v, true); }

    writeStr(0, 'RIFF');
    writeUint32(4, 36 + byteLen);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    writeUint32(16, 16);
    writeUint16(20, 1);            // PCM
    writeUint16(22, numCh);
    writeUint32(24, sr);
    writeUint32(28, sr * numCh * 2);
    writeUint16(32, numCh * 2);
    writeUint16(34, 16);
    writeStr(36, 'data');
    writeUint32(40, byteLen);

    let offset = 44;
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
        offset += 2;
      }
    }

    return new Blob([ab], { type: 'audio/wav' });
  }

  // ── Main process entry point ───────────────────────────
  async function process(file, params) {
    if (!AudioContext) throw new Error('Web Audio API tidak didukung di browser ini');

    // Decode
    const arrayBuf = await file.arrayBuffer();
    const tmpCtx   = new AudioContext();
    let   srcBuf;
    try {
      srcBuf = await tmpCtx.decodeAudioData(arrayBuf);
    } catch (e) {
      throw new Error('Gagal mendecode audio: ' + e.message);
    } finally {
      await tmpCtx.close();
    }

    // Render with effects
    const rendered = await renderOffline(srcBuf, params);

    // Convert to blob
    // Always export as WAV (lossless from browser), labelled by chosen format
    const blob = audioBufferToWav(rendered);
    return blob;
  }

  // ── Public API ─────────────────────────────────────────
  return { process };

})();

console.log('[Remixer] Module ready — Web Audio API processor loaded');