/* Reloads that match what is actually in the gun.

   The Warden loads shell by shell: topping up 2 of 6 is quick, a reload from empty takes
   the full reload time (and only that one racks the pump), the count climbs as each
   shell goes in, and pulling the trigger mid-load fires what is already loaded.
   Magazine guns are untouched: always the full time, always a full mag.

   node renderer/test/reload.test.js */
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
const sounds = [];
const ctx = vm.createContext({ Math, G: { elapsed: 0, me: null }, reloadStops: 0,
  reloadSound: (type, ms, ear, own, plan) => sounds.push({ type, ms, own, plan }), reloadStop(){ ctx.reloadStops++; }, earAt: () => ({ vol: 1 }) });
vm.runInContext([line(/const SHELL = \{[^\n]*;/), ...['reloadPlan', 'startReload', 'reloadTick', 'reloadInterruptible', 'interruptReload'].map(lift)].join('\n'), ctx);
const warden = { wep: { type: 'Shotgun', reload: 2000, mag: 6 }, isPlayer: true, x: 0, z: 0 };
const run = (e, secs) => { const step = 1 / 60; for(let t = 0; t < secs; t += step){ ctx.G.elapsed += step; ctx.reloadTick(e); } };

{
  const e = Object.assign({}, warden, { ammo: 0 }); ctx.G.elapsed = 0; sounds.length = 0;
  ctx.startReload(e);
  ok('from EMPTY: the full reload time (2.0s)', Math.abs(e.reloadDur - 2.0) < 1e-9, e.reloadDur);
  ok('  six shells and the pump in the sound', sounds[0].plan.shells === 6 && sounds[0].plan.pump === true);
  run(e, 1.0);
  ok('  the count climbs as each shell goes in', e.ammo > 0 && e.ammo < 6 && e.reloading, e.ammo);
  run(e, 1.1);
  ok('  and it ends full', !e.reloading && e.ammo === 6);
}
{
  const e = Object.assign({}, warden, { ammo: 4 }); ctx.G.elapsed = 0; sounds.length = 0;
  ctx.startReload(e);
  ok('4 of 6 left: loads just 2 shells, no pump', sounds[0].plan.shells === 2 && sounds[0].plan.pump === false);
  ok('  and takes well under half the time (0.84s vs 2.0s)', Math.abs(e.reloadDur - 0.84) < 1e-9, e.reloadDur.toFixed(2) + 's');
  run(e, 0.9);
  ok('  ends full', !e.reloading && e.ammo === 6);
}
{
  const e = Object.assign({}, warden, { ammo: 5 }); ctx.G.elapsed = 0; sounds.length = 0;
  ctx.startReload(e);
  ok('one missing: one shell, the quickest reload (0.6s)', sounds[0].plan.shells === 1 && Math.abs(e.reloadDur - 0.6) < 1e-9, e.reloadDur.toFixed(2) + 's');
}
{
  const e = Object.assign({}, warden, { ammo: 6 }); sounds.length = 0;
  ctx.startReload(e);
  ok('a full gun does not reload at all', !e.reloading && sounds.length === 0);
}
{
  const e = Object.assign({}, warden, { ammo: 0 }); ctx.G.elapsed = 0; ctx.reloadStops = 0;
  ctx.startReload(e); run(e, 0.75);
  const loaded = e.ammo;
  ok('mid-load with shells in: firing is allowed...', ctx.reloadInterruptible(e) && loaded >= 2, loaded + ' loaded');
  ctx.interruptReload(e);
  ok('  ...and stops the reload, keeping what was loaded (and its sound stops)', !e.reloading && e.ammo === loaded && ctx.reloadStops === 1);
  const e2 = Object.assign({}, warden, { ammo: 0 }); ctx.G.elapsed = 0; ctx.startReload(e2); run(e2, 0.1);
  ok('  but not before the first shell is in', !ctx.reloadInterruptible(e2));
}
{
  const rifle = { wep: { type: 'Assault Rifle', reload: 1700, mag: 30 }, isPlayer: true, ammo: 25, x: 0, z: 0 };
  ctx.G.elapsed = 0; ctx.startReload(rifle);
  ok('magazine guns are unchanged: full time even with 25 of 30 left', Math.abs(rifle.reloadDur - 1.7) < 1e-9 && !rifle.shells);
  ok('  and cannot be fired mid-reload', !ctx.reloadInterruptible(rifle));
}
{
  const fast = Object.assign({}, warden, { wep: { type: 'Shotgun', reload: 1400, mag: 6 }, ammo: 0 }); ctx.G.elapsed = 0; ctx.startReload(fast);
  ok('parts that speed up the reload speed up every shell (empty = the modded stat, 1.4s)', Math.abs(fast.reloadDur - 1.4) < 1e-9);
}
ok('both reload-completion paths go through reloadTick (no second copy to drift)', (html.match(/reloadTick\((G\.me|e)\);/g) || []).length === 2 && !/G\.me\.ammo = G\.me\.wep\.mag;/.test(html));
ok('firing interrupts a shell reload, offline and live', /if\(reloadInterruptible\(e\) && now >= e\.fireT\) interruptReload\(e\);/.test(lift('fire')) && /\(!me\.reloading \|\| reloadInterruptible\(me\)\)/.test(html));
ok('the reload animation follows the real length', /const dur = me\.reloadDur \|\| me\.wep\.reload\/1000;/.test(html));
console.log(fails ? '\nreload: ' + fails + ' failure(s)' : '\nreload: all clear');
process.exit(fails ? 1 : 0);
