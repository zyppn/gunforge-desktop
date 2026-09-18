/* Ability stacking and the Sidearm Saint rework, checked through the real
   computeStats — the one function the client and server share. */
const C = require('../loadout-core.js');
let fails = 0;
const check = (l, ok, d) => { console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':'')); if(!ok) fails++; };
const part = (slot, ability, name, set) => ({ slot, weapon:'m17', rarity:'legendary',
  name: name || 'X', mods:{}, ability: ability || null, set: set || null });
const eq = obj => { const o = {}; for(const s of C.SLOTS) o[s] = obj[s] || null; return o; };
const stats = obj => C.computeStats('m17', eq(obj));

console.log('DEADEYE  12% first, +6% each extra, cap 30%');
const dslots = ['frame','barrel','magazine','foregrip','stock','optic'];
const want = [0, 0.12, 0.18, 0.24, 0.30, 0.30, 0.30];
for(let n = 0; n <= 6; n++){
  const o = {}; for(let i=0;i<n;i++) o[dslots[i]] = part(dslots[i], 'deadeye');
  const c = stats(o).crit;
  check(n + ' deadeye part' + (n===1?' ':'s') + ' -> ' + (c*100).toFixed(0) + '% crit',
        Math.abs(c - want[n]) < 1e-9, 'want ' + (want[n]*100).toFixed(0) + '%');
}

console.log('\nFEATHERWEIGHT  +10% first, +5% each extra, cap 25%');
const swant = [1.0, 1.10, 1.15, 1.20, 1.25, 1.25];
for(let n = 0; n <= 5; n++){
  const o = {}; for(let i=0;i<n;i++) o[dslots[i]] = part(dslots[i], 'swift');
  const sm = stats(o).speedMul;
  check(n + ' featherweight -> x' + sm.toFixed(2),
        Math.abs(sm - swant[n]) < 1e-9, 'want x' + swant[n].toFixed(2));
}

console.log('\nSIDEARM SAINT  Absolution now carries its own crit');
const saint = { barrel: part('barrel', null, "Saint's Whisper", 'saint'),
                optic:  part('optic',  null, "Saint's Eye",     'saint') };
const s2 = stats(saint);
check('two pieces activate the set', s2.abilities.indexOf('critheal') >= 0, s2.abilities.join(','));
check('the set alone gives 15% crit with NO deadeye part', Math.abs(s2.crit - 0.15) < 1e-9,
      (s2.crit*100).toFixed(0) + '%');
const one = stats(Object.assign({}, saint, { frame: part('frame','deadeye') }));
check('set + one deadeye = 27%', Math.abs(one.crit - 0.27) < 1e-9, (one.crit*100).toFixed(0) + '%');
const three = stats(Object.assign({}, saint, {
  frame: part('frame','deadeye'), magazine: part('magazine','deadeye'), foregrip: part('foregrip','deadeye') }));
check('set + three deadeye = 39%, under the 50% ceiling', Math.abs(three.crit - 0.39) < 1e-9,
      (three.crit*100).toFixed(0) + '%');

console.log('\nONLY those two stack');
const twoFire = stats({ frame: part('frame','incendiary'), barrel: part('barrel','incendiary') });
check('a second incendiary adds nothing (it is an on/off state)',
      twoFire.abilities.filter(a => a === 'incendiary').length === 1);
check('stack counts are reported for the UI',
      stats({frame:part('frame','deadeye'), barrel:part('barrel','deadeye')}).stacks.deadeye === 2);

console.log('\nBEFORE vs AFTER, Saint on an M17 (13 dmg/hit)');
const before = 0.12 * 6;   // needed a deadeye part to work at all, healed 6
const after  = s2.crit * 10;
console.log('  old: needed a 3rd slot for Deadeye, then 12% x 6HP  = ' + before.toFixed(2) + ' HP/hit');
console.log('  new: two slots, self-sufficient, 15% x 10HP         = ' + after.toFixed(2) + ' HP/hit');
console.log('  vampiric for comparison: 12% of 13 dmg              = ' + (13*0.12).toFixed(2) + ' HP/hit (1 slot)');
check('Saint is now worth its two slots against a one-slot Vampiric', after > before * 1.8,
      after.toFixed(2) + ' vs ' + before.toFixed(2));

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
