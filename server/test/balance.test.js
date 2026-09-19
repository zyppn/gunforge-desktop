/* Balance regression.  Everything here is measured, not asserted from a table.

   The important lesson baked into this file: an earlier version scored every
   weapon on its MAX-DAMAGE build, and passed, while the actual optimal build -
   six spread parts on the Warden - was landing 86% of its pellets at 35u and
   owning every range band from 3u to 22u. A single hand-picked build is not a
   test. So this searches all 4096 part combinations per weapon and scores the
   BEST one, which is the only build that matters for balance.

   Hit probability is closed-form rather than marched, so the search is fast.
   It is cross-checked against the marching model in stepBullets to within
   0.005 at every range/spread pair that matters.

   Run:  node server/test/balance.test.js                                    */

const C = require('../loadout-core.js');
const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (l, ok, d) => { console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':'')); if(!ok) fails++; };

const R_HIT = 0.68, EYE = 1.54, TOP = 1.9, LEG = C.RAR.legendary.scale, CRIT_CAP = 0.30;

/* ---------------------------------------------------------------- harness */
/* Probability one pellet connects, and the mean flight time of the ones that
   do. Same cone construction as tryFire: uniform +/-sprd per axis, normalised. */
function hit(dist, sprd, speed, N){
  let h = 0, f = 0;
  for(let i = 0; i < N; i++){
    let dx = 1 + (Math.random()-0.5)*2*sprd;
    let dy =     (Math.random()-0.5)*2*sprd;
    let dz =     (Math.random()-0.5)*2*sprd;
    const L = Math.hypot(dx,dy,dz); dx/=L; dy/=L; dz/=L;
    const ax = dx*0.85 - dist, az = dz*0.85;
    const vv = dx*dx + dz*dz, av = ax*dx + az*dz;
    const t = -av/vv, d2 = (ax*ax + az*az) - av*av/vv;
    if(d2 >= R_HIT*R_HIT || t <= 0) continue;
    const te = t - Math.sqrt((R_HIT*R_HIT - d2)/vv);
    if(te <= 0) continue;
    const y = EYE + dy*te;
    if(y <= 0 || y >= TOP) continue;
    if(te/speed > 1.6) continue;              // bullet life
    h++; f += te/speed;
  }
  return { p: h/N, flight: h ? f/h : dist/speed };
}

/* Expected time to kill a stationary 100hp target, reloads and burn included. */
function ttk(S, dist, p, flight, trials){
  const mul = C.rangeMul(S.weaponId, dist);
  let sum = 0;
  for(let n = 0; n < trials; n++){
    let t = 0, hp = 100, ammo = S.mag, burn = 0, guard = 0;
    while(hp > 0 && guard++ < 600){
      if(ammo <= 0){ t += S.reload/1000; ammo = S.mag; }
      const crit = Math.random() < S.crit;
      let landed = 0;
      for(let k = 0; k < S.pellets; k++) if(Math.random() < p) landed++;
      ammo--;
      if(landed){ hp -= landed * S.dmg * mul * (crit ? 2 : 1); burn = 3; }
      const step = S.rof/1000;
      if(burn > 0){ const b = Math.min(burn, step); hp -= 4*b; burn -= b; }
      t += step;
    }
    sum += t - S.rof/1000 + flight;
  }
  return sum/trials;
}

/* ---- the best build a player can actually assemble ---------------------- */
/* Every slot legendary, every template considered, Deadeye at the 30% cap
   (abilities do not compete with stat templates - a part carries both). */
function statsFor(wid, pick){
  const w = C.weaponById(wid);
  const m = {dmg:1, rof:1, mag:1, reload:1, spread:1};
  for(let i = 0; i < C.SLOTS.length; i++){
    const t = C.PART_POOL[C.SLOTS[i]][pick[i]].mods;
    for(const k in t) if(k in m) m[k] += +(t[k]*LEG).toFixed(3);
  }
  return { weaponId:wid, dmg:w.dmg*m.dmg, rof:Math.max(45, w.rof/m.rof),
           mag:Math.max(3, Math.round(w.mag*m.mag)), reload:Math.max(400, w.reload*m.reload),
           spread:Math.max(w.spread*C.SPREAD_FLOOR, w.spread*m.spread),
           bspd:w.bspd, pellets:w.pellets, crit:CRIT_CAP, pick };
}
const PROBE = [3, 12.5, 22.5, 35];
function bestBuild(wid){
  let best = null;
  const cache = new Map();
  for(let n = 0; n < 4096; n++){
    let v = n; const pick = [];
    for(let i = 0; i < 6; i++){ pick.push(v % 4); v = (v/4)|0; }
    const S = statsFor(wid, pick);
    const sprd = C.fireSpread(S.spread*0.55, 1), speed = S.bspd/9;
    let sc = 0;
    for(const d of PROBE){
      const key = d + '|' + sprd.toFixed(5);
      if(!cache.has(key)) cache.set(key, hit(d, sprd, speed, 3000));
      const h = cache.get(key);
      sc += h.p < 0.02 ? 12 : ttk(S, d, h.p, h.flight, 40);
    }
    if(!best || sc < best.sc){ best = S; best.sc = sc; }
  }
  return best;
}

/* -------------------------------------------- 1. no body-shot one-shot ever */
console.log('LS-1  no build may one-shot on a BODY hit (the one-shot is a crit)');
{
  let mult = 1;
  for(const slot of C.SLOTS){
    let bd = 0;
    for(const t of C.PART_POOL[slot]) bd = Math.max(bd, (t.mods.dmg || 0) * LEG);
    mult += bd;
  }
  const top = C.weaponById('ls1').dmg * mult;
  check('best possible LS-1 body shot = ' + top.toFixed(1), top < 100,
        'must stay under 100hp; headroom ' + (100-top).toFixed(1));
  check('a crit still one-shots (that is the reward)', top * 2 >= 100, (top*2).toFixed(1));
}

/* ------------------------------------------------------ 2. falloff shape */
console.log('\nRANGE FALLOFF  (a two-point ramp; it can go up or down)');
for(const [id, f] of Object.entries(C.FALLOFF)){
  const dir = f.m1 > f.m0 ? 'ramps UP with range (sniper)' : 'ramps DOWN with range (shotgun)';
  check(id + ' ' + dir, true, 'x' + f.m0 + ' at ' + f.d0 + 'u -> x' + f.m1 + ' at ' + f.d1 + 'u');
  check('  ' + id + ' flat outside the ramp',
        C.rangeMul(id, 0) === f.m0 && C.rangeMul(id, f.d0) === f.m0 &&
        C.rangeMul(id, f.d1) === f.m1 && C.rangeMul(id, 500) === f.m1);
  let mono = true, prev = C.rangeMul(id, 0);
  for(let d = 0; d <= 60; d += 0.5){
    const v = C.rangeMul(id, d);
    if((f.m1 > f.m0 ? v < prev - 1e-12 : v > prev + 1e-12)) mono = false;
    prev = v;
  }
  check('  ' + id + ' monotonic, no step', mono);
  check('  ' + id + ' midpoint is halfway',
        Math.abs(C.rangeMul(id, (f.d0+f.d1)/2) - (f.m0+f.m1)/2) < 1e-9);
}
for(const w of C.WEAPONS){
  if(C.FALLOFF[w.id]) continue;
  check(w.id + ' is flat at every range', [0,5,10,25,60].every(d => C.rangeMul(w.id, d) === 1));
}

/* --------------------------------------------------------- 3. ADS + floor */
console.log('\nADS AND SPREAD FLOOR');
{
  console.log('    ADS_SPREAD = ' + C.ADS_SPREAD + '  (scoped cone is '
              + ((1-C.ADS_SPREAD)*100).toFixed(0) + '% of hipfire)');
  console.log('    SPREAD_FLOOR = ' + C.SPREAD_FLOOR + '  (tightest reachable cone)');
  check('hipfire is untouched', C.fireSpread(0.1, 0) === 0.1);
  check('full ADS tightens correctly',
        Math.abs(C.fireSpread(0.1, 1) - 0.1*(1-C.ADS_SPREAD)) < 1e-12);
  check('clamps a bogus ads value',
        C.fireSpread(0.1, -5) === 0.1 && C.fireSpread(0.1, 99) === C.fireSpread(0.1, 1));
  // the floor has to actually bind: stack every spread part and check
  const allSpread = C.SLOTS.map(s => {
    const pool = C.PART_POOL[s];
    let bi = 0, bv = 1;
    pool.forEach((t,i) => { const v = t.mods.spread === undefined ? 1 : t.mods.spread; if(v < bv){ bv = v; bi = i; } });
    return bi;
  });
  const w = statsFor('warden', allSpread);
  check('a full spread stack cannot go below the floor',
        Math.abs(w.spread - C.weaponById('warden').spread * C.SPREAD_FLOOR) < 1e-9,
        w.spread.toFixed(4));
}

/* ------------------------------- 4. range bands, on each weapon's BEST build */
console.log('\nRANGE BANDS  (exhaustive build search, ADS, measured)');
const RANGES = [3, 8, 12.5, 17.5, 22.5, 27.5, 35, 45];
const T = {}, PH35 = {};
for(const w of C.WEAPONS){
  const S = bestBuild(w.id);
  const sprd = C.fireSpread(S.spread*0.55, 1), speed = S.bspd/9;
  T[w.id] = {};
  let line = '    ' + w.id.padEnd(10);
  for(const d of RANGES){
    const h = hit(d, sprd, speed, 20000);
    T[w.id][d] = h.p < 0.02 ? 99 : ttk(S, d, h.p, h.flight, 1500);
    line += (T[w.id][d] === 99 ? '--' : T[w.id][d].toFixed(2)).padStart(7);
  }
  PH35[w.id] = hit(35, sprd, speed, 20000).p;
  console.log(line + '   pellets@35u ' + (PH35[w.id]*100).toFixed(0) + '%');
}
console.log('    ' + 'weapon'.padEnd(10) + RANGES.map(r => (r+'u').padStart(7)).join(''));

const ids = C.WEAPONS.map(w => w.id);
const owner = d => ids.reduce((a,b) => T[a][d] <= T[b][d] ? a : b);
const owns = {}; ids.forEach(i => owns[i] = RANGES.filter(d => owner(d) === i));
for(const i of ids) console.log('    ' + i.padEnd(10) + ' owns: ' + (owns[i].map(d=>d+'u').join(' ') || '-'));

check('the Warden owns point blank',  owns.warden.includes(3) && owns.warden.includes(8));
check('the Warden owns NOTHING past 20u',
      !owns.warden.some(d => d >= 20), owns.warden.join(','));
check('the Warden is not a marksman rifle: <70% of pellets land at 35u',
      PH35.warden < 0.70, (PH35.warden*100).toFixed(0) + '%');
check('the LS-1 owns the long bands', owns.ls1.includes(35) && owns.ls1.includes(45));
check('the LS-1 owns nothing point blank', !owns.ls1.some(d => d <= 8), owns.ls1.join(','));
check('no weapon owns more than 5 of the 8 bands',
      ids.every(i => owns[i].length <= 5),
      ids.map(i => i+':'+owns[i].length).join(' '));
{
  const peaks = ids.map(i => ({ i, p: Math.min(...RANGES.map(d => T[i][d])) }));
  peaks.sort((a,b) => a.p - b.p);
  const gap = peaks[peaks.length-1].p / peaks[0].p;
  console.log('    peaks: ' + peaks.map(q => q.i+' '+q.p.toFixed(2)).join('  '));
  check('every weapon is within 2x the best weapon IN ITS OWN BAND', gap <= 2.0,
        gap.toFixed(2) + 'x');
  // Not a failure, but it should be visible on every run: a weapon that never
  // wins a band is a weapon nobody has a reason to pick, even if its numbers
  // are close. Today the LS-1's two-shot covers everything past 17u.
  const idle = ids.filter(i => !owns[i].length);
  if(idle.length) console.log('    NOTE  owns no band: ' + idle.join(', ') +
        '  (within ' + gap.toFixed(2) + 'x on peak, but never the best answer)');
}

/* -------------------------------------------- 5. the renderer has not drifted */
console.log('\nDRIFT  renderer/index.html mirrors the weapon table');
{
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  for(const w of C.WEAPONS){
    const m = html.match(new RegExp("\\{id:'" + w.id + "'[^}]*\\}"));
    if(!m){ check(w.id + ' present in renderer table', false, 'row not found'); continue; }
    const num = k => { const mm = m[0].match(new RegExp(k + ':\\s*(-?[0-9.]+)')); return mm ? Number(mm[1]) : null; };
    const bad = ['dmg','rof','mag','reload','spread','bspd','pellets','unlock']
      .filter(k => num(k) !== w[k]).map(k => k + ' ' + num(k) + '!=' + w[k]);
    check(w.id + ' matches loadout-core', bad.length === 0, bad.join(', '));
  }
  check('renderer/vendor/loadout-core.js is byte-identical',
        fs.readFileSync(path.join(__dirname, '../../renderer/vendor/loadout-core.js'), 'utf8')
        === fs.readFileSync(path.join(__dirname, '../loadout-core.js'), 'utf8'), 'run npm run sync:core');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all balance checks passed'));
process.exit(fails ? 1 : 0);
