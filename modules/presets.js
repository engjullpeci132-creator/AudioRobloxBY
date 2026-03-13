/* ============================================================
   AudioRobloxBY — modules/presets.js
   All remix preset definitions
   ============================================================ */

'use strict';

window.PRESETS = {

  light: {
    pitch:     1.5,
    tempo:     103,
    reverb:    10,
    bass:      1,
    treble:    1,
    noise:     2,
    stereo:    true,
    normalize: true,
    fade:      false,
    reverse:   false,
    format:    'mp3',
    label:     '🔆 Light',
    desc:      'Perubahan halus — cukup untuk bypass Content ID ringan',
  },

  medium: {
    pitch:     2.5,
    tempo:     108,
    reverb:    20,
    bass:      2,
    treble:    2,
    noise:     5,
    stereo:    true,
    normalize: true,
    fade:      false,
    reverse:   false,
    format:    'mp3',
    label:     '🟠 Medium',
    desc:      'Seimbang — cocok untuk sebagian besar lagu populer',
  },

  heavy: {
    pitch:     4,
    tempo:     115,
    reverb:    35,
    bass:      4,
    treble:    3,
    noise:     10,
    stereo:    true,
    normalize: true,
    fade:      true,
    reverse:   false,
    format:    'mp3',
    label:     '🔴 Heavy',
    desc:      'Perubahan besar — untuk lagu dengan Content ID ketat',
  },

  lofi: {
    pitch:     -1,
    tempo:     92,
    reverb:    45,
    bass:      3,
    treble:    -3,
    noise:     8,
    stereo:    true,
    normalize: true,
    fade:      true,
    reverse:   false,
    format:    'mp3',
    label:     '🎵 Lo-Fi',
    desc:      'Efek lo-fi klasik — warm, dreamy, chill vibes',
  },

  chipmunk: {
    pitch:     8,
    tempo:     125,
    reverb:    5,
    bass:      -2,
    treble:    5,
    noise:     3,
    stereo:    false,
    normalize: true,
    fade:      false,
    reverse:   false,
    format:    'mp3',
    label:     '🐿 Chipmunk',
    desc:      'Pitch tinggi + tempo cepat — karakter chipmunk',
  },

  slowdeep: {
    pitch:     -3,
    tempo:     80,
    reverb:    30,
    bass:      6,
    treble:    -2,
    noise:     4,
    stereo:    true,
    normalize: true,
    fade:      true,
    reverse:   false,
    format:    'mp3',
    label:     '🌊 Slow Deep',
    desc:      'Diperlambat & diperdalam — bass boosted, cinematic',
  },

  vaporwave: {
    pitch:     -4,
    tempo:     78,
    reverb:    60,
    bass:      2,
    treble:    -4,
    noise:     6,
    stereo:    true,
    normalize: false,
    fade:      true,
    reverse:   false,
    format:    'mp3',
    label:     '🌸 Vaporwave',
    desc:      'A E S T H E T I C — slow, reverb heavy, dreamy',
  },

  bassdrop: {
    pitch:     1,
    tempo:     105,
    reverb:    15,
    bass:      10,
    treble:    1,
    noise:     3,
    stereo:    true,
    normalize: true,
    fade:      false,
    reverse:   false,
    format:    'mp3',
    label:     '💥 Bass Drop',
    desc:      'Bass maksimal — untuk konten hype & gaming',
  },
natural: {
    pitch:      0.7,   // Less than 1 semitone (barely audible change)
    tempo:      102,   // Only 2% faster (sounds identical to original)
    reverb:     15,    // Adds "space" to mask the original waveform
    bass:       1.5,   // Subtle EQ shift
    treble:     1,
    noise:      12,    // HIGHER noise (This is the secret for normal sound)
    stereo:     true,  // Crucial for phase masking
    normalize:  true,
    label:      '🌿 Natural',
    desc:       'Sound normal but invisible to AI — use for high-quality audio',
},
  nocopyright: {
    pitch:     3,
    tempo:     112,
    reverb:    25,
    bass:      2,
    treble:    1,
    noise:     7,
    stereo:    true,
    normalize: true,
    fade:      false,
    reverse:   false,
    format:    'mp3',
    label:     '✅ Auto No Copyright',
    desc:      'Kombinasi optimal untuk bypass Content ID YouTube — pitch +3st, tempo +12%, reverb 25%, noise layer 7%',
  },
};

// Helper: get preset by key
window.getPreset = function(key) {
  return window.PRESETS[key] || window.PRESETS['nocopyright'];
};

// Helper: list all preset keys
window.getPresetKeys = function() {
  return Object.keys(window.PRESETS);
};

console.log('[Presets] Loaded', Object.keys(window.PRESETS).length, 'presets');
