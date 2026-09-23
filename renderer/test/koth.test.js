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
  + ['AW','MAPS','MODES','KOTH_TEAMS','TEAM_COL','KOTH_TARGET','KOTH_LOCK','KOTH_SQUAD','BOTNAMES']
      .map(liftConst).join('\n') + '\n'
  + ['B','circleRect','stepHill'].map(lift).join('\n'), ctx);

const get = expr => vm.runInContext(expr, ctx);
const AW = get('AW'), AD = get('AD');
const MAPS = get('MAPS'), MODES = get('MODES');
const TEAMS = get('KOTH_TEAMS'), TARGET = get('KOTH_TARGET');
const LOCK = get('KOTH_LOCK'), SQUAD = get('KOTH_SQUAD');

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

if(fails){ console.error('\nkoth: ' + fails + ' failure(s)'); process.exit(1); }
console.log('koth: ok');
