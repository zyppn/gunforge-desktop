/* Sound in space: where a sound comes from has to be audible, the same way for everyone.

   earAt() decides it for every placed sound - pan, loudness, how dull, how much echo -
   so its rules are checked directly here. (The rendered result was also measured once
   through a real OfflineAudioContext: 8m right = ~18 dB louder in the right ear than the
   left, centred again after turning to face it; 8m -> 30m -> 55m = -19 -> -23 -> -29 dB
   with the high end falling away and ~15% of what is heard being the room's echo.)

   node renderer/test/audio.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d !== undefined ? '   [' + d + ']' : '')); if(!cond) fails++; };
function lift(n){
  const m = html.match(new RegExp('(?:async\\s+)?function ' + n + '\\('));
  if(!m) throw new Error('missing function ' + n);
  let j = html.indexOf('{', html.indexOf(')', m.index)), d = 0;
  for(; j < html.length; j++){ if(html[j] === '{') d++; else if(html[j] === '}'){ d--; if(!d) return html.slice(m.index, j + 1); } }
  throw new Error('unbalanced ' + n);
}
const line = re => { const m = html.match(re); if(!m) throw new Error('missing ' + re); return m[0]; };
const ctx = vm.createContext({ Math, G: { me: { x: 30, z: 20 } }, yaw: 0 });
vm.runInContext([line(/const EAR = \{[^\n]*;/), line(/const GUN_LOUD = \{[^\n]*;/), lift('earAt')].join('\n') + '\nthis.EAR = EAR; this.GUN_LOUD = GUN_LOUD;', ctx);
const at = (x, z, loud, yaw) => { ctx.yaw = yaw || 0; return ctx.earAt(x, z, loud || 0.85); };
// me at (30, 20), yaw 0 = looking toward -Z
const ahead = at(30, 12), right = at(38, 20), left = at(22, 20), behind = at(30, 28);
ok('a shot to the RIGHT pans right', right.pan > 0.6, right.pan.toFixed(2));
ok('a shot to the LEFT pans left, by the same amount', left.pan < -0.6 && Math.abs(left.pan + right.pan) < 1e-9, left.pan.toFixed(2));
ok('straight ahead and straight behind are centred', Math.abs(ahead.pan) < 1e-9 && Math.abs(behind.pan) < 1e-9);
ok('never fully hard-panned (one ear always hears something)', Math.abs(right.pan) <= 0.85 + 1e-9);
ok('behind you sounds duller than the same shot in front', behind.cut < ahead.cut * 0.7, Math.round(behind.cut) + ' vs ' + Math.round(ahead.cut) + ' Hz');
ok('  but just as loud - behind is a tone, never a volume penalty', Math.abs(behind.vol - ahead.vol) < 1e-9);
const turned = at(38, 20, 0.85, -Math.PI / 2);
ok('turn to face the shot and it moves to the centre', Math.abs(turned.pan) < 1e-9, turned.pan.toFixed(3));
const onTop = at(30.5, 20);
ok('a sound right on top of you is not yanked into one ear', Math.abs(onTop.pan) < 0.25, onTop.pan.toFixed(2));

const d8 = at(30, 12), d30 = at(30, -10), d55 = at(30, -35);
ok('further = quieter', d8.vol > d30.vol && d30.vol > d55.vol, [d8, d30, d55].map(e => e.vol.toFixed(2)).join(' > '));
ok('further = duller (air eats the high end)', d8.cut > d30.cut && d30.cut > d55.cut, [d8, d30, d55].map(e => Math.round(e.cut)).join(' > ') + ' Hz');
ok('further = more echo', d8.wet < d30.wet && d30.wet <= d55.wet, [d8, d30, d55].map(e => e.wet.toFixed(2)).join(' < '));
ok('a shot 30m away is still HEARD (it used to be silent past ~22m)', d30.vol > 0.1, d30.vol.toFixed(2));
ok('the falloff is smooth - no cliff where a shot suddenly vanishes', Math.abs(at(30, -9.9).vol - at(30, -10.1).vol) < 0.01);
const sn = at(30, -35, ctx.GUN_LOUD.Sniper), smg = at(30, -35, ctx.GUN_LOUD.SMG);
ok('a sniper carries further than an SMG', sn.vol > smg.vol * 1.8 && sn.cut > smg.cut, sn.vol.toFixed(2) + ' vs ' + smg.vol.toFixed(2));
ok('the map is 60x40: across its full diagonal a sniper is still audible', at(30 - 36, 20 - 20, ctx.GUN_LOUD.Sniper).vol > 0.05);
ok('silence past the limit of hearing', at(30, 20 - 200).vol === 0);
ctx.G = null;
ok('no match running: plain, unplaced sound', ctx.earAt(0, 0, 1).pan === 0 && ctx.earAt(0, 0, 1).vol === 1);

// wiring
ok('enemy gunfire (offline) is placed at the shooter', /const ear = earAt\(e\.x, e\.z, loud\);\s*gunSound\(e\.wep\.type, ear\.vol, ear\);/.test(html));
ok('enemy gunfire (live PvP) is placed at the shooter', /const ear = earAt\(sx, sz, GUN_LOUD\[w\.type\] \|\| 0\.85\);\s*gunSound\(w\.type, ear\.vol, ear\);/.test(html));
ok('footsteps are placed - bots offline AND real players in PvP', (html.match(/sfx\('step', ear\.vol/g) || []).length === 2);
ok('explosions are placed', (html.match(/sfx\('boom', ear\.vol/g) || []).length === 2);
ok('your own gun stays centred', /gunSound\(e\.wep\.type, 1, \{ pan: 0,/.test(html));
ok('UI sounds are NOT placed (earOut with no ear = the plain master bus)', /if\(!ear \|\| !m\) return m;/.test(lift('earOut')));
ok('stereo panning, not HRTF (HRTF is too heavy for 2018 Macs)', /createStereoPanner/.test(lift('earOut')) && !/createPanner\(/.test(html));
ok('shots reuse cached noise - no fresh random buffer per bullet', !/createBuffer\(/.test(lift('gunSound')) && /noiseBuf\(s\.n/.test(lift('gunSound')));
ok('one shared room reverb, built once', /if\(ROOM \|\| !AC\) return ROOM;/.test(lift('roomBus')));

console.log(fails ? '\naudio: ' + fails + ' failure(s)' : '\naudio: all clear');
process.exit(fails ? 1 : 0);
