/* Which modes write to the career kill/death record.

   K/D reads as a claim about how you do against other people on even terms.
   Campaign is a horde mode, so kills are free and a death ends the run; TDM and KotH
   are objective modes where trading your life for the point is the correct play, and
   a record that punishes that teaches people to stop playing the objective. Only FFA
   and Live Arena feed it.

   The failure mode this guards is not a crash. Stats are banked in FOUR places - the
   client when offline, the client's live fallback, /reward/offline on the server, and
   the live room - and if any one of them keeps its own copy of the rule, your K/D
   starts depending on whether you happened to be signed in. So these check the rule
   once and then check that nobody wrote it down a second time. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const html   = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'server', 'loadout-core.js'), 'utf8');
const vendor  = fs.readFileSync(path.join(ROOT, 'renderer', 'vendor', 'loadout-core.js'), 'utf8');
const Core = require(path.join(ROOT, 'server', 'loadout-core.js'));

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

/* ---- 1. the rule ---- */
ok('free-for-all counts',            Core.countsForKD('ffa') === true);
ok('live arena counts',              Core.countsForKD('live') === true);
ok('team deathmatch does not',       Core.countsForKD('tdm') === false);
ok('king of the hill does not',      Core.countsForKD('koth') === false);
ok('campaign does not',              Core.countsForKD('camp') === false);
ok('and neither does a mode that does not exist', Core.countsForKD('nonsense') === false);
ok('nor undefined, null or a number', !Core.countsForKD(undefined)
   && !Core.countsForKD(null) && !Core.countsForKD(0));
ok('the list is exactly those two', Core.KD_MODES.slice().sort().join(',') === 'ffa,live');

/* Every mode the menu offers is accounted for: a new mode added to MODES without a
   thought about K/D should show up here rather than silently defaulting to "no". */
{
  const m = html.match(/const MODES = \[[\s\S]*?\n\];/);
  ok('MODES is still findable', !!m);
  const ids = m ? (m[0].match(/id:'([a-z]+)'/g) || []).map(x => x.slice(4, -1)) : [];
  ok('the menu offers the five modes this rule was written against ('+ids.join(',')+')',
     ids.slice().sort().join(',') === 'camp,ffa,koth,live,tdm');
  for(const id of Core.KD_MODES)
    ok('KD_MODES entry "' + id + '" is a mode that actually exists', ids.indexOf(id) >= 0);
}

/* ---- 2. one definition, not four ----
   The shared copy has to BE shared, or the client and server can drift. */
ok('loadout-core is byte-identical to the copy the renderer loads', coreSrc === vendor);
ok('countsForKD is exported, not just defined', /countsForKD/.test(coreSrc.split('const api =')[1] || ''));

/* Nobody may re-list the modes locally. A literal 'ffa' next to a stats write is the
   shape this bug comes back in. */
for(const [label, src] of [['the renderer', html], ['the server', server]]){
  const lines = src.split('\n');
  const bad = [];
  lines.forEach((ln, i) => {
    if(!/stats(Delta)?\b/.test(ln)) return;
    if(!/kills|deaths/.test(ln)) return;
    if(/countsForKD/.test(ln)) return;
    // a write that neither asks the shared rule nor is guarded by it on the line above
    if(/countsForKD/.test(lines[i-1] || '')) return;
    if(/\+=|:\s*(r\.)?(kills|deaths)/.test(ln)) bad.push((i+1) + ': ' + ln.trim());
  });
  ok('every K/D write in ' + label + ' goes through countsForKD'
     + (bad.length ? ' — unguarded: ' + bad.join(' | ') : ''), bad.length === 0);
}

/* ---- 3. all four banking sites ---- */
ok('the offline client bank asks the shared rule',
   /P\.stats\.matches\+\+;[\s\S]{0,400}?countsForKD\(mode\)\)\{ P\.stats\.kills/.test(html));
ok('the live-arena client fallback asks it too',
   /countsForKD\('live'\)\)\{ P\.stats\.kills/.test(html));
ok('/reward/offline asks it', /countsForKD\(mode\)\)\{ statsDelta\.kills/.test(server));
ok('the live room asks it', /countsForKD\('live'\)\)\{ statsDelta\.kills = r\.kills/.test(server));

/* ---- 4. matches and wins are NOT gated ----
   The ask was about K/D. A campaign run still happened. */
ok('the offline bank still counts the match', /P\.stats\.matches\+\+;/.test(html));
ok('/reward/offline still counts the match and the win',
   /statsDelta = \{ matches: 1, wins: win \? 1 : 0 \}/.test(server));
ok('the live room still counts the match and the win',
   /statsDelta = \{ matches: 1, wins: place===1 \? 1 : 0 \}/.test(server));

/* ---- 5. a skipped K/D omits the keys rather than sending zeros ----
   add_progress lives in the database, not in this repo, so "it is additive" is a
   comment and not something any test here can verify. Under an additive function
   zero and absent are the same; under a merge, zero would overwrite a career total
   and absent cannot. Absent is the only spelling that is safe under both. */
for(const m of ['tdm', 'koth', 'camp']){
  const d = { matches: 1, wins: 0 };
  if(Core.countsForKD(m)){ d.kills = 9; d.deaths = 9; }
  ok('a ' + m + ' result carries no kills key at all', !('kills' in d));
  ok('and no deaths key at all', !('deaths' in d));
}
ok('the server never sends a hardcoded zero for kills',
   !/statsDelta[\s\S]{0,120}kills:\s*(kd \? [a-z.]+ : )?0/.test(server));

/* ---- 6. the player is told ---- */
ok('the service record says which modes feed K/D',
   /K \/ D counts/.test(html) && /KD_MODES\.map/.test(html));

if(fails){ console.error('\nkd: ' + fails + ' failure(s)'); process.exit(1); }
console.log('kd: ok');
