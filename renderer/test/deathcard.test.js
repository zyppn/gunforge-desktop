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
const RCOL = {common:0x9BA8B0, uncommon:0x5FBF6E, rare:0x4C9BE8, epic:0xB463E8, legendary:0xE8A33D};
// the renderer's SETS, which unlike loadout-core's carry a display name
const SETS = [{id:'ghost', name:'Ghost Protocol', rarity:'legendary'},
              {id:'dragon', name:'Dragonfire', rarity:'epic'}];
const el = { innerHTML:'', classList:{ _on:false, add(){ this._on = true; }, remove(){ this._on = false; } } };
const sandbox = {
  document: { getElementById: id => id === 'deathcard' ? el : null },
  WEAPONS: core.WEAPONS, ABILITIES, Math,
  LoadoutCore: core,                 // the card reads RESPAWN_MS for its countdown
  G: { elapsed: 0 },
  deathCardUntil: 0,
  DC_SLOTS: ['frame','barrel','magazine','foregrip','stock','optic'],
  DC_MODABBR: {dmg:'DMG', rof:'ROF', mag:'MAG', reload:'RLD', spread:'SPR', speed:'SPD'},
  DC_LOWER_BETTER: {spread:1, reload:1},
  DC_W: 400, RCOL, SETS,
  headToHead: new Map(),
};
// no THREE in here, so killWeaponDiagram bails and the card takes its text fallback -
// which is the point: losing WebGL must not cost you the name of whoever killed you
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext([lift('showDeathCard'), lift('hideDeathCard'),
                 lift('noteKill'), lift('resetHeadToHead'),
                 lift('dcHeight'), lift('dcRollText'), lift('dcLayout'),
                 lift('killWeaponDiagram'), lift('dcKey'), lift('esc'), lift('RCOL_CSS'),
                 'let dcRenderer = null, dcGLDead = false; const dcCache = new Map();'
                 ].join(';'), sandbox);

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

