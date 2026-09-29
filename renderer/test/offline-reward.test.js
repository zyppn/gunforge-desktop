/* A signed-in account that launched without internet must not be paid locally.

   The menu shows the account's cached profile, so ACCOUNT.online is false - and the
   results screen used to take that as "no account" and roll a local reward: a part and
   credits that never existed (the next online launch loads the real profile over them),
   while the match itself was never queued, so its real reward was lost as well.
   Now: an account queues the match and shows SALVAGE PENDING; only a local-only save
   (no account on this PC, or no backend) is paid on the spot.

   node renderer/test/offline-reward.test.js */
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
async function run({ online, account, backend = true }){
  const log = { banked: 0, queued: [], sent: 0, rendered: null, queuedPaint: 0 };
  const me = { kills: 20, deaths: 2 };
  const el = () => ({ classList: { remove(){}, add(){} }, textContent: '' });
  const ctx = vm.createContext({
    Math, JSON, console, setTimeout, Promise,
    G: { running: true, mode: 'ffa', me, ents: [me, { kills: 3 }], map: { name: 'Foundry' }, wave: 0, teamScore: {} },
    P: { level: 55, credits: 11496, inventory: [], stats: { matches: 0, kills: 0, deaths: 0, wins: 0 } },
    ACCOUNT: { online }, paused: false, settingsOpen: false,
    $: () => el(), document: { getElementById: () => null },
    reloadStop(){}, hideDeathCard(){}, releasePointer(){}, leaveFullscreen(){}, uid: () => 'm1',
    HAS_SUPABASE: () => backend, authStore: () => account ? { access_token: 't' } : null,
    rollDrop: () => ({ name: 'Polymer Frame', rarity: 'uncommon' }), grantXp(){}, saveProfile(){ log.banked++; }, refreshChips(){},
    LoadoutCore: { countsForKD: () => true },
    outboxAdd: async e => { log.queued.push(e); }, paintQueued(){ log.queuedPaint++; },
    renderResults(...a){ log.rendered = { drop: a[9], pending: a[10] }; },
    sendReward: async () => { log.sent++; throw new Error('offline'); },
    sessionSuperseded(){}, loadCloudProfile: async () => null, paintServerReward(){},
  });
  vm.runInContext(lift('endMatch'), ctx);
  ctx.endMatch();
  await new Promise(r => setTimeout(r, 20));
  return { log, P: ctx.P };
}
(async () => {
  {
    const { log, P } = await run({ online: false, account: true });
    ok('signed in but launched offline: nothing is paid locally', log.banked === 0 && P.credits === 11496 && !P.inventory.length && log.rendered.drop === null, P.credits + ' CR');
    ok('  the match is queued for the server, once', log.queued.length === 1 && log.queued[0].kills === 20 && log.sent === 0);
    ok('  and the screen shows SALVAGE PENDING, not a reward', log.rendered.pending === true && log.queuedPaint === 1);
  }
  {
    const { log } = await run({ online: true, account: true });
    ok('online, server unreachable at the end: sent, then queued', log.sent === 1 && log.queued.length === 1 && log.banked === 0);
  }
  {
    const { log, P } = await run({ online: false, account: false });
    ok('no account on this PC: the local save is paid on the spot (as before)', log.banked === 1 && log.queued.length === 0 && log.rendered.drop && log.rendered.pending === false, P.credits + ' CR');
  }
  {
    const { log } = await run({ online: false, account: true, backend: false });
    ok('no backend configured at all: local save as well', log.banked === 1 && log.queued.length === 0);
  }
  console.log(fails ? '\noffline-reward: ' + fails + ' failure(s)' : '\noffline-reward: all clear');
  process.exit(fails ? 1 : 0);
})();
