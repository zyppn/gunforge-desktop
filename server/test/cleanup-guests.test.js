/* The empty-guest cleanup (migration 020), run for real on Postgres.

   It deletes accounts, so it is checked against an actual engine rather than read: PGlite
   is Postgres compiled to WASM and runs in Node. A cast of seventeen accounts covers every
   way a guest can hold progress - one XP point, level 2, extra credits, a match, a kill,
   a part, a listing as seller or buyer, a store purchase, a claimed match - and only the
   genuinely empty ones may go.

   Skips (and passes) when PGlite is not installed, so ship.sh never depends on it:
     cd server && npm i -D @electric-sql/pglite      # then:
     node server/test/cleanup-guests.test.js                                         */
const fs = require('fs'), path = require('path');
const MIG = path.join(__dirname, '..', 'migrations');
(async () => {
let PGlite;
try{ ({ PGlite } = await import('@electric-sql/pglite')); }
catch(e){ console.log('  SKIP  cleanup-guests: @electric-sql/pglite not installed (see header)'); process.exit(0); }
const db = new PGlite();
const q = (s, p) => db.query(s, p);
let fails = 0;
const ok = (l, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : '')); if(!c) fails++; };

// Supabase's auth.users (only what the function reads), the game tables, and roles/cron stubs
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, is_anonymous boolean, created_at timestamptz, last_sign_in_at timestamptz);
  create table players (id uuid primary key default gen_random_uuid(), auth_uid uuid unique, callsign text,
    credits int not null default 500, xp int not null default 0, level int not null default 1,
    stats jsonb not null default '{}');
  create table parts (uid uuid primary key default gen_random_uuid(), owner_id uuid not null references players(id) on delete cascade);
  create table listings (id uuid primary key default gen_random_uuid(),
    seller_id uuid not null references players(id) on delete cascade, buyer_id uuid references players(id) on delete set null);
  create table store_purchases (player_id uuid not null references players(id) on delete cascade, day_key text, idx smallint);
  create table processed_matches (mid text primary key, player_id uuid not null references players(id) on delete cascade);
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as
    $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
  create function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j; select true $$;
`);
const strip = f => fs.readFileSync(f, 'utf8').replace(/^\s*create extension[^;]*;/mi, '').replace(/^notify[^;]*;/mi, '');
await db.exec(strip(path.join(MIG, '019_player_sessions.sql')));
const mig = strip(path.join(MIG, '020_cleanup_empty_guests.sql'));
await db.exec(mig);
await db.exec(mig);   // idempotent: running the file twice must not duplicate the job
ok('running the migration twice leaves ONE nightly job', (await q(`select count(*)::int n from cron.job where jobname='gunforge-cleanup-empty-guests'`)).rows[0].n === 1);

// the cast of accounts
const OLD = `now() - interval '45 days'`, NEW = `now() - interval '3 days'`;
const mk = async (name, { anon = true, seen = OLD, player = true, xp = 0, level = 1, credits = 500, stats = {}, extra } = {}) => {
  const u = (await q(`insert into auth.users values (gen_random_uuid(), $1, ${seen}, ${seen}) returning id`, [anon])).rows[0].id;
  if(!player) return { name, u };
  const p = (await q(`insert into players(auth_uid, callsign, xp, level, credits, stats) values ($1,$2,$3,$4,$5,$6) returning id`,
                     [u, name, xp, level, credits, JSON.stringify(stats)])).rows[0].id;
  if(extra) await extra(p);
  await q(`insert into player_sessions(player_id, session) values ($1, 'x')`, [p]);
  return { name, u, p };
};
const accounts = {
  empty:        await mk('empty'),
  noRow:        await mk('opened-never-reached-menu', { player: false }),
  recent:       await mk('empty-but-recent', { seen: NEW }),
  secured:      await mk('empty-but-discord', { anon: false }),
  oneXp:        await mk('one-xp', { xp: 1 }),
  level2:       await mk('level-2', { level: 2 }),
  credits:      await mk('extra-credits', { credits: 520 }),
  matches:      await mk('played-a-match', { stats: { matches: 1 } }),
  kills:        await mk('has-a-kill', { stats: { kills: 1 } }),
  zeroStats:    await mk('explicit-zero-stats', { stats: { kills: 0, deaths: 0, matches: 0, wins: 0 } }),
  part:         await mk('owns-a-part', { extra: p => q(`insert into parts(owner_id) values ($1)`, [p]) }),
  seller:       await mk('listed-something', { extra: p => q(`insert into listings(seller_id) values ($1)`, [p]) }),
  store:        await mk('bought-from-store', { extra: p => q(`insert into store_purchases values ($1,'d',0)`, [p]) }),
  claimed:      await mk('claimed-a-match', { extra: p => q(`insert into processed_matches values ('m1',$1)`, [p]) }),
};
// a guest who BOUGHT a listing from someone else
const sellerOf = await mk('someone-who-sold', { anon: false, xp: 50 });
accounts.buyer = await mk('bought-at-auction', { extra: p => q(`insert into listings(seller_id, buyer_id) values ($1,$2)`, [sellerOf.p, p]) });

const shouldGo = new Set(['empty', 'noRow', 'zeroStats']);
let refused = null;
try{ await q(`select cleanup_empty_guests(3, false)`); }catch(e){ refused = e.message; }
ok('refuses a window shorter than 7 days', /refusing/.test(refused || ''), refused);

const dry = (await q(`select cleanup_empty_guests(30) n`)).rows[0].n;
ok('a dry run (the default) counts exactly the empty old guests', dry === shouldGo.size, dry);
ok('  and deletes nothing', (await q(`select count(*)::int n from auth.users`)).rows[0].n === Object.keys(accounts).length + 1);

const n = (await q(`select cleanup_empty_guests(30, false) n`)).rows[0].n;
ok('the real run deletes the same number', n === shouldGo.size, n);
for(const [k, a] of Object.entries(accounts)){
  const userLeft = (await q(`select 1 from auth.users where id=$1`, [a.u])).rows.length === 1;
  const rowLeft = a.p ? (await q(`select 1 from players where id=$1`, [a.p])).rows.length === 1 : false;
  if(shouldGo.has(k)) ok('DELETED  ' + a.name, !userLeft && !rowLeft);
  else ok('kept     ' + a.name, userLeft && (!a.p || rowLeft));
}
ok('deleted players take their session rows with them', (await q(`select count(*)::int n from player_sessions`)).rows[0].n ===
   Object.values(accounts).filter(a => a.p && !shouldGo.has(Object.keys(accounts).find(k => accounts[k] === a))).length + 1);
ok('the seller of the auctioned part is untouched', (await q(`select 1 from players where id=$1`, [sellerOf.p])).rows.length === 1);
ok('the job the schedule runs is the real delete', /cleanup_empty_guests\(30, false\)/.test((await q(`select command from cron.job`)).rows[0].command));
console.log(fails ? '\ncleanup-guests: ' + fails + ' failure(s)' : '\ncleanup-guests: all clear');
process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