console.log('\nHEALTH REMAINING  (how close you came)');
{
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1', eq:{}, hp:33.4 });
  check('shows the killer\'s remaining health', el.innerHTML.includes('health remaining'));
  check('  rounded to a whole percent', el.innerHTML.includes('>33%<'), '33.4 -> 33%');
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1', eq:{}, hp:-4 });
  check('  never negative', el.innerHTML.includes('>0%<'));
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1', eq:{} });
  check('  omitted when unknown, not shown as 0', !el.innerHTML.includes('health remaining'));
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

console.log('\nTHE CARD CANNOT OUTLIVE ITS COUNTDOWN');
{
  const countEl = { textContent:'' };
  sandbox.document.getElementById = id => id === 'deathcard' ? el
                                        : id === 'dc-count' ? countEl : null;
  vm.runInContext(lift('stepDeathCard'), sandbox);
  sandbox.G.elapsed = 0;
  sandbox.showDeathCard({ name:'RIVAL', wid:'m17', eq:{} });
  sandbox.G.elapsed = 2;
  sandbox.stepDeathCard();
  check('ticks down off the game clock', countEl.textContent === '2.5', countEl.textContent);
  check('  and stays up while it does', el.classList._on);
  sandbox.G.elapsed = core.RESPAWN_MS/1000;
  sandbox.stepDeathCard();
  check('never shows a negative countdown', countEl.textContent === '0.0', countEl.textContent);
  /* Campaign stranded the card at "0.0" forever: it is single-life, so the
     respawn that would have taken the card down never came. The gate below
     stops it being shown at all - this is the backstop for everything else. */
  sandbox.G.elapsed = core.RESPAWN_MS/1000 + 2;
  sandbox.stepDeathCard();
  check('takes itself down if no respawn ever arrives', !el.classList._on);
  check('  and disarms the deadline', sandbox.deathCardUntil === 0);
  sandbox.stepDeathCard();
  check('  and is a no-op from then on', true);
}

/* The card is a PvP object: it names who killed you, what they were holding
   and how your record against them stands. Campaign has none of those - one
   life, no respawn, and grunts with no loadout at all. */
console.log('\nCAMPAIGN GETS NO DEATH CARD');
{
  const spy = { shown:0, cam:0, ended:0, notes:[] };
  const mk = o => Object.assign({ x:0, z:0, hp:100, maxhp:100, kills:0, deaths:0,
    dead:false, burnT:0, slowT:0, shield:0, wep:{ abilities:new Set() } }, o);
  const box = {
    Math, Set, G:null, LoadoutCore:core,
    spawnBurst(){}, sfx(){}, feed(){}, damage(){}, hostile(){ return false; },
    startDeathAnim(){}, endMatch(){ spy.ended++; },
    noteKill(n){ spy.notes.push(n); },
    showDeathCard(){ spy.shown++; }, startKillcam(){ spy.cam++; },
  };
  vm.createContext(box);
  vm.runInContext(lift('kill'), box);

  const me = mk({ isPlayer:true, name:'ZYPPN' });
  const grunt = mk({ name:'Hostile', grunt:true });
  box.G = { mode:'camp', elapsed:0, ents:[me, grunt], teamScore:{blue:0,red:0}, me };
  box.kill(me, grunt);
  check('a hostile killing you shows no card', spy.shown === 0, spy.shown + ' cards');
  check('  and no killcam', spy.cam === 0);
  check('  the run ends instead', spy.ended === 1);
  check('  and "Hostile" never enters the head-to-head', spy.notes.length === 0,
        JSON.stringify(spy.notes));

  spy.notes.length = 0;
  box.G.ents = [me, grunt];
  box.kill(grunt, me);
  check('killing hostiles builds no record either', spy.notes.length === 0,
        JSON.stringify(spy.notes));

  spy.shown = spy.cam = spy.ended = 0; spy.notes.length = 0;
  const me2 = mk({ isPlayer:true, name:'ZYPPN', team:'me' });
  const bot = mk({ name:'RIVAL', team:'b0', wid:'ls1', eq:{} });
  box.G = { mode:'ffa', elapsed:0, ents:[me2, bot], teamScore:{blue:0,red:0}, me:me2 };
  box.kill(me2, bot);
  check('a real opponent in FFA still gets the full treatment',
        spy.shown === 1 && spy.cam === 1, spy.shown + ' cards, ' + spy.cam + ' killcams');
  check('  tallied under their name', spy.notes[0] === 'RIVAL');
  check('  and the match carries on', spy.ended === 0);
  check('  with a respawn armed', Math.abs(me2.respawnT - core.RESPAWN_MS/1000) < 1e-9);
}

console.log('\nGRUNTS DO NOT DROP A WEAPON');
{
  const box = { Math, G:{ dying:[] }, dropped:[] };
  box.dropWeaponFromMesh = m => box.dropped.push(m);
  vm.createContext(box);
  vm.runInContext(lift('startDeathAnim'), box);
  box.startDeathAnim({ id:'grunt' }, true);
  check('a hostile drops nothing', box.dropped.length === 0, box.dropped.length + ' drops');
  check('  but still topples', box.G.dying.length === 1);
  const bot = { id:'bot' };
  box.startDeathAnim(bot, false);
  check('a real opponent still drops their gun',
        box.dropped.length === 1 && box.dropped[0] === bot);
  box.startDeathAnim(bot, false);
  check('and one body never queues two animations',
        box.G.dying.filter(d => d.mesh === bot).length === 1);
}

console.log('\nHIDE');
{ sandbox.hideDeathCard();
  check('hiding clears the visible class', !el.classList._on);
  check('  and disarms the countdown', sandbox.deathCardUntil === 0); }

/* Structural: the reset has to be wired into EVERY match start, not just the
   one I happened to be looking at. This is the check that would have caught
   the record accumulating across a whole evening. */
{
  console.log('\nWIRING');
  const starts = (html.match(/\$\('#killfeed'\)\.innerHTML=''/g) || []).length;
  const resets = (html.match(/resetHeadToHead\(\);/g) || []).length;
  const hides = (html.match(/hideDeathCard\(\);/g) || []).length;
  check('every match start clears the head-to-head', starts > 0 && resets >= starts,
        starts + ' match starts, ' + resets + ' resets');
  /* Campaign left a card on screen that the NEXT match then opened with. A
     match start owes the screen a clean slate, and so does a match end. */
  check('every match start also clears the card', hides >= starts + 1,
        starts + ' match starts, ' + hides + ' hides');
  check('and the teardown drops the card and the killcam',
        /G\.running = false;[\s\S]{0,120}hideDeathCard\(\); G\.killcam = null/.test(html));
  /* Offline and live each had their own copy of "this body died", and they
     drifted: live still pushed the OLD 0.32s duration and never dropped a
     weapon, and its respawn reset the transform without cancelling the entry,
     which is what left bodies half buried. One push site keeps them honest. */
  const pushes = (html.match(/G\.dying\.push\(/g) || []).length;
  check('only one place starts a death animation', pushes === 1, pushes + ' push sites');
  const clears = (html.match(/clearDyingMesh\(/g) || []).length;
  check('and both respawn paths cancel it', clears >= 3, clears + ' call sites');
  /* Your own gun and combat HUD must come off screen while the camera is on
     someone else. */
  check('the viewmodel is hidden while dead', /vm\.visible = !me\.dead/.test(html));
  check('the HUD gets a dead state', /classList\.toggle\('dead'/.test(html) &&
        /#hud\.dead #hudbr/.test(html));
}

/* ---- THE WEAPON DIAGRAM ---------------------------------------------------------
   The card now draws the killer's actual gun and runs a leader line from each part to
   the metal it names. There is no WebGL in here, so the render itself is stubbed and
   these exercise the two halves that decide whether the picture is legible: where the
   labels go, and what they say. */
console.log('\nMOD ROLLS');
{
  const t = sandbox.dcRollText({dmg:0.11, spread:0.05});
  check('a roll is abbreviated, not spelled out', t.includes('DMG') && t.includes('SPR'));
  check('and shown as whole percent', t.includes('11%') && t.includes('5%'));
  check('a damage gain reads as a gain', /class="up"[^>]*>\+11% DMG/.test(t));
  /* Lower is better for spread and reload, so judging by the raw sign would paint
     every good roll red. This is the one thing in the formatter that can be wrong
     while still looking plausible. */
  check('MORE spread reads as a loss', /class="dn"[^>]*>\+5% SPR/.test(t));
  check('LESS spread reads as a gain', /class="up"/.test(sandbox.dcRollText({spread:-0.05})));
  check('a faster reload reads as a gain', /class="up"/.test(sandbox.dcRollText({reload:-0.06})));
  check('a slower reload reads as a loss', /class="dn"/.test(sandbox.dcRollText({reload:0.06})));
  check('zero mods produce nothing', sandbox.dcRollText({dmg:0}) === '' && sandbox.dcRollText(null) === '');
}

console.log('\nDIAGRAM HEIGHT');
{
  const h = n => sandbox.dcHeight(n);
  check('a bare weapon gets a short box', h(0) < h(1));
  check('and the box grows with the parts on it', h(6) > h(3) && h(3) > h(1));
  check('but only per ROW, since labels sit two abreast', h(1) === h(2) && h(3) === h(4));
  check('six parts still fit in a sane overlay', h(6) <= 220);
}

console.log('\nLABEL LAYOUT');
{
  const A = {}, eq = {};
  // every part bunched on the left of the frame: the pathological case
  for(const sl of sandbox.DC_SLOTS){
    eq[sl] = { name:sl.toUpperCase(), rarity:'common' };
    A[sl] = { x: 30, y: 20 };
  }
  const cal = sandbox.dcLayout(eq, A, 400, 200);
  check('every fitted part gets a callout', cal.length === 6);
  /* Six labels down one edge would run off the card. Whichever side is over quota
     hands back its most central part. */
  const l = cal.filter(c => c.side === 'l').length;
  check('the columns are balanced even when the parts are not', l === 3, l + ' on the left');
  for(const side of ['l','r']){
    const ys = cal.filter(c => c.side === side).map(c => c.y).sort((a,b)=>a-b);
    let minGap = 1e9;
    for(let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i-1]);
    check('no two ' + side + ' labels land on top of each other', minGap > 40, 'gap ' + minGap);
    check('and they stay inside the box on the ' + side,
          ys[0] > 0 && ys[ys.length-1] < 200);
  }
}
{
  const cal = sandbox.dcLayout({ barrel:{name:'X', rarity:'rare'} },
                               { barrel:{x:200,y:50}, stock:{x:80,y:50} }, 400, 160);
  check('an empty slot gets no callout at all', cal.length === 1);
  check('and a part with nowhere to point gets none either',
        sandbox.dcLayout({ optic:{name:'Y'} }, {}, 400, 160).length === 0);
}

console.log('\nTHE CARD, WITH A DIAGRAM');
{
  // stub the render; the anchors are what the layout and the lines are built from
  sandbox.killWeaponDiagram = (wid, eq, W, H) => ({
    url: 'data:image/png;base64,STUB',
    anchors: { frame:{x:190,y:80}, barrel:{x:250,y:70}, magazine:{x:200,y:110},
               foregrip:{x:225,y:100}, stock:{x:150,y:80}, optic:{x:195,y:55} },
  });
  const eq = {
    barrel:  { name:'Ghost Bore', rarity:'legendary', set:'ghost', mods:{dmg:0.14} },
    optic:   { name:'Ghost Lens', rarity:'legendary', set:'ghost', mods:{spread:-0.08} },
    foregrip:{ name:'Angled Grip', rarity:'rare', ability:'vampiric', mods:{rof:0.03} },
  };
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1', eq, dist:12 });
  const h = sandbox.document.getElementById('deathcard').innerHTML;
  check('the gun is drawn', h.includes('dc-diag') && h.includes('data:image/png;base64,STUB'));
  check('the weapon is still named', h.includes('LS-1 Longshot'));
  check('one leader line per part', (h.match(/<path /g) || []).length === 3);
  check('and a dot on the part it points at', (h.match(/<circle /g) || []).length === 3);
  check('part names carry their rarity', (h.match(/data-r="legendary"/g) || []).length === 2);
  check('rolls ride along under the name', h.includes('DMG') && h.includes('SPR'));
  check('abilities are named but not explained',
        h.includes('Vampiric Coating') && !h.includes('Heal for'));
  /* The ask was explicitly "no text if it is not active" - an inactive set is not
     worth a line on a card you read in four seconds. */
  check('an ACTIVE set is named and marked active',
        /Ghost Protocol: <b>active<\/b>/.test(h));
  sandbox.showDeathCard({ name:'ZYPPN', wid:'ls1',
    eq:{ barrel:{name:'Ghost Bore', rarity:'legendary', set:'ghost'} }, dist:12 });
  check('one piece of a two-piece set says nothing at all',
        !sandbox.document.getElementById('deathcard').innerHTML.includes('active'));
  sandbox.showDeathCard({ name:'ZYPPN', wid:'m17', eq:{}, dist:3 });
  check('a stock weapon says so instead of drawing six empty lines',
        sandbox.document.getElementById('deathcard').innerHTML.includes('No parts fitted'));
  sandbox.killWeaponDiagram = () => null;
}

console.log('\nWIRING, DIAGRAM');
{
  /* The three slot builders that append a GROUP rather than loose meshes had every
     one of their meshes left untagged, so half the callouts silently vanished. */
  check('slot tagging walks the subtree, not just the top level',
        /function vmTag\([\s\S]{0,900}?traverse\(o => \{ o\.userData\.slot = slot; \}\)/.test(html));
  for(const sl of ['frame','barrel','magazine','foregrip','stock','optic'])
    check('  ' + sl + ' is built inside a vmTag', html.includes("vmTag('" + sl + "'"));
  /* Geometry has to be measured before it is disposed, and disposed at all: an
     undisposed weapon per death leaks for the whole session. */
  const dispose = html.indexOf('o.geometry.dispose()');
  const project = html.indexOf('.project(cam)');
  check('the anchors are projected BEFORE the geometry is freed',
        project > 0 && dispose > project);
  /* "contains the string dispose()" is not the claim - a dispose behind if(false)
     satisfies that and still leaks a weapon per death. */
  check('and the geometry IS freed', /if\(o\.geometry\) o\.geometry\.dispose\(\);/.test(html)
        && /m\.forEach\(x => x && x\.dispose && x\.dispose\(\)\)/.test(html));
  check('the diagram is cached, so a rematch does not re-render it',
        /dcCache\.set\(ck, out\)/.test(html) && /dcCache\.has\(ck\)/.test(html));
  check('the cache cannot grow without bound', /dcCache\.size > \d+\) dcCache\.clear/.test(html));
  /* Orthographic is not a style choice: under perspective the projected centre of a
     part at the muzzle sits off the pixels the line is pointing at. */
  check('the diagram camera is orthographic', /OrthographicCamera/.test(html));
  check('losing WebGL still leaves a readable card',
        /dcGLDead = true/.test(html) && /} else \{\s*\n\s*for\(const sl of DC_SLOTS\)/.test(html));
  /* Set pieces roll random mods, so the name cannot reproduce them and the wire has
     to carry them or live kills show a set piece with no numbers. */
  const srv = fs.readFileSync(path.join(__dirname, '../../server/index.js'), 'utf8');
  check('the live wire carries part mods', /mods: 'string'/.test(srv) && /ps\.mods = LoadoutCore\.encodeMods/.test(srv));
  check('and the client decodes them into the card',
        /mods: LoadoutCore\.decodeMods\(q\.mods\)/.test(html));
  const r = core.decodeMods(core.encodeMods({dmg:0.105, spread:-0.058, mag:0}));
  check('the codec round-trips a roll exactly',
        r.dmg === 0.105 && r.spread === -0.058 && !('mag' in r));
  check('and drops anything it does not recognise',
        !('junk' in core.decodeMods('junk:9,dmg:50')) && core.decodeMods('junk:9,dmg:50').dmg === 0.05);
  check('an absent mods string decodes to nothing', Object.keys(core.decodeMods('')).length === 0);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all death card checks passed'));
process.exit(fails ? 1 : 0);
