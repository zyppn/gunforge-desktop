/* The credit economy, run for real on Postgres (PGlite = Postgres compiled to WASM).

   Every schema file and migration is loaded in order, then the game's functions are
   called exactly the way the app calls them: as the role `authenticated`, with the
   player's JWT claims set for the request. That last part is the whole point. The
   auction bug lived in the gap between "the function ran" and "the credits moved":
   a player guard trigger reset every credit update made during a player's request,
   so buy_listing completed, moved the part, returned OK - and moved no credits.
   Reading the SQL could not catch that; only running it could.

   Skips (and passes) when PGlite is not installed, so ship.sh never depends on it:
     cd server && npm i -D @electric-sql/pglite                                      */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
(async () => {
let PGlite;
try{ ({ PGlite } = await import('@electric-sql/pglite')); }
catch(e){ console.log('  SKIP  economy-db: @electric-sql/pglite not installed (see header)'); process.exit(0); }
let fails = 0;
const ok = (l, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : '')); if(!c) fails++; };

const db = new PGlite();
// Supabase's pieces the schema leans on: roles, auth.uid() from the request claims, cron
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, is_anonymous boolean, created_at timestamptz, last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant select, insert, update on tables to authenticated;
  alter default privileges in schema public grant all on tables to service_role;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as
    $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
  create function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j; select true $$;
