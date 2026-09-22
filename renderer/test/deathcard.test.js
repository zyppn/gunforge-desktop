/* The eliminated-by card, tested without a browser: pull the real function out
   of renderer/index.html and run it against a stub DOM. It is string building
   over data that arrives in two different shapes (a plain object in PvE, a
   flattened MapSchema in live), which is exactly where this breaks quietly.

   node renderer/test/deathcard.test.js                                      */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
let fails = 0;
const check = (l, ok, d) => { console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':'')); if(!ok) fails++; };

/* lift the function out by brace matching, so the test runs the SHIPPED source
   rather than a copy that can drift from it */
function lift(name){
  const start = html.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('not found: ' + name);
  let i = html.indexOf('{', start), depth = 0;
  for(; i < html.length; i++){
    if(html[i] === '{') depth++;
    else if(html[i] === '}'){ depth--; if(depth === 0) return html.slice(start, i+1); }
  }
  throw new Error('unbalanced: ' + name);
}
const core = require('../../server/loadout-core.js');
const ABILITIES = { deadeye:{n:'Deadeye'}, vampiric:{n:'Vampiric Coating'}, swift:{n:'Featherweight'} };
const el = { innerHTML:'', classList:{ _on:false, add(){ this._on = true; }, remove(){ this._on = false; } } };
const sandbox = {
  document: { getElementById: id => id === 'deathcard' ? el : null },
  WEAPONS: core.WEAPONS, ABILITIES, Math,
  LoadoutCore: core,                 // the card reads RESPAWN_MS for its countdown
  G: { elapsed: 0 },
  deathCardUntil: 0,
  DC_SLOTS: ['frame','barrel','magazine','foregrip','stock','optic'],
  headToHead: new Map(),
};
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext([lift('showDeathCard'), lift('hideDeathCard'),
                 lift('noteKill'), lift('resetHeadToHead')].join(';'), sandbox);

console.log('A FULL BUILD');
{
  const eq = {
    frame:   { name:'Forged Frame',  rarity:'legendary', ability:'deadeye' },
    barrel:  { name:'Ghost Bore',    rarity:'legendary', set:'ghost' },
    magazine:{ name:'Compact Mag',   rarity:'epic',      ability:'swift' },
    foregrip:{ name:'Angled Grip',   rarity:'rare',      ability:'vampiric' },
    stock:   { name:'Skeleton Stock',rarity:'uncommon' },
    optic:   { name:'Ghost Lens',    rarity:'legendary', set:'ghost' },
  };
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1', eq, dist:34.4 });
  const h = el.innerHTML;
  check('the card is shown', el.classList._on);
  check('killer name is present', h.includes('ZYPPN'));
  check('the WEAPON is named, not just the id', h.includes('LS-1 Longshot') && h.includes('Sniper'),
        'weapon line');
  check('distance is rounded to metres', h.includes('34m'), '34.4 -> 34m');
  for(const sl of sandbox.DC_SLOTS) check('  slot ' + sl + ' rendered', h.includes('>' + sl + '<'));
  check('every part name appears', ['Forged Frame','Ghost Bore','Compact Mag','Angled Grip',
        'Skeleton Stock','Ghost Lens'].every(n => h.includes(n)));
  const legs = (h.match(/data-r="legendary"/g) || []).length;
  check('rarity drives the colour attribute', legs === 3, legs + ' legendary slots');
  check('abilities are surfaced by display name', h.includes('Deadeye') && h.includes('Featherweight'));
  check('no head-to-head on a first meeting', !h.includes('dc-rec'));
}

console.log('\nMISSING AND UNKNOWN DATA');
{
  sandbox.showDeathCard({ name:'NOBODY', wid:'nosuchgun', eq:{ frame:{name:'Polymer Frame',rarity:'rare'} }, dist:null });
  const h = el.innerHTML;
  check('empty slots render as empty, not undefined', !h.includes('undefined'), 'no undefined in output');
  check('five slots marked empty', (h.match(/dc-slot empty/g) || []).length === 5);
  check('an unknown weapon id degrades gracefully', h.includes('Unknown weapon'));
  check('no distance means no distance chip', !h.includes('dc-dist'));
  sandbox.showDeathCard({});
  check('a totally empty payload does not throw', true);
  check('  and says UNKNOWN', el.innerHTML.includes('UNKNOWN'));
}

console.log('\nHEAD TO HEAD  (yours first, and per MATCH)');
{
  sandbox.resetHeadToHead();
  sandbox.noteKill('RIVAL', true);                       // they killed you
  sandbox.showDeathCard({ name:'RIVAL', wid:'m17', eq:{} });
  let h = el.innerHTML;
  /* Order matters more than it looks. "1 - 7" with no labels is a coin-flip
     read and the wrong guess is the demoralising one, so the card says YOU
     first and names them second. */
  check('reads YOU 0 - 1 RIVAL after one death', h.includes('YOU <b>0</b> – <b>1</b> RIVAL'),
        (h.match(/dc-rec[^>]*>(.*?)<\/div>/s) || ['?'])[0].replace(/<[^>]*>/g,'').trim());
  sandbox.noteKill('RIVAL', false); sandbox.noteKill('RIVAL', false);
  sandbox.showDeathCard({ name:'RIVAL', wid:'m17', eq:{} });
  h = el.innerHTML;
  check('your kills land on YOUR side', h.includes('YOU <b>2</b> – <b>1</b> RIVAL'));
  check('an unnamed killer is not tallied',
        (sandbox.noteKill(null, true), sandbox.headToHead.size === 1));

  /* This is the bug that shipped: the map lived for the lifetime of the page,
     so a fresh match opened showing a record accumulated over an evening -
     across offline and live matches together. */
  sandbox.resetHeadToHead();
  sandbox.showDeathCard({ name:'RIVAL', wid:'m17', eq:{} });
  check('a new match starts the record from nothing', !el.innerHTML.includes('dc-rec'),
        'no record row after reset');
  check('  and the map is actually empty', sandbox.headToHead.size === 0);
}

console.log('\nRESPAWN COUNTDOWN');
{
  sandbox.G.elapsed = 100;
  sandbox.showDeathCard({ name:'ZYPPN', wid:'m17', eq:{} });
  const secs = (core.RESPAWN_MS/1000).toFixed(1);
  check('the card carries the respawn countdown', el.innerHTML.includes('respawning in'));
  check('  seeded with the shared RESPAWN_MS', el.innerHTML.includes('>' + secs + '<'), secs + 's');
  check('  and a deadline is armed off the game clock',
        Math.abs(sandbox.deathCardUntil - (100 + core.RESPAWN_MS/1000)) < 1e-9,
        String(sandbox.deathCardUntil));
  check('4.5s is long enough to read six parts', core.RESPAWN_MS >= 4000,
        core.RESPAWN_MS + 'ms');
}

console.log('\nHIDE');
{ sandbox.hideDeathCard();
  check('hiding clears the visible class', !el.classList._on);
  check('  and disarms the countdown', sandbox.deathCardUntil === 0); }

/* Structural: the reset has to be wired into EVERY match start, not just the
   one I happened to be looking at. This is the check that would have caught
   the record accumulating across a whole evening. */
{
  const starts = (html.match(/\$\('#killfeed'\)\.innerHTML=''/g) || []).length;
  const resets = (html.match(/resetHeadToHead\(\);/g) || []).length;
  console.log('\nWIRING');
  check('every match start clears the head-to-head', starts > 0 && resets >= starts,
        starts + ' match starts, ' + resets + ' resets');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all death card checks passed'));
process.exit(fails ? 1 : 0);
