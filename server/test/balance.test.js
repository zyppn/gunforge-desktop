/* Balance regression.  Everything here is measured, not asserted from a table:
   the TTK harness below is a port of stepBullets (substepped flight, real
   spread cone, real 0.68u capsule, crit at x2) so a change to the weapon table
   or to the falloff shows up as a changed kill time, the way a player feels it.

   What this file is protecting:
     1. No LS-1 build one-shots on a body hit.  The one-shot is meant to be a
        CRIT - a Deadeye reward you feel occasionally - not a property of owning
        four legendary damage parts.  Checked exhaustively over the real pool.
     2. Every weapon owns a range band and loses the others.
     3. The renderer's mirror of the weapon table has not drifted.

   Run:  node server/test/balance.test.js                                    */

const C = require('../loadout-core.js');
const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (l, ok, d) => { console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':'')); if(!ok) fails++; };

/* ---------------------------------------------------------------- harness */
const PLAYER_R = 0.5, EYE = 1.6, HITR = PLAYER_R + 0.18, CRITMUL = 2, HP = 100;

/* Expected time to kill a stationary target at `dist`, in seconds, including
   the killing round's flight time.  Stationary and in the open: this FLATTERS
   the fast, flat-shooting weapons and gives the sniper no credit for its
   travel-time advantage, so treat these as a floor on the LS-1, not a ceiling. */
function ttk(st, dist, ads, trials){
  const sprd    = C.fireSpread(st.spread * 0.55, ads);
  const speed   = st.bspd / 9;
  const pellets = Math.max(1, st.pellets);
  const dt = 1/30;
  let sum = 0, kills = 0;
  for(let t = 0; t < trials; t++){
    let hp = HP, shot = 0, done = false;
    while(shot < 400 && !done){
      const tFire = shot * st.rof / 1000; shot++;
      const crit = Math.random() < (st.crit || 0);
      for(let pi = 0; pi < pellets && !done; pi++){
        let dx = 1 + (Math.random()-0.5)*2*sprd;
        let dy = 0 + (Math.random()-0.5)*2*sprd;
        let dz = 0 + (Math.random()-0.5)*2*sprd;
        const l = Math.hypot(dx,dy,dz) || 1; dx/=l; dy/=l; dz/=l;
        const ox = dx*(PLAYER_R+0.35), oz = dz*(PLAYER_R+0.35);
        let bx = ox, by = EYE-0.06, bz = oz;
        const vx = dx*speed, vy = dy*speed, vz = dz*speed;
        let life = 1.6, hit = false, flight = 0;
        while(life > 0 && !hit){
          life -= dt;
          // same substep cap the server uses, so collision is tick-independent
          const n = Math.max(1, Math.ceil(Math.hypot(vx,vy,vz)*dt / 0.3)), sdt = dt/n;
          for(let s2 = 0; s2 < n; s2++){
            bx += vx*sdt; by += vy*sdt; bz += vz*sdt; flight += sdt;
            if(by < 0.03 || by > 9 || bx > dist + 6){ life = 0; break; }
            const ddx = dist-bx, ddz = -bz;
            if(by > 0 && by < 1.9 && ddx*ddx + ddz*ddz < HITR*HITR){ hit = true; break; }
          }
        }
        if(hit){
          let dmg = st.dmg * C.rangeMul(st.weaponId, Math.hypot(bx-ox, bz-oz));
          if(crit) dmg *= CRITMUL;
          hp -= dmg;
          if(hp <= 0){ sum += tFire + flight; kills++; done = true; }
        }
      }
    }
  }
  return kills ? sum/kills : Infinity;
}

/* The build we are actually worried about: every slot legendary, every damage
   part taken, Deadeye wherever a damage part can also carry it. */
function metaBuild(wid){
  const S = C.RAR.legendary.scale;
  const pick = slot => {
    const pool = C.PART_POOL[slot];
    // the highest-damage template in this slot, else the first
    let best = pool[0], bd = -1;
    for(const t of pool){ const d = t.mods.dmg || 0; if(d > bd){ bd = d; best = t; } }
    const mods = {}; for(const k in best.mods) mods[k] = +(best.mods[k]*S).toFixed(3);
    return { slot, weapon:wid, rarity:'legendary', name:best.name, mods,
             ability: (best.mods.dmg ? 'deadeye' : null), set:null };
  };
  const eq = {}; for(const s of C.SLOTS) eq[s] = pick(s);
  return eq;
}

/* ------------------------------------------- 1. no body-shot one-shot ever */
console.log('LS-1  no build may one-shot on a BODY hit (the one-shot is a crit)');
{
  // exhaustive over the real pool: best damage template in every slot at legendary
  const S = C.RAR.legendary.scale;
  let mult = 1;
  for(const slot of C.SLOTS){
    let bd = 0;
    for(const t of C.PART_POOL[slot]) bd = Math.max(bd, (t.mods.dmg || 0) * S);
    mult += bd;
  }
  const ls1 = C.weaponById('ls1');
  const top = ls1.dmg * mult;
  check('best possible LS-1 body shot = ' + top.toFixed(1), top < 100,
        'must stay under 100hp; headroom ' + (100-top).toFixed(1));
  check('a crit still one-shots (that is the reward)', top * 2 >= 100,
        (top*2).toFixed(1) + ' on a crit');
  // and confirm computeStats agrees with the exhaustive number
  const st = C.computeStats('ls1', metaBuild('ls1'));
  check('computeStats matches the exhaustive max', Math.abs(st.dmg - top) < 0.01,
        st.dmg.toFixed(1) + ' vs ' + top.toFixed(1));
  check('and that build reaches the 30% deadeye cap', Math.abs(st.crit - 0.30) < 1e-9,
        (st.crit*100).toFixed(0) + '%');
}

/* ------------------------------------------------------ 2. falloff shape */
console.log('\nRANGE FALLOFF');
{
  const f = C.FALLOFF.ls1;
  check('floor at and inside ' + f.near + 'u', C.rangeMul('ls1', 0) === f.floor &&
        C.rangeMul('ls1', f.near) === f.floor, 'x' + f.floor);
  check('full damage at and beyond ' + f.far + 'u', C.rangeMul('ls1', f.far) === 1 &&
        C.rangeMul('ls1', 200) === 1);
  let mono = true, prev = -1;
  for(let d = 0; d <= 30; d += 0.5){ const v = C.rangeMul('ls1', d); if(v < prev - 1e-12) mono = false; prev = v; }
  check('monotonic, no step', mono);
  check('midpoint is halfway', Math.abs(C.rangeMul('ls1', 13) - (f.floor + (1-f.floor)/2)) < 1e-9);
  for(const w of C.WEAPONS){
    if(w.id === 'ls1') continue;
    check(w.id + ' is flat at every range',
          [0,5,10,25,60].every(d => C.rangeMul(w.id, d) === 1));
  }
}

/* --------------------------------------------------------- 3. ADS spread */
console.log('\nADS');
{
  // Deliberately NOT pinned to a number: the coefficient is a tuning knob and
  // the RANGE BANDS below are what actually has to hold. If someone moves it,
  // this prints the new value and the band checks decide whether it was OK.
  console.log('    ADS_SPREAD = ' + C.ADS_SPREAD + '  (scoped spread is '
              + ((1-C.ADS_SPREAD)*100).toFixed(0) + '% of hipfire)');
  check('hipfire is untouched', C.fireSpread(0.1, 0) === 0.1);
  check('full ADS tightens to ' + ((1-C.ADS_SPREAD)*100).toFixed(0) + '%',
        Math.abs(C.fireSpread(0.1, 1) - 0.1*(1-C.ADS_SPREAD)) < 1e-12);
  check('clamps a bogus ads value', C.fireSpread(0.1, 99) === C.fireSpread(0.1, 1) &&
        C.fireSpread(0.1, -5) === 0.1);
}

/* ------------------------------------------------- 4. every weapon a band */
console.log('\nRANGE BANDS  (measured, max build, ADS, 700 trials/cell)');
{
  const RANGES = [3, 6, 25, 40];
  const T = {};
  const rows = [];
  for(const w of C.WEAPONS){
    const st = C.computeStats(w.id, metaBuild(w.id));
    T[w.id] = {};
    let line = '    ' + w.id.padEnd(10);
    for(const r of RANGES){ const v = ttk(st, r, 1, 700); T[w.id][r] = v; line += (v===Infinity?'--':v.toFixed(2)).padStart(8); }
    rows.push(line);
  }
  console.log('    ' + 'weapon'.padEnd(10) + RANGES.map(r => (r+'u').padStart(8)).join(''));
  rows.forEach(l => console.log(l));

  const fastest = r => C.WEAPONS.map(w => w.id).reduce((a,b) => T[a][r] <= T[b][r] ? a : b);
  const slowest = r => C.WEAPONS.map(w => w.id).reduce((a,b) => T[a][r] >= T[b][r] ? a : b);

  check('Warden owns 3u',  fastest(3)  === 'warden',  fastest(3));
  check('Warden owns 6u',  fastest(6)  === 'warden',  fastest(6));
  check('LS-1 owns 25u',   fastest(25) === 'ls1',     fastest(25));
  check('LS-1 owns 40u',   fastest(40) === 'ls1',     fastest(40));
  check('LS-1 is the WORST weapon at 3u', slowest(3) === 'ls1', slowest(3));
  check('LS-1 is the WORST weapon at 6u', slowest(6) === 'ls1', slowest(6));
  check('LS-1 close range is a real penalty (>2x the Warden at 3u)',
        T.ls1[3] > T.warden[3] * 2, T.ls1[3].toFixed(2) + ' vs ' + T.warden[3].toFixed(2));
  check('nothing kills faster than 0.4s at 40u (no cross-map instakill)',
        C.WEAPONS.every(w => T[w.id][40] > 0.4),
        C.WEAPONS.map(w => w.id + ':' + T[w.id][40].toFixed(2)).join(' '));
  // horizontal parity: the best weapon at any range should not lap the field
  for(const r of RANGES){
    const vals = C.WEAPONS.map(w => T[w.id][r]).filter(v => v < Infinity).sort((a,b)=>a-b);
    check('at ' + r + 'u the best is within 3x the median',
          vals[0] * 3 >= vals[Math.floor(vals.length/2)],
          'best ' + vals[0].toFixed(2) + ', median ' + vals[Math.floor(vals.length/2)].toFixed(2));
  }
}

/* -------------------------------------------- 5. the renderer has not drifted */
console.log('\nDRIFT  renderer/index.html mirrors the weapon table');
{
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  for(const w of C.WEAPONS){
    const m = html.match(new RegExp("\\{id:'" + w.id + "'[^}]*\\}"));
    if(!m){ check(w.id + ' present in renderer table', false, 'row not found'); continue; }
    const row = m[0];
    const num = k => { const mm = row.match(new RegExp(k + ':\\s*(-?[0-9.]+)')); return mm ? Number(mm[1]) : null; };
    const bad = ['dmg','rof','mag','reload','spread','bspd','pellets','unlock']
      .filter(k => num(k) !== w[k])
      .map(k => k + ' ' + num(k) + '!=' + w[k]);
    check(w.id + ' matches loadout-core', bad.length === 0, bad.join(', '));
  }
  const vendor = fs.readFileSync(path.join(__dirname, '../../renderer/vendor/loadout-core.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../loadout-core.js'), 'utf8');
  check('renderer/vendor/loadout-core.js is byte-identical', vendor === server,
        vendor === server ? '' : 'run npm run sync:core');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all balance checks passed'));
process.exit(fails ? 1 : 0);
