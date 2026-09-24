/* Every database function the code calls must be defined in this repo.

   add_progress is why. Every credit and every point of XP in the game goes through it,
   and it existed only in the live database - written once in the Supabase SQL editor,
   never saved. Nothing noticed, because calling a function does not care where it was
   defined. The day the project is restored from a backup that predates it, rebuilt, or
   moved to a new Supabase project, every match reward fails with a 404 logged to the
   server console and the player sees nothing at all.

   So: collect every RPC name the client and server call, and every function the SQL in
   server/ creates, and require the first to be a subset of the second. KNOWN_MISSING is
   a ratchet - it fails in both directions, so a function that gets saved has to come
   off the list in the same commit.

     node server/test/rpcs.test.js                                                  */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');

let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d ? '   [' + d + ']' : '')); if(!cond) fails++; };

/* Defined only in the live database. Paste the definition into a migration, then
   delete the name from here. See server/AUTH_SETUP.md for the query that dumps it. */
const KNOWN_MISSING = new Set(['add_progress']);

const read = p => fs.readFileSync(p, 'utf8');
const called = new Map();          // name -> first file that calls it
const note = (n, f) => { if(!called.has(n)) called.set(n, f); };
const code = [
  ['renderer/index.html', path.join(ROOT, 'renderer', 'index.html')],
  ...fs.readdirSync(SERVER).filter(f => f.endsWith('.js')).map(f => ['server/' + f, path.join(SERVER, f)]),
];
for(const [label, p] of code){
  const s = read(p);
  for(const m of s.matchAll(/sbRpc\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) note(m[1], label);
  for(const m of s.matchAll(/\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)/g)) note(m[1], label);
}
ok('found the RPC calls this test is meant to check', called.size >= 5, [...called.keys()].join(', '));

const defined = new Set();
const sqls = [path.join(SERVER, 'supabase-pvp.sql'),
  ...fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => f.endsWith('.sql')).map(f => path.join(SERVER, 'migrations', f))];
for(const p of sqls)
  for(const m of read(p).matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi))
    defined.add(m[1].toLowerCase());

for(const [name, where] of [...called.entries()].sort()){
  const has = defined.has(name);
  if(KNOWN_MISSING.has(name))
    ok(name + ' is still only in the live database (known)', !has,
       has ? 'it is defined now - remove it from KNOWN_MISSING' : where);
  else ok(name + ' is defined in server/*.sql', has, has ? '' : 'called from ' + where);
}
/* ---- server-only functions must be closed to players ----
   A function only the arena server calls (with the service key) trusts its parameters,
   because the server computed them. Postgres grants EXECUTE on new functions to PUBLIC
   and Supabase adds anon and authenticated, so unless something REVOKES it, any client
   holding the publishable key can call it with parameters of its own choosing.
   Read-only helpers that leak nothing may stay open; each one says why. */
const OPEN_OK = { parts_held: 'returns a count of rows that parts_read already exposes' };
const clientCalls = new Set();
{ const s = read(path.join(ROOT, 'renderer', 'index.html'));
  for(const m of s.matchAll(/sbRpc\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) clientCalls.add(m[1]);
  for(const m of s.matchAll(/\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)/g)) clientCalls.add(m[1]); }
const allSql = sqls.map(read).join('\n');
for(const name of [...called.keys()].filter(n => !clientCalls.has(n)).sort()){
  if(OPEN_OK[name]){ ok(name + ' is server-only and may stay open', true, OPEN_OK[name]); continue; }
  const revoked = new RegExp("revoke\\s+execute\\s+on\\s+function\\s+[^;]*" + name + "[^;]*from[^;]*authenticated", 'i').test(allSql)
    || new RegExp("proname\\s+in\\s*\\([^)]*'" + name + "'", 'i').test(allSql)
       && /revoke execute on function %s from public, anon, authenticated/i.test(allSql);
  ok(name + ' is server-only and closed to players', revoked, revoked ? '' : 'no REVOKE ... FROM authenticated in server/*.sql');
}
for(const name of KNOWN_MISSING)
  ok('KNOWN_MISSING entry ' + name + ' is still called somewhere', called.has(name));

console.log(fails ? '\nrpcs: ' + fails + ' failure(s)' : '\nrpcs: all clear');
process.exit(fails ? 1 : 0);
