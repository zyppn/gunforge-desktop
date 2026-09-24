/* Colour highlights brighter than the part they sit on.

   THREE r128's Color.getHex() is literally

       getHex(){ return 255*this.r<<16 ^ 255*this.g<<8 ^ 255*this.b<<0 }

   with no clamp. Feed it a channel over 1.0 and 255*r exceeds 255, so the <<16 spills
   past bit 24; setHex() then masks the result back to 24 bits and the red channel comes
   back as whatever the overflow left behind. Legendary amber 0xE8A33D at tone(1.3) went
   in orange and came out 0x2DD34F - green. The Quickload magazine's quick-pull tab is
   the one you can see in the shipped game; the Hornet Shell's tail bead and the Dragon
   Heart's heat fins would have joined it.

   shade() clamps before packing. This test runs the renderer's OWN copy of shade(),
   pulled out of index.html, so it cannot pass against a version that stopped clamping. */
const fs = require('fs'), path = require('path');
const THREE = require('../vendor/three.min.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* Nothing may pack a scaled colour by hand any more - that is the bug, not the symptom. */
const RAW = /multiplyScalar\([^)]*\)\.getHex\(\)/g;
const raw = SRC.match(RAW) || [];
if(raw.length){
  console.error('index.html packs a scaled colour without clamping (' + raw.length + ' site(s)):');
  console.error('  ' + raw.join('\n  '));
  console.error('route it through shade(hex, k) - getHex() does not clamp and the red channel wraps.');
  process.exit(1);
}

const m = SRC.match(/function shade\(hex, k\)\{[\s\S]*?\n\}/);
if(!m){ console.error('renderer has no shade() - who is clamping the tone helpers?'); process.exit(1); }

const mat = color => ({ color });                       // stub: shade() only needs the packed value
const shade = eval('(' + m[0] + ')');                   // eslint-disable-line no-eval

const RCOL = {common:0x9BA8B0, uncommon:0x5FBF6E, rare:0x4C9BE8, epic:0xB463E8, legendary:0xE8A33D};
let bad = 0;
for(const [rar, hex] of Object.entries(RCOL)){
  const base = new THREE.Color(hex);
  for(const k of [0.32, 0.45, 0.55, 0.58, 0.62, 0.75, 1.0, 1.1, 1.12, 1.2, 1.3, 1.35, 2.0]){
    const got = new THREE.Color(shade(hex, k).color);
    for(const ch of ['r','g','b']){
      const want = Math.min(1, base[ch]*k);
      if(Math.abs(got[ch] - want) > 1.5/255){
        console.error(rar + ' shade(' + k + ').' + ch + ' = ' + got[ch].toFixed(3)
          + ', expected ' + want.toFixed(3) + ' (wrapped)');
        bad++;
      }
    }
    /* the property that actually matters on screen: brightening never darkens a channel */
    if(k >= 1) for(const ch of ['r','g','b']) if(got[ch] + 1.5/255 < base[ch]){
      console.error(rar + ' shade(' + k + ') DARKENED ' + ch + ': ' + base[ch].toFixed(3)
        + ' -> ' + got[ch].toFixed(3));
      bad++;
    }
  }
}
if(bad){ console.error(bad + ' colour(s) came back wrong.'); process.exit(1); }

/* And the tone helpers themselves must all go through it. */
const tones = SRC.match(/const tone = k => [^\n]*/g) || [];
if(!tones.length){ console.error('no tone helpers found - retarget this test'); process.exit(1); }
for(const t of tones) if(!t.includes('shade(')){
  console.error('a tone helper bypasses shade(): ' + t.trim()); process.exit(1);
}

console.log('shade: ' + tones.length + ' tone helpers clamped, ' + Object.keys(RCOL).length + ' rarities x 13 factors verified');
