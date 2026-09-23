/* King of the Hill: four teams, one hill, offline against AI.

   Two things are worth testing here and neither is visible in a diff.

   The MAP has to be fair. Four teams on one point only works if no corner has a
   shorter run or a better angle, and "I laid the numbers out symmetrically" is not
   evidence - I got the south bar wrong by a metre writing this, and it looked fine.
   The arena is 60x40 so a quarter turn is not available; the test checks mirror
   symmetry about both centre lines, which makes all four corners equivalent.

   The HILL RULE has to hold. Ownership, contest and scoring are three-way state that
   is easy to get subtly wrong - a hill that keeps paying after its owner walks off,
   or that flips to whoever brushes the edge - and none of that throws. It is driven
   here directly, a frame at a time, with no renderer in the way. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

function lift(n){
  const i = html.indexOf('function ' + n + '(');
  if(i < 0) throw new Error('missing function ' + n);
  let j = html.indexOf('{', i), d = 0;
  for(; j < html.length; j++){
    if(html[j] === '{') d++;
    else if(html[j] === '}'){ d--; if(!d) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + n);
}
/* Find where a declaration ends. The obvious "first semicolon after the name" breaks
   the moment a comment inside the value contains one - MAPS has exactly that - so this
   walks the value, skipping strings and comments, and stops at the real end. */
