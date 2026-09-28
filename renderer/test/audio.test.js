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
ok('shots reuse cached noise - no fresh random buffer per bullet', !/createBuffer\(/.test(lift('gunSound') + lift('noiseHit')) && /noiseBuf\(n, curve\)/.test(lift('noiseHit')));
ok('one shared room reverb, built once', /if\(ROOM \|\| !AC\) return ROOM;/.test(lift('roomBus')));

/* ---- weapon voices: each class recognisable by ear ---- */
{
  const c2 = vm.createContext({});
  vm.runInContext(line(/const GUNVOICE = \{[\s\S]*?\n\};/) + '\nthis.V = GUNVOICE;', c2);
  const V = c2.V, types = Object.keys(V);
  ok('all six classes have their own voice', ['Pistol','SMG','Assault Rifle','Shotgun','Sniper','LMG'].every(t => V[t]));
  const bodies = types.map(t => V[t].body.f);
  ok('every class sits at its own pitch (no two bodies within 8% of each other)',
     bodies.every((f, i) => bodies.every((g, j) => i === j || Math.abs(f - g) / Math.max(f, g) > 0.08)), bodies.join(' / '));
  ok('the SMG is the brightest and the shotgun the deepest', V.SMG.body.f === Math.max(...bodies) && V.Shotgun.body.f === Math.min(...bodies));
  ok('the heavy guns have weight (a low thump); the SMG does not', ['Shotgun','Sniper','LMG'].every(t => V[t].thump) && !V.SMG.thump);
  ok('the Warden pumps and the LS-1 cycles its bolt - and only they do',
     V.Shotgun.mech.kind === 'pump' && V.Sniper.mech.kind === 'bolt' && types.filter(t => V[t].mech).length === 2);
  ok('  the action is timed inside the fire interval (pump 0.36s < 0.70s, bolt 0.47s < 1.10s)',
     V.Shotgun.mech.t + 0.13 < 0.7 && V.Sniper.mech.t + 0.09 < 1.1);
  ok('  and heard only close by', /if\(v\.mech && vol > 0\.25\)/.test(lift('gunSound')));
  ok('loudness per class matches the old mix (nothing suddenly louder)',
     V.Pistol.g === 0.13 && V.SMG.g === 0.10 && V['Assault Rifle'].g === 0.15 && V.Shotgun.g === 0.26 && V.Sniper.g === 0.24 && V.LMG.g === 0.17);
  ok('gun layers go through the placed output (direction and distance still apply)', /g\.connect\(out\)/.test(lift('noiseHit')) && /const t = AC\.currentTime, out = earOut\(ear\)/.test(lift('gunSound')));
}

/* ---- menu music ---- */
ok('music plays on the menus and stops when a match starts', /if\(MUSIC_SCREENS\.includes\(id\)\) musicStart\(\); else if\(id === 'game'\) musicStop\(\);/.test(lift('show')));
{
  const scr = line(/const MUSIC_SCREENS = \[[^\n]*\];/);
  ok('  never in the game screen', !/'game'/.test(scr) && /'menu'/.test(scr) && /'results'/.test(scr));
}
ok('it has its own slider, in home Settings and in the match panel', /oninput="setMusicPct\(this\.value/.test(html) && /id="mussl"/.test(html));
ok('0 turns it off', /if\(musicLevel\(\) <= 0\)\{ musicStop\(true\); return; \}/.test(lift('musicSetLevel')) && /musicLevel\(\) <= 0/.test(lift('musicStart')));
ok('it sits under the master volume', /MUSIC\.bus\.connect\(masterBus\(\)\)/.test(lift('musicBus')));
ok('it fades in and out instead of cutting', /linearRampToValueAtTime\(musicLevel\(\), t \+ 2\.5\)/.test(lift('musicStart')) && /linearRampToValueAtTime\(0,/.test(lift('musicStop')));
ok('notes are queued ahead, so a slow frame cannot make it stumble', /AC\.currentTime \+ 0\.25/.test(lift('musicTick')));
ok('a hidden window stops it', /if\(document\.hidden\) musicStop\(true\);/.test(html));
ok('saved music level is checked and defaults to 60%', /SETTINGS\.music  = \(typeof s\.music === 'number' && isFinite\(s\.music\)\) \? Math\.min\(1, Math\.max\(0, s\.music\)\) : 0\.6;/.test(html));

/* ---- the music does not repeat for ~46 minutes ---- */
{
  const c3 = vm.createContext({});
  vm.runInContext([line(/const MUSIC_BPM = [^\n]*;/), line(/const MUSIC_CHORDS = [^\n]*;/), line(/const MUSIC_ARPS = \[[\s\S]*?\n\];/),
                   line(/const MUSIC_LEADS = \[[\s\S]*?\n\];/), lift('musicPlan')].join('\n') + '\nthis.plan = musicPlan; this.STEP = MUSIC_STEP; this.LEADS = MUSIC_LEADS; this.ARPS = MUSIC_ARPS;', c3);
  const key = pl => [c3.ARPS.indexOf(pl.arp), pl.lead ? c3.LEADS.indexOf(pl.lead) : -1, pl.chords.map(c => c[0]).join('.'), pl.breakdown, pl.fill].join('|');
  const seq = []; for(let c = 0; c < 240; c++) seq.push(key(c3.plan(c)));
  let period = 0; for(let P = 1; P < 240; P++) if(seq.slice(0, 240 - P).every((v, k) => v === seq[k + P])){ period = P; break; }
  const mins = period * 256 * c3.STEP / 60;
  ok('the order of cycles only comes round again after ~46 minutes', period === 60 && mins > 45, period + ' cycles = ' + mins.toFixed(1) + ' min');
  ok('  made of 24 different kinds of cycle', new Set(seq).size === 24, new Set(seq).size);
  ok('  no two cycles in a row are the same', seq.every((v, k) => k === 0 || v !== seq[k - 1]));
  const DMIN = new Set([2, 4, 5, 7, 9, 10, 0]);   // D E F G A Bb C, as pitch classes
  const notes = c3.LEADS.flat(3).filter((x, k) => k % 3 === 1);
  ok('every melody note is in D minor', notes.every(n => DMIN.has(n % 12)), notes.filter(n => !DMIN.has(n % 12)).join(',') || 'all');
  ok('every melody note ends inside its bar', c3.LEADS.every(m => m.every(bar => bar.every(([st, , len]) => st + len <= 16))));
  ok('melodies sit in a comfortable range (D4 to F5)', notes.every(n => n >= 62 && n <= 77));
}

/* ---- near misses ---- */
{
  let played = [], clock = 100;
  const c4 = vm.createContext({ Math: Object.create(Math), G: { me: { x: 0, z: 0, dead: false } }, EYE: 1.6,
    performance: { now: () => clock * 1000 }, whizSound: (x, z, close, sn) => played.push({ x, close, sn }) });
  c4.Math.random = () => 0.1;                              // always inside the 70% that are heard
  vm.runInContext([line(/const WHIZ = \{[^\n]*;/), line(/const rnd = [^\n]*;/), lift('whizCheck')].join('\n') + '\nthis.WHIZ = WHIZ;', c4);
  // fly a round along x at a given miss distance, sampled like frames
  const fly = (miss, sn) => { const b = {}; for(let x = -10; x <= 10; x += 0.7) c4.whizCheck(b, x, 1.6, miss, sn); return b; };
  fly(1.0); ok('a round passing 1m from your head whizzes', played.length === 1, played.length);
  ok('  once, at its closest point, from the side it passed', played.length === 1 && Math.abs(played[0].x) < 0.8);
  clock += 5; fly(3.0); ok('a round 3m away is silent', played.length === 1);
  clock += 5; fly(0.8); fly(0.8); fly(0.8);
  ok('a burst is not a wall of whizzes (rate-limited)', played.length === 2, played.length);
  clock += 5; c4.WHIZ.lastHurt = clock; fly(0.5);
  ok('a round that hit you plays the impact, not a whizz', played.length === 2);
  clock += 5; fly(0.6, true); ok('the LS-1 cracks instead', played.length === 3 && played[2].sn === true);
  c4.Math.random = () => 0.9; clock += 5; fly(0.5);
  ok('some close passes go by unheard - occasional, by design', played.length === 3);
}
/* ---- taking hits ---- */
{
  const plays = []; const q = [];
  const c5 = vm.createContext({ WHIZ: { lastHurt: 0 }, performance: { now: () => 0 }, queueMicrotask: f => q.push(f),
    hurtPlay: (d, sh) => plays.push([d, sh]) });
  vm.runInContext([line(/const HURT = \{[^\n]*;/), lift('hurtSound')].join('\n'), c5);
  for(let k = 0; k < 8; k++) c5.hurtSound(9, k === 3);
  q.forEach(f => f());
  ok('eight shotgun pellets in one frame are ONE hit, carrying all the damage', plays.length === 1 && plays[0][0] === 72, JSON.stringify(plays));
  ok('  and if any pellet hit a shield, the ring plays', plays[0][1] === true);
}
ok('the impact rings when a shield takes the hit', /hurtSound\(dmg, !!\(G && G\.me && G\.me\.shield > 0\)\)/.test(lift('playerFlinch')));
ok('kills use the new confirm, offline and live', (html.match(/killSound\(\);/g) || []).length >= 2 && !/sfx\('kill'\); noteKill/.test(html));
ok('your death has a sound, offline and live', /if\(t\.isPlayer\)\{ reloadStop\(\); deathSound\(\); \}/.test(lift('kill')) && /reloadStop\(\); deathSound\(\);/.test(html));
/* ---- reloads ---- */
{
  const c6 = vm.createContext({});
  vm.runInContext(line(/const RELOAD_SEQ = \{[\s\S]*?\n\};/) + '\nthis.S = RELOAD_SEQ;', c6);
  const S = c6.S;
  ok('every class has its own reload', ['Pistol','SMG','Assault Rifle','Shotgun','Sniper','LMG'].every(t => S[t] && S[t].length >= 4));
  ok('  each step lands inside the reload, in order', Object.values(S).every(q => q.every(([f], k) => f > 0 && f < 1 && (k === 0 || f > q[k-1][0]))));
  ok('  the Warden loads four shells and racks the pump', S.Shotgun.filter(x => x[1] === 'shell').length === 4 && S.Shotgun[S.Shotgun.length - 1][1] === 'pump');
  ok('  the LS-1 works its bolt; the Goliath opens and slams its lid', S.Sniper[0][1] === 'boltup' && S.Sniper.some(x => x[1] === 'boltdown') && S.LMG.filter(x => x[1] === 'latch').length === 2);
  const names = new Set(Object.values(S).map(q => q.map(x => x[1]).join()));
  ok('  no two classes share a routine', names.size === 6);
}
ok('reloads follow the weapon\'s REAL reload time (parts that speed it up speed the sound up)', /reloadSound\(e\.wep\.type, e\.wep\.reload, null, true\)/.test(lift('startReload')));
ok('other players\' reloads are heard close by (bots and PvP)', /reloadSound\(e\.wep\.type, e\.wep\.reload, earAt\(e\.x, e\.z, 0\.6\)\)/.test(lift('startReload')) && /reloadSound\(rw\.type, rw\.reload, earAt\(r\.cx, r\.cz, 0\.6\)\)/.test(html));
ok('a reload cut short by death or the match ending goes quiet',
   /reloadStop\(\)/.test(lift('kill')) && /reloadStop\(\)/.test(lift('abandonMatch')) && /reloadStop\(\)/.test(lift('endMatch')) && /reloadStop\(\)/.test(lift('liveResetWeapon')));
/* ---- echo, toned down ---- */
ok('the arena echo is shorter and lighter than the first pass (0.8s tail, sends to 0.4)',
   /AC\.sampleRate \* 0\.8\)/.test(lift('roomBus')) && /g\.gain\.value = 4\.5;/.test(lift('roomBus')) && /Math\.min\(0\.4, \(d - 4\) \/ 45\)/.test(lift('earAt')));

/* ---- the kill confirm: a punch, not a ding ---- */
{
  const src = lift('killSound');
  ok('the kill is a dry punch - click, falling thud, crunch - with nothing that rings', /'bandpass', 1700/.test(src) && /'sine', 150 \* p, 40/.test(src) && !/932|2\.76|1318/.test(src));
  ok('  short (~0.2s) and varied a hair every time', /quick \? 0\.14 : 0\.22/.test(src) && /p = rnd\(0\.95, 1\.05\)/.test(src));
  ok('  a second kill within ~1s is a smaller punch', /quick = now - KILLSND\.last < 1\.1/.test(src) && /\(quick \? 0\.65 : 1\)/.test(src));
}
ok('the hitmarker is calibrated above the old beep (people could not hear the quiet one)', /L = 0\.5;/.test(lift('sfx')));
ok('Settings closes back to the pause menu; only the pause menu resumes',
   /id="setclose"[^>]*>CLOSE</.test(html) && /\$\('#setclose'\)\.addEventListener\('click', settingsBack\)/.test(html) && /closeSettings\(false\);/.test(lift('settingsBack')));
ok('  Esc in Settings goes back too, but not while it is cancelling a key rebind', /e\.key === 'Escape' && settingsOpen && !bindCapture && !e\.defaultPrevented/.test(html));

ok('reload steps have a low body under the click, so they survive laptop speakers',
   ['clack','slide','pump','latch','shell','boltdown'].every(k => new RegExp("case '" + k + "':[\\s\\S]*?reloadBody\\(").test(lift('reloadPart'))));
ok('  and sit at a level measured to be audible (was ~17 dB quieter)', /const v = own \? 0\.16 :/.test(lift('reloadSound')));

/* ---- no prototype beeps left ---- */
ok('no square- or sawtooth-wave beeps in any game sound (the "pixelated" ones; the music pad\'s filtered saws are not beeps)',
   !/'(square|sawtooth)'/.test(['sfx','gunSound','killSound','hurtPlay','deathSound','whizSound','reloadPart','noiseHit','toneHit'].map(lift).join('')));
ok('menu clicks, hitmarkers, reset and purchase are all rebuilt', ['ui', 'hit', 'reload', 'kill'].every(k => new RegExp("kind==='" + k + "'").test(lift('sfx'))));
ok('a crit hitmarker sounds different from a normal one', /sfx\(isCrit \? 'crit' : 'hit'\)/.test(lift('showHitmark')) && /kind==='crit'/.test(lift('sfx')));
ok('the death card never covers Settings', /body:has\(#setov\.on\) #deathcard\{opacity:0\}/.test(html));

console.log(fails ? '\naudio: ' + fails + ' failure(s)' : '\naudio: all clear');
process.exit(fails ? 1 : 0);
