/* Five PvP-only bugs, four of which were the same shape: logic written against the
   OFFLINE world silently does nothing in a live match, because there the server owns
   state, the client never runs damage() on itself, and every other player lives in
   live.remotes rather than G.ents. Nothing here throws offline, so nothing catches it
   except playing a real match. These pin the live paths specifically. */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const srv  = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'index.js'), 'utf8');
let fails = 0;
const ok = (n, c) => { if(!c){ console.error('  FAIL  ' + n); fails++; } };

/* 1. a burn kill belongs to whoever lit it, even if they died first */
ok('burn credit does not require the lighter to be alive',
   !/if\(src && !src\.dead && srcId !== id\)/.test(srv));
ok('burn credit still refuses self-ignite', /src && srcId !== id/.test(srv));
ok('a dead killer does not bank a shield', /killshield'\) >= 0 && !p\.dead/.test(srv));

/* 2. the killcam follows the body that is DRAWN, not the 30Hz schema behind it */
ok('killcam takes a remote id', /function startKillcam\(target, rid\)/.test(html));
ok('the live death path passes it', /startKillcam\(k, m\.killerId\)/.test(html));
ok('it reads the smoothed position', /const tx = r \? r\.cx : t\.x, tz = r \? r\.cz : t\.z/.test(html));
ok('and looks at the smoothed position too', /camera\.lookAt\(tx, 1\.25, tz\)/.test(html));
// the previous version of this grepped the whole block for "cyaw" and matched the COMMENT
// explaining why cyaw is not used - an assertion that passes on prose is no assertion
ok('but keeps the schema yaw, whose convention this maths expects',
   /const face = \(typeof t\.faceCur === 'number' \? t\.faceCur/.test(html)
   && !/face = r && typeof r\.cyaw/.test(html));

/* 3. seekers had nothing to seek: in live, G.ents holds only you */
ok('there is one candidate list', (html.match(/function seekCandidates/g) || []).length === 1);
ok('the bullet loop uses it', /for\(const e2 of seekCandidates\(b\.owner\)\)/.test(html));
ok('it includes live remotes', /live\.remotes\.forEach\(\(r, rid\)[\s\S]{0,200}out\.push/.test(html));
ok('it reports their smoothed position', /out\.push\(\{ id:rid, x:r\.cx, z:r\.cz \}\)/.test(html));
ok('the loop no longer scans G.ents directly for seekers',
   !/for\(const e2 of G\.ents\)/.test(html));

/* 4. health bars are UI and must not be eaten by fog */
{
  const i = html.indexOf('const hbG = new THREE.Group()');
  const block = html.slice(i, i + 700);
  ok('both bar materials opt out of fog', (block.match(/fog:false/g) || []).length === 2);
}

/* 5. the heal flash has to come off the synced number, not off damage() */
ok('live detects a heal from hp rising', /sp\.hp > live\.lastHp \+ 0\.01/.test(html));
ok('and flashes the same bar the offline path does',
   /sp\.hp > live\.lastHp[\s\S]{0,80}pulseHud\('#hpbar', 'mend'\)/.test(html));
ok('a respawn refill is not treated as a heal',
   /sp\.hp > live\.lastHp \+ 0\.01 && !me\.dead && !sp\.dead/.test(html));

/* 6. the hitmarker: offline raises it from damage(), live from the server's confirmation */
ok('one function raises the marker', (html.match(/function showHitmark/g) || []).length === 1);
ok('the offline damage path calls it', /src\.isPlayer && src!==t\) showHitmark\(isCrit\)/.test(html));
ok('the live path listens for the server hit', /room\.onMessage\('hit'[\s\S]{0,90}showHitmark/.test(html));
ok('nothing raises it by poking the element directly',
   (html.match(/#hitmark'\)/g) || []).length === 1);
ok('the server confirms hits to the shooter', /sc\.send\('hit', \{ c: crit \? 1 : 0/.test(srv));
ok('only when damage actually landed', /if\(dmg > 0 && id !== tid\)/.test(srv));

/* 7. a purchase the database refuses must not read as a generic failure */
ok('the auction surfaces the migration-009 abort specifically',
   /AUCTION NEEDS MIGRATION 009/.test(html));

/* 8. the flinch. Offline and live each had their own copy and they had drifted: the live
      one was missing the yaw kick and the damage vignette entirely. */
ok('one flinch function', (html.match(/function playerFlinch/g) || []).length === 1);
// grep for the NAME and it matches the comment that explains why the name is gone -
// the second time this exact mistake has been made in this suite. Check for a
// definition and a call instead, which prose cannot satisfy.
ok('the old live-only copy is not defined', !/function damageFlinchOnly/.test(html));
ok('and nothing calls it', !/damageFlinchOnly\(/.test(html));
ok('the offline damage path calls it', /if\(t\.isPlayer\) playerFlinch\(dmg\)/.test(html));
ok('the live path calls the same one', /playerFlinch\(live\.lastHp - sp\.hp\)/.test(html));
{
  // the whole effect must live inside that one function, or a caller can be short-changed
  const i = html.indexOf('function playerFlinch');
  const blk = html.slice(i, i + 620);
  for(const part of ['G.shake', 'G.kickPitch', 'G.kickYaw', "$('#vign')", "sfx('hurt')"])
    ok('playerFlinch still does ' + part, blk.includes(part));
}
ok('the flinch maths exists in exactly one place',
   (html.match(/Math\.min\(1, dmg \/ 30\)/g) || []).length === 1);

/* 9. the seller's SCREEN, which is not the same thing as the seller's row. A sale credits
      the database instantly; nothing pushes or polls that to the seller's client. */
ok('there is a cheap credits-only refresh', /async function refreshCredits\(\)/.test(html));
ok('it reads one column, not the whole profile',
   /sbSelect\('players\?select=credits&id=eq\.' \+ ACCOUNT\.playerId\)/.test(html));
ok('the auction screen runs it', /refreshCredits\(\)\s*\]\)/.test(html));
ok('it only repaints when the number actually moved', /c !== P\.credits\)\{ P\.credits = c; refreshChips/.test(html));

console.log(fails ? '\n  livepvp.test.js: ' + fails + ' FAILED' : '  livepvp.test.js: all passed');
process.exit(fails ? 1 : 0);