`);
const strip = t => t.replace(/^\s*create extension[^;]*;/gmi, '').replace(/^\s*notify[^;]*;/gmi, '');
const files = ['supabase-pvp.sql', ...fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => 'migrations/' + f)];
const q = (s, p) => db.query(s, p);
/* Everything before 022 first, so a store part bought (and listed) under the old rules
   exists when 022 runs - that is the case the migration has to clean up. */
const before022 = files.filter(f => !/migrations\/0(2[2-9]|[3-9]\d)/.test(f)), after022 = files.filter(f => !before022.includes(f));
for(const f of before022) await db.exec(strip(fs.readFileSync(path.join(ROOT, f), 'utf8')));
const oldBuyer = (await q(`insert into players(auth_uid, callsign, credits) values (gen_random_uuid(), 'OLDSTORE', 50000) returning id, auth_uid`)).rows[0];
const oldBuy = (await q(`select buy_store_part($1, '2026-09-01', 7::smallint, 25000, '{"weapon":"warden","slot":"barrel","rarity":"legendary","name":"Old Legend","mods":{}}'::jsonb) as r`, [oldBuyer.id])).rows[0].r;
const oldPart = oldBuy.part.uid;
const oldList = (await q(`insert into listings(part_uid, seller_id, price) values ($1, $2, 1) returning id`, [oldPart, oldBuyer.id])).rows[0].id;
ok('(before 022) a store part came out tradeable and could sit on the auction', oldBuy.part.bound === false && !!oldList);
for(const f of after022) await db.exec(strip(fs.readFileSync(path.join(ROOT, f), 'utf8')));
ok('schema + every migration loads in order (' + files.length + ' files)', true);
const player = async (name, credits) => (await q(
  `insert into players(auth_uid, callsign, credits) values (gen_random_uuid(), $1, $2) returning id, auth_uid`, [name, credits])).rows[0];
const part = async (owner, name) => (await q(
  `insert into parts(owner_id, weapon_id, slot, rarity, name) values ($1,'m17','barrel','rare',$2) returning uid`, [owner.id, name])).rows[0].uid;
const credits = async p => (await q(`select credits from players where id = $1`, [p.id])).rows[0].credits;
// exactly how PostgREST runs a call: one transaction, role switched, request claims set
const as = async (role, who, sql, p) => {
  await db.exec('begin');
  try{
    await db.exec('set local role ' + role);
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who ? who.auth_uid : null, role })]);
    const r = await q(sql, p); await db.exec('commit'); return r.rows[0] || {};
  }catch(e){ await db.exec('rollback'); return { error: e.message }; }
};
const asPlayer = (who, sql, p) => as('authenticated', who, sql, p);

/* ---- 022: store parts are soulbound (no shop rerolls through alt accounts) ---- */
ok('a store part bought before 022 is now soulbound', (await q(`select bound from parts where uid = $1`, [oldPart])).rows[0].bound === true);
ok('  and its listing was taken down, the part still with its owner',
   (await q(`select l.status = 'cancelled' and p.owner_id = $2 as b from listings l join parts p on p.uid = l.part_uid where l.id = $1`, [oldList, oldBuyer.id])).rows[0].b);
const shopper = (await q(`insert into players(auth_uid, callsign, credits) values (gen_random_uuid(), 'SHOPPER', 30000) returning id, auth_uid`)).rows[0];
const nb = (await as('service_role', null, `select buy_store_part($1, '2026-09-29', 7::smallint, 25000, '{"weapon":"ls1","slot":"optic","rarity":"legendary","name":"New Legend","mods":{}}'::jsonb) as r`, [shopper.id])).r;
ok('a store purchase now comes out soulbound', nb && nb.ok && nb.part.bound === true, nb && JSON.stringify(nb.part && nb.part.bound));
const tryList = await asPlayer(shopper, `select list_part($1, 100) as id`, [nb.part.uid]);
ok('  and cannot be listed on the auction', /soulbound/.test(tryList.error || ''), tryList.error || 'LISTED');
const sneak = (await q(`insert into parts(owner_id, weapon_id, slot, rarity, name, source, bound) values ($1,'m17','barrel','epic','Sneak','store',false) returning bound`, [shopper.id])).rows[0].bound;
ok('  a store part written any other way is bound too (trigger)', sneak === true);
const dropP = (await q(`insert into parts(owner_id, weapon_id, slot, rarity, name, source, bound) values ($1,'m17','barrel','epic','PvP Drop','pvp',false) returning bound`, [shopper.id])).rows[0].bound;
ok('  live PvP drops stay tradeable', dropP === false);

/* ---- the auction ---- */
const seller = await player('SELLER', 1000), buyer = await player('BUYER', 1000);
const barrel = await part(seller, 'Test Barrel');
const lid = (await asPlayer(seller, `select list_part($1, 250) as id`, [barrel])).id;
ok('a player can list a part', !!lid);
const r = await asPlayer(buyer, `select buy_listing($1) as r`, [lid]);
ok('the buyer can buy it', !r.error, r.error);
ok('THE BUYER IS CHARGED the price', await credits(buyer) === 750, await credits(buyer));
ok('THE SELLER IS PAID the price, in the same transaction', await credits(seller) === 1250, await credits(seller));
ok('the part now belongs to the buyer', (await q(`select owner_id = $1 as b from parts where uid = $2`, [buyer.id, barrel])).rows[0].b);
ok('the listing is closed as sold and marked paid',
   (await q(`select status = 'sold' and seller_paid as b from listings where id = $1`, [lid])).rows[0].b);
ok('the reply carries the price and the part the client shows', r.r && r.r.price === 250 && r.r.part && r.r.part.name === 'Test Barrel');
ok('no credits were created or destroyed', await credits(buyer) + await credits(seller) === 2000);

const poor = await player('POOR', 100), pricey = await part(seller, 'Pricey');
const lid2 = (await asPlayer(seller, `select list_part($1, 400) as id`, [pricey])).id;
const r2 = await asPlayer(poor, `select buy_listing($1) as r`, [lid2]);
ok('a buyer who cannot afford it is refused', /not enough credits/.test(r2.error || ''), r2.error);
ok('  and nothing moved', await credits(poor) === 100 && await credits(seller) === 1250
   && (await q(`select owner_id = $1 as b from parts where uid = $2`, [seller.id, pricey])).rows[0].b);
ok('a seller cannot buy their own listing', /own listing/.test((await asPlayer(seller, `select buy_listing($1)`, [lid2])).error || ''));
ok('a sold listing cannot be bought twice', /listing gone/.test((await asPlayer(poor, `select buy_listing($1)`, [lid])).error || ''));

/* ---- scrapping pays ---- */
const junk = await part(seller, 'Junk'), before = await credits(seller);
const sc = await asPlayer(seller, `select scrap_part($1) as got`, [junk]);
ok('scrapping a part pays its scrap value', !sc.error && sc.got > 0 && await credits(seller) === before + sc.got, (sc.error || sc.got) + ' -> +' + (await credits(seller) - before));

/* ---- the guard still stops players minting credits for themselves ---- */
// Column grants (006) refuse this already; widen them to prove the guard is a real second wall.
await db.exec(`grant update on players to authenticated`);
await db.exec(`drop policy if exists players_self on players; create policy players_self on players for update using (auth_uid = auth.uid())`);
const hack = await asPlayer(buyer, `update players set credits = 999999, level = 50, xp = 5, callsign = 'RENAMED' where auth_uid = auth.uid() returning credits, level, xp, callsign`);
ok('a player writing their own row cannot change credits, level or xp', !hack.error && hack.credits === 750 && hack.level === 1 && hack.xp === 0, JSON.stringify(hack));
ok('  but can still change the columns that are theirs (callsign)', hack.callsign === 'RENAMED');
const other = await asPlayer(buyer, `update players set credits = 0 where id = $1 returning credits`, [seller.id]);
ok('and cannot touch anyone else\'s row at all', !other.credits && await credits(seller) > 0);
const newbie = (await q(`select gen_random_uuid() as u`)).rows[0].u;
const ins = await asPlayer({ auth_uid: newbie }, `insert into players(auth_uid, callsign, credits, level, xp) values ($1, 'NEW', 999999, 50, 9) returning credits, level, xp`, [newbie]);
ok('a new player row always starts at 500 credits, level 1, 0 xp', !ins.error && ins.credits === 500 && ins.level === 1 && ins.xp === 0, ins.error || JSON.stringify(ins));

/* ---- the arena server's path ---- */
const s0 = await credits(seller);
const ap = await as('service_role', null, `select add_progress($1, 40, 10, '{"kills":2}'::jsonb)`, [seller.id]);
ok('match rewards (add_progress, as the server) still land', !ap.error && await credits(seller) === s0 + 40, ap.error);
ok('a player cannot call add_progress themselves', !!(await asPlayer(seller, `select add_progress($1, 99999)`, [seller.id])).error);

/* ---- Realtime is on for the two tables the live wallet watches ---- */
const pub = (await q(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)).rows.map(r => r.tablename);
ok('Realtime publishes players and listings (the seller hears about a sale)', pub.includes('players') && pub.includes('listings'), pub.join(','));
await db.exec(strip(fs.readFileSync(path.join(ROOT, 'migrations', '021_auction_pays_instantly.sql'), 'utf8')));
ok('021 is safe to run twice', true);
await db.exec(strip(fs.readFileSync(path.join(ROOT, 'migrations', '022_store_parts_soulbound.sql'), 'utf8')));
ok('022 is safe to run twice', true);

console.log(fails ? '\neconomy-db: ' + fails + ' failure(s)' : '\neconomy-db: all clear');
process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