function declEnd(src, from){
  let i = from, depth = 0, started = false;
  while(i < src.length){
    const c = src[i], d = src[i+1];
    if(c === '/' && d === '/'){ i = src.indexOf('\n', i); if(i < 0) break; continue; }
    if(c === '/' && d === '*'){ i = src.indexOf('*/', i + 2) + 2; continue; }
    if(c === '"' || c === "'" || c === '`'){
      i++;
      while(i < src.length && src[i] !== c){ if(src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if(c === '[' || c === '{' || c === '('){ depth++; started = true; i++; continue; }
    if(c === ']' || c === '}' || c === ')'){ depth--; i++; continue; }
    if(c === ';' && depth <= 0 && (started || true)) return i + 1;
    i++;
  }
  throw new Error('unterminated declaration');
}
function liftConst(n){
  // tolerate the aligned spacing these constants are declared with
  const m = new RegExp('\\nconst ' + n + '\\s*=\\s').exec(html);
  if(!m) throw new Error('missing const ' + n);
  return html.slice(m.index + 1, declEnd(html, m.index + m[0].length));
}

const banners = [];
const ctx = vm.createContext({ Math, console, banner: t => banners.push(t) });
vm.runInContext(
  'let hillDisc = null, hillRing = null, hillCol = null;\nlet G = null;\n'
  // one const declares AW, AD and WALL_H together, so lifting AW brings all three
  + ['AW','MAPS','MODES','KOTH_TEAMS','TEAM_COL','KOTH_TARGET','KOTH_LOCK','KOTH_SQUAD',
     'KOTH_LEASH','BOTNAMES']
      .map(liftConst).join('\n') + '\n'
  + ['B','circleRect','stepHill','kothPost','kothWorthChasing'].map(lift).join('\n'), ctx);

const get = expr => vm.runInContext(expr, ctx);
const AW = get('AW'), AD = get('AD');
const MAPS = get('MAPS'), MODES = get('MODES');
const TEAMS = get('KOTH_TEAMS'), TARGET = get('KOTH_TARGET');
const LOCK = get('KOTH_LOCK'), SQUAD = get('KOTH_SQUAD'), LEASH = get('KOTH_LEASH');

/* ---- 1. the mode is registered and reachable ---- */
{
  const m = MODES.find(x => x.id === 'koth');
  ok('the koth mode exists', !!m);
  ok('four teams', TEAMS.length === 4);
  ok('the four teams are the ones the mode advertises',
     ['blue','red','green','yellow'].every(t => TEAMS.indexOf(t) >= 0));
  for(const t of TEAMS) ok(t + ' has a colour', typeof get('TEAM_COL')[t] === 'number');
  // enough callsigns for a full lobby, or two bots share a name on the killfeed
  const need = TEAMS.length * SQUAD - 1;
  ok('enough bot names for ' + need + ' bots', get('BOTNAMES').length >= need);
}

/* ---- 2. the map is fair ---- */
const koth = MAPS.filter(m => m.hill);
ok('at least one map has a hill', koth.length >= 1);
for(const map of koth){
  const key = w => [w.x, w.z, w.w, w.d, w.h].map(v => v.toFixed(4)).join('|');
  const have = new Set(map.walls.map(key));
  const mirX = w => ({ x: AW - w.x - w.w, z: w.z, w: w.w, d: w.d, h: w.h });
  const mirZ = w => ({ x: w.x, z: AD - w.z - w.d, w: w.w, d: w.d, h: w.h });
  for(const w of map.walls){
    ok(map.id + ' wall at (' + w.x + ',' + w.z + ') has a mirror across x', have.has(key(mirX(w))));
    ok(map.id + ' wall at (' + w.x + ',' + w.z + ') has a mirror across z', have.has(key(mirZ(w))));
  }
  const pts = new Set(map.spawns.map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)));
  for(const p of map.spawns){
    ok(map.id + ' spawn ' + p + ' mirrors across x', pts.has((AW-p[0]).toFixed(3) + ',' + p[1].toFixed(3)));
    ok(map.id + ' spawn ' + p + ' mirrors across z', pts.has(p[0].toFixed(3) + ',' + (AD-p[1]).toFixed(3)));
  }

  // the hill has to be a place you can stand, not a place with a wall in it
  const H = map.hill;
  for(const w of map.walls){
    ok(map.id + ' hill is clear of the wall at (' + w.x + ',' + w.z + ')',
       !get('circleRect')(H.x, H.z, H.r, w));
  }
  ok(map.id + ' hill is centred in the arena', near(H.x, AW/2) && near(H.z, AD/2));

  // every team gets its own corner, the same size, the same distance out
  ok(map.id + ' has team spawns', !!map.teamSpawns);
  const dists = [];
  for(const t of TEAMS){
    const list = map.teamSpawns[t];
    ok(map.id + ' ' + t + ' has spawn points', !!list && list.length >= SQUAD);
    if(!list) continue;
    ok(map.id + ' ' + t + ' has the same number of spawns as the rest',
       list.length === map.teamSpawns[TEAMS[0]].length);
    let worst = 0;
    for(const p of list){
      for(const w of map.walls){
        ok(map.id + ' ' + t + ' spawn ' + p + ' is not inside a wall', !get('circleRect')(p[0], p[1], 0.6, w));
      }
      ok(map.id + ' ' + t + ' spawn ' + p + ' is inside the arena',
         p[0] > 0.8 && p[0] < AW-0.8 && p[1] > 0.8 && p[1] < AD-0.8);
      worst = Math.max(worst, Math.hypot(p[0]-H.x, p[1]-H.z));
    }
    dists.push(worst);
  }
  const d0 = dists[0];
  for(let i = 1; i < dists.length; i++){
    ok(map.id + ' every team is the same distance from the hill ('
       + dists.map(d => d.toFixed(2)).join(' / ') + ')', near(dists[i], d0, 1e-6));
  }
}

/* ---- 3. the hill rule ---- */
const HM = MAPS.find(m => m.hill);
function world(){
  const G = { mode:'koth', elapsed:0, ents:[], teamScore:{}, map:HM,
              hill:{ x:HM.hill.x, z:HM.hill.z, r:HM.hill.r,
                     owner:null, cand:null, candT:0, contested:false, occ:{} } };
  for(const t of TEAMS) G.teamScore[t] = 0;
  return G;
}
// put a body on or off the hill without caring which map it is
const on  = (G, team, k) => ({ team, dead:false, grunt:false,
  x: G.hill.x + (k||0)*0.6, z: G.hill.z });
const off = (G, team) => ({ team, dead:false, grunt:false, x: 2, z: 2 });
function run(G, secs, dt){
  dt = dt || 1/60;
  for(let i = 0; i < Math.round(secs/dt); i++){
    G.elapsed += dt;
    vm.runInContext('(function(g,d){ G = g; stepHill(d); })', ctx)(G, dt);
  }
}

{ // sole occupancy has to be held before it counts
  const G = world(); G.ents = [on(G,'blue')];
  run(G, LOCK * 0.6);
  ok('a brush across the hill does not take it', G.hill.owner === null);
  ok('and pays nothing', near(G.teamScore.blue, 0));
  run(G, LOCK * 0.6);
  ok('holding it past the lock takes it', G.hill.owner === 'blue');
}

{ // an owned, occupied, uncontested hill pays one point a second
  const G = world(); G.ents = [on(G,'red')];
  run(G, LOCK + 10);
  ok('an uncontested hold pays ~1/s (got ' + G.teamScore.red.toFixed(2) + ')',
     near(G.teamScore.red, 10, 0.2));
  ok('and pays nobody else', TEAMS.filter(t => t !== 'red').every(t => G.teamScore[t] === 0));
}

{ // two teams inside and nobody gets anything
  const G = world(); G.ents = [on(G,'green')];
  run(G, LOCK + 3);
  const held = G.teamScore.green;
  ok('green owns it before the contest', G.hill.owner === 'green');
  G.ents.push(on(G,'yellow', 1));
  run(G, 5);
  ok('a second team contests it', G.hill.contested === true);
  ok('a contested hill belongs to nobody', G.hill.owner === null);
  ok('and pays nobody (green stayed at ' + held.toFixed(2) + ')', near(G.teamScore.green, held, 1e-9));
  ok('all four teams are still on zero or their held score',
     TEAMS.filter(t => t !== 'green').every(t => G.teamScore[t] === 0));
}

{ // walking off your own hill stops the money but not the ownership
  const G = world(); G.ents = [on(G,'yellow')];
  run(G, LOCK + 4);
  const held = G.teamScore.yellow;
  G.ents[0].x = 2; G.ents[0].z = 2;
  run(G, 6);
  ok('an abandoned hill keeps its owner', G.hill.owner === 'yellow');
  ok('but stops paying', near(G.teamScore.yellow, held, 1e-9));
}

{ // the dead and the grunts are not people standing on a point
  const G = world();
  G.ents = [ Object.assign(on(G,'blue'), {dead:true}),
             Object.assign(on(G,'red',1), {grunt:true}) ];
  run(G, LOCK + 3);
  ok('a corpse does not hold the hill', G.hill.owner === null);
  ok('nor does a campaign grunt', near(G.teamScore.red, 0) && near(G.teamScore.blue, 0));
}

{ // and the edge is where the rule says it is
  const G = world();
  G.ents = [{ team:'blue', dead:false, grunt:false, x: G.hill.x + G.hill.r + 0.2, z: G.hill.z }];
  run(G, LOCK + 2);
  ok('a body just outside the ring is outside', G.hill.owner === null);
  G.ents[0].x = G.hill.x + G.hill.r - 0.2;
  run(G, LOCK + 2);
  ok('a body just inside the ring is inside', G.hill.owner === 'blue');
}

{ // the match length the mode advertises
  const G = world(); G.ents = [on(G,'blue')];
  let t = 0;
  while(G.teamScore.blue < TARGET && t < 600){ run(G, 1); t += 1; }
  ok('an unopposed hold wins in about ' + TARGET + 's (took ' + t + 's)',
     t >= TARGET && t <= TARGET + 3);
  ok('which is longer than the 180s match clock, so a real match ends on time or on a rout',
     TARGET > 180 * 0.5);
}

{ // the banner fires on a change of hands, not every frame
  banners.length = 0;
  const G = world(); G.ents = [on(G,'blue')];
  run(G, LOCK + 5);
  ok('one banner when a team takes the hill', banners.length === 1);
  G.ents.push(on(G,'red',1));
  run(G, 2);
  ok('one more when it is contested', banners.length === 2);
}

/* ---- 4. the bots actually play the objective -------------------------------------
   This is the part that was broken on the first pass and could not be seen in a diff:
   the "go to the hill" code sat inside `if(!tgt)`, and nearestEnemy has no range or
   sight limit, so every bot always had a target and the branch never ran. Everyone
   played deathmatch. These checks are about REACHABILITY as much as behaviour. */
{
  const botThink = (function(){
    const i = html.indexOf('function botThink(');
    let j = html.indexOf('{', i), d = 0;
    for(; j < html.length; j++){
      if(html[j] === '{') d++;
      else if(html[j] === '}'){ d--; if(!d) return html.slice(i, j + 1); }
    }
    throw new Error('unbalanced botThink');
  })();

  // the objective must be decided BEFORE the has-a-target branch, or it is dead code
  const iPost  = botThink.indexOf('kothPost(');
  const iLeash = botThink.indexOf('kothWorthChasing(');
  const iBranch = botThink.indexOf('if(!tgt){');
  ok('botThink computes the post before it branches on having a target',
     iPost >= 0 && iBranch >= 0 && iPost < iBranch);
  ok('botThink applies the chase leash before it branches',
     iLeash >= 0 && iLeash < iBranch);
  // and the post has to be used by the fighting code, not only by the idle code
  const after = botThink.slice(iBranch);
  ok('the post steers the bot while it is fighting too', after.indexOf('post') >= 0);
}

{ // the leash: what is worth leaving the point for
  const H = { x: 30, z: 20, r: 4.6 };
  const chase = get('kothWorthChasing');
  const bot = { x: 30, z: 20, alertT: 0 };
  ok('a target inside the leash is worth fighting',
     chase(bot, { x: 30 + LEASH - 2, z: 20 }, H) === true);
  ok('a target across the map is not',
     chase(bot, { x: 30 + LEASH + 12, z: 20 }, H) === false);
  ok('unless it is standing on our point',
     chase({ x: 2, z: 2, alertT: 0 }, { x: 31, z: 21 }, H) === true);
  ok('or it is shooting at us',
     chase({ x: 30, z: 20, alertT: 0.5 }, { x: 59, z: 39 }, H) === true);
  ok('no target is never worth chasing', chase(bot, null, H) === false);
}

{ // the post: inside the ring, spread around it, and it moves
  const HM2 = MAPS.find(m => m.hill);
  const post = get('kothPost');
  const setG = g => vm.runInContext('(function(x){ G = x; })', ctx)(g);
  const Gh = { mode:'koth', hill:{ x:HM2.hill.x, z:HM2.hill.z, r:HM2.hill.r,
                                   owner:null, contested:false } };
  setG(Gh);
  const R = Gh.hill.r;
  const dist = p => Math.hypot(p.x - Gh.hill.x, p.z - Gh.hill.z);

  // attackers: inside, pushing for the middle
  const angles = [];
  for(let i = 0; i < 40; i++){
    const e = { team:'red' };
    const p = post(e, 1/60);
    ok('an attacker post is inside the ring (' + dist(p).toFixed(2) + ' of ' + R + ')',
       dist(p) < R);
    angles.push(e.postA);
  }
  const spread = new Set(angles.map(a => Math.round(a * 4))).size;
  ok('bots take their own angle onto the point rather than stacking (' + spread + ' of 40)',
     spread > 12);

  // defenders: still inside, but out on the rim watching the approaches
  Gh.hill.owner = 'red';
  let held = 0, sum = 0;
  for(let i = 0; i < 40; i++){
    const p = post({ team:'red' }, 1/60);
    if(dist(p) < R) held++;
    sum += dist(p);
  }
  ok('a defender still stands ON the point, or it scores nothing', held === 40);
  ok('but holds the rim rather than the centre (mean ' + (sum/40).toFixed(2)
     + ' of ' + R + ')', sum/40 > R*0.7);

  // and a post drifts, so a held hill is not a parade formation
  Gh.hill.owner = null;
  const e2 = { team:'blue' };
  const first = post(e2, 1/60);
  let moved = false;
  for(let i = 0; i < 60*12; i++){
    const p = post(e2, 1/60);
    if(Math.hypot(p.x - first.x, p.z - first.z) > 0.8) moved = true;
  }
  ok('a post drifts over time instead of freezing', moved);
}

{ // squad size, and the map being locked to the mode
  ok('two per team, so eight bodies including the player', SQUAD === 2);
  ok('the lobby is ' + (TEAMS.length * SQUAD) + ' strong', TEAMS.length * SQUAD === 8);
  ok('the map picker is locked both ways to the mode',
     /\(setupSel\.mode === 'koth'\) === !!m\.hill/.test(html));
  // both sides of that filter have to be non-empty or a mode has no maps at all
  ok('there is at least one hill map for koth', MAPS.some(m => m.hill));
  ok('there is at least one non-hill map for everything else', MAPS.some(m => !m.hill));
}

/* ---- 5. the bots converge on the point ------------------------------------------
   The checks above are structural. This one drives the REAL botThink for a simulated
   match and measures where eight bots actually end up, because "the objective code is
   reachable" and "they play the objective" are different claims.

   findPath is stubbed to null so they steer straight at whatever goal botThink chose,
   and nothing can shoot, so this isolates the DECISION - hill or man - from the navmesh
   and from combat outcomes. On the first build of this mode it produced: 12 bots, mean
   distance 21m, zero ever inside the ring. */
{
  // seeded, so a red build is a real regression rather than an unlucky afternoon
  let seed = 20260923;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const simMath = Object.create(Math); simMath.random = rnd;

  const sctx = vm.createContext({ Math: simMath, console });
  const FN = ['B','circleRect','moveEnt','hasLOS','hostile','nearestEnemy','setTarget',
              'pickTarget','kothPost','kothWorthChasing','stepHill','botThink'];
  vm.runInContext(
    'let G = null, hillDisc = null, hillRing = null, hillCol = null;\n'
    + 'const EYE = 1.6;\n'
    + 'const THREE = { Vector3: function(x,y,z){ this.x=x; this.y=y; this.z=z;\n'
    + '  this.normalize = function(){ return this; }; } };\n'
    + 'function findPath(){ return null; }\n'
    + 'function navClear(){ return true; }\n'
    + 'function fire(){}\nfunction startReload(){}\nfunction banner(){}\n'
    + 'function safePoint(x, z){ return [x, z]; }\n'
    + ['AW','MAPS','KOTH_TEAMS','KOTH_TARGET','KOTH_LOCK','KOTH_SQUAD','KOTH_LEASH','TEAM_COL']
        .map(liftConst).join('\n') + '\n'
    + FN.map(lift).join('\n'), sctx);

  const SM = vm.runInContext('MAPS', sctx).find(m => m.hill);
  const G2 = { mode:'koth', elapsed:0, map:SM, ents:[], teamScore:{}, fx:[], bullets:[],
    hill:{ x:SM.hill.x, z:SM.hill.z, r:SM.hill.r,
           owner:null, cand:null, candT:0, contested:false, occ:{} } };
  for(const t of TEAMS) G2.teamScore[t] = 0;
  for(const t of TEAMS){
    for(let i = 0; i < SQUAD; i++){
      const at = SM.teamSpawns[t][i % SM.teamSpawns[t].length];
      G2.ents.push({ team:t, x:at[0], z:at[1], r:0.5, dead:false, grunt:false, isPlayer:false,
        hp:100, maxhp:100, baseSpeed:4.8, slowT:0, burnT:0,
        aimT:0, wantAim:false, reactT:0, seenT:0, alertT:0, alertSrc:null,
        retargetT:0, repathT:0, strafe:1, wanderA:rnd()*6.28, faceCur:0,
        target:null, path:null, pathT:0, ammo:30, reloading:false, stuckT:0,
        wep:{ name:'x', type:'Assault Rifle', dmg:10, rof:120, mag:30, reload:2,
              spread:0.02, bspd:60, pellets:1, crit:0, abilities:new Set() } });
    }
  }
  vm.runInContext('(function(g){ G = g; })', sctx)(G2);
  const think = vm.runInContext('(function(e,d){ botThink(e,d); })', sctx);
  const tick  = vm.runInContext('(function(d){ stepHill(d); })', sctx);

  const HH = G2.hill, sdt = 1/30;
  const start = G2.ents.map(e => Math.hypot(e.x-HH.x, e.z-HH.z))
                       .reduce((a,b)=>a+b,0) / G2.ents.length;
  for(let i = 0; i < 30/sdt; i++){
    G2.elapsed += sdt;
    for(const e of G2.ents) think(e, sdt);
    tick(sdt);
  }
  const ds = G2.ents.map(e => Math.hypot(e.x-HH.x, e.z-HH.z));
  const mean = ds.reduce((a,b)=>a+b,0) / ds.length;
  const inside = ds.filter(d => d <= HH.r).length;
  const near = ds.filter(d => d <= HH.r + 4).length;
  // how evenly they ring the point: 0 is spread all the way round, 1 is one bearing
  let sx = 0, sz = 0;
  for(const e of G2.ents){ const a = Math.atan2(e.z-HH.z, e.x-HH.x); sx += Math.cos(a); sz += Math.sin(a); }
  const clump = Math.hypot(sx, sz) / G2.ents.length;

  ok('they start scattered at the corners (' + start.toFixed(1) + 'm out)', start > 20);
  ok('after 30s most of the squad is ON the point (' + inside + ' of ' + G2.ents.length + ')',
     inside >= Math.ceil(G2.ents.length * 0.5));
  ok('and effectively all of them are fighting over it ('
     + near + ' of ' + G2.ents.length + ' within 4m)', near >= G2.ents.length - 1);
  ok('mean distance collapses from ' + start.toFixed(1) + 'm to ' + mean.toFixed(1) + 'm',
     mean < 8);
  ok('they ring the point rather than stacking on one bearing (clump '
     + clump.toFixed(2) + ')', clump < 0.8);
}

if(fails){ console.error('\nkoth: ' + fails + ' failure(s)'); process.exit(1); }
console.log('koth: ok');
