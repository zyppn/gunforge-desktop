/* The daily store is a pure function of (player, day). These checks are what
   stop it being rerollable, identical for everyone, or drifting off 7pm. */
const C = require('../loadout-core.js');
let fails = 0;
const check=(l,ok,d)=>{console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':''));if(!ok)fails++;};
const sig = s => s.map(i => i.rarity+'/'+i.weapon+'/'+i.slot+'/'+i.name+'/'+(i.ability||'-')).join(' ');

const w = C.storeWindow(Date.now());
console.log('CURRENT WINDOW  key ' + w.key);
console.log('  opened ' + new Date(w.start).toISOString() + '  closes ' + new Date(w.next).toISOString());
const fmt = ms => new Date(ms).toLocaleString('en-US', { timeZone:'America/Chicago', hour12:true });
console.log('  Chicago: ' + fmt(w.start) + '  ->  ' + fmt(w.next));
check('window opens at 7pm Chicago', /7:00:00\s*PM/.test(fmt(w.start)), fmt(w.start));
check('window closes at 7pm Chicago', /7:00:00\s*PM/.test(fmt(w.next)), fmt(w.next));
check('now is inside the window', w.start <= Date.now() && Date.now() < w.next);
check('window is 23-25h long (DST-safe)', (w.next-w.start) >= 23*3600e3 && (w.next-w.start) <= 25*3600e3,
      ((w.next-w.start)/3600e3).toFixed(1) + 'h');

console.log('\nBOUNDARY WALK  every 3h for 10 days from each base');
console.log('  (2026-03-06 covers spring-forward Mar 8; 2026-10-30 covers fall-back Nov 1)');
let bad = 0, keys = new Set();
for(const base of ['2026-03-06T00:00:00Z','2026-10-30T00:00:00Z','2026-09-01T00:00:00Z']){
  let lastStart = null;          // gaps are only meaningful WITHIN one continuous walk
  for(let h = 0; h < 240; h += 3){
    const t = Date.parse(base) + h*3600e3;
    const win = C.storeWindow(t);
    const local = fmt(win.start);
    if(!/7:00:00\s*PM/.test(local)) { bad++; if(bad<3) console.log('    off at ' + new Date(t).toISOString() + ' -> ' + local); }
    if(!(win.start <= t && t < win.next)) { bad++; if(bad<3) console.log('    t outside its own window at ' + new Date(t).toISOString()); }
    keys.add(win.key);
    if(lastStart !== null && win.start !== lastStart){
      const gap = (win.start - lastStart)/3600e3;
      if(gap < 22.9 || gap > 25.1){ bad++; console.log('    bad gap ' + gap.toFixed(1) + 'h'); }
    }
    lastStart = win.start;
  }
}
check('every window in the walk opens at 7pm Chicago and contains its instant', bad === 0, bad + ' problems');
check('windows are distinct days', keys.size >= 29, keys.size + ' distinct keys');

console.log('\nSHAPE');
const shop = C.rollDailyStore('player-A', w.key);
console.log('  ' + shop.map(i => i.rarity + ' ' + i.price).join('  |  '));
check('exactly 8 items', shop.length === 8);
const r = shop.map(i => i.rarity);
check('2 common, 2 uncommon, 2 rare then epics',
      r[0]==='common'&&r[1]==='common'&&r[2]==='uncommon'&&r[3]==='uncommon'&&r[4]==='rare'&&r[5]==='rare'&&r[6]==='epic',
      r.join(','));
check('slot 8 is epic or legendary', r[7]==='epic'||r[7]==='legendary', r[7]);
check('sorted worst-to-best, so it lays out top-left to bottom-right',
      shop.every((it,i) => i===0 || RARITY_RANK(shop[i-1].rarity) <= RARITY_RANK(it.rarity)), r.join(','));
function RARITY_RANK(x){ return ['common','uncommon','rare','epic','legendary'].indexOf(x); }
check('prices match the table', shop.every(i => i.price === C.STORE_PRICE[i.rarity]));
check('no set pieces are ever sold', shop.every(i => i.set === null));
check('commons and uncommons carry no ability',
      shop.slice(0,4).every(i => i.ability === null), shop.slice(0,4).map(i=>i.ability).join(','));

console.log('\nDETERMINISM  (this is what stops rerolling)');
check('same player, same day -> byte-identical shop',
      sig(C.rollDailyStore('player-A', w.key)) === sig(shop));
check('different player -> different shop',
      sig(C.rollDailyStore('player-B', w.key)) !== sig(shop));
check('same player, next day -> different shop',
      sig(C.rollDailyStore('player-A', '2099-01-01')) !== sig(shop));

console.log('\nBONUS SLOT  target 25% legendary');
let leg = 0, N = 40000;
for(let i = 0; i < N; i++) if(C.rollDailyStore('p'+i, '2026-05-05')[7].rarity === 'legendary') leg++;
console.log('  ' + (leg/N*100).toFixed(2) + '% legendary over ' + N + ' players');
check('bonus slot is 25% legendary', Math.abs(leg/N - 0.25) < 0.015, (leg/N*100).toFixed(2)+'%');

console.log('\nSPREAD  no player gets a shop of six identical parts');
let dupHeavy = 0;
for(let i = 0; i < 2000; i++){
  const sh = C.rollDailyStore('spread'+i, '2026-05-05');
  const names = new Set(sh.map(x => x.weapon+'/'+x.slot+'/'+x.name));
  if(names.size <= 3) dupHeavy++;
}
console.log('  ' + dupHeavy + ' of 2000 shops had 3 or fewer distinct parts');
check('shops are varied', dupHeavy < 40, dupHeavy + '/2000');

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
