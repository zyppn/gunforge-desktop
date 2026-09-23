/* The parts locker's NEWEST sort.

   It used to sort by position in P.inventory, on the assumption that parts are only
   ever appended in the order they were obtained. Three things broke that, and none of
   them throw - the list just comes out in an order that means nothing:

     1. The cloud profile fetched parts with no ORDER BY. Postgres returns rows in
        whatever order the plan produces and that changes as rows are updated, so the
        locker came back shuffled differently on every load.
     2. A returned auction listing is pushed back onto the end, so a part you have
        owned for weeks jumps to the top.
     3. Buying and scrapping churn the tail.

   parts.created_at has been on the table since the first migration. These check that
   it is actually asked for, actually carried onto the part, and actually sorted on. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'server', 'supabase-pvp.sql'), 'utf8');

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

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

/* ---- 1. the column exists, is asked for, and is ordered by ---- */
ok('parts.created_at still exists on the table', /created_at\s+timestamptz/.test(schema));
const q = html.match(/sbSelect\('parts\?select=\*&owner_id=eq\.'[^;]*/);
ok('the locker query is still here to check', !!q);
ok('the locker fetch orders by created_at — without this the array order is arbitrary',
   !!q && /order=created_at/.test(q[0]));
ok('and breaks ties deterministically, or one timestamp batch reshuffles per load',
   !!q && /order=created_at[^']*uid/.test(q[0]));

/* ---- 2. the timestamp reaches the part object ---- */
const ctx = vm.createContext({ Date, Math, isFinite });
vm.runInContext(
  'const RKEYS = ["common","uncommon","rare","epic","legendary"];\n'
  + 'const SLOTS = ["frame","barrel","magazine","foregrip","stock","optic"];\n'
  + 'let P = { inventory: [] }, invSort = "obtained";\n'
  + 'function uid(){ return Math.random().toString(36).slice(2); }\n'
  + 'function scaleMods(m){ return m; }\n'
  + [lift('partFromRow'), lift('makePart'), lift('invSorted')].join('\n'), ctx);

const partFromRow = vm.runInContext('partFromRow', ctx);
const makePart = vm.runInContext('makePart', ctx);
{
  const row = partFromRow({ uid:'a', weapon_id:'m17', slot:'barrel', rarity:'rare',
    name:'X', mods:{}, created_at:'2026-01-02T03:04:05.000Z' });
  ok('a part from the database carries its created_at', row.got === Date.parse('2026-01-02T03:04:05.000Z'));
  const bare = partFromRow({ uid:'b', weapon_id:'m17', slot:'barrel', rarity:'rare', name:'X', mods:{} });
  ok('a row without the column does not produce a bogus timestamp', bare.got === undefined);
  const local = makePart('m17', 'barrel', 'rare', { name:'Y', mods:{} });
  ok('a locally rolled drop is stamped too, so offline play sorts as well',
     typeof local.got === 'number' && local.got > 0);
}

/* ---- 3. the sort itself ---- */
const setInv = inv => vm.runInContext('(function(v){ P.inventory = v; })', ctx)(inv);
const sortBy = k => vm.runInContext('(function(k){ invSort = k; })', ctx)(k);
const sorted = () => vm.runInContext('(function(){ return invSorted(P.inventory).map(p=>p.uid); })', ctx)();
const mk = (uid, got, extra) => Object.assign({ uid, got, weapon:'m17', slot:'barrel',
  rarity:'rare', name:'Part ' + uid, mods:{} }, extra || {});

sortBy('obtained');
{
  // the array is deliberately NOT in acquisition order, which is the real-world case
  setInv([ mk('old', 1000), mk('newest', 5000), mk('mid', 3000) ]);
  ok('newest first regardless of array position',
     sorted().join(',') === 'newest,mid,old');
}
{
  // the auction case: an old part returned to the locker is pushed onto the end
  setInv([ mk('bought-today', 9000), mk('returned-from-auction', 1000) ]);
  ok('a returned listing does not masquerade as the newest part',
     sorted()[0] === 'bought-today');
}
{
  // a batch insert shares one timestamp; order must still be stable, not random
  setInv([ mk('x', 7000), mk('y', 7000), mk('z', 7000) ]);
  const a = sorted(), b = sorted();
  ok('parts sharing a timestamp keep a stable order', a.join(',') === b.join(','));
}
{
  // a profile saved before the field existed still has to sort sensibly
  setInv([ mk('legacy1', undefined), mk('legacy2', undefined), mk('legacy3', undefined) ]);
  ok('with no timestamps at all it falls back to array position, newest last-added',
     sorted().join(',') === 'legacy3,legacy2,legacy1');
  setInv([ mk('legacy', undefined), mk('stamped', 4000) ]);
  ok('a stamped part is treated as newer than an unstamped one', sorted()[0] === 'stamped');
}
{
  // and the other sorts must not have been disturbed
  setInv([ mk('b', 1, {name:'Bravo', rarity:'common'}),
           mk('a', 2, {name:'Alpha', rarity:'legendary'}),
           mk('c', 3, {name:'Charlie', rarity:'epic'}) ]);
  sortBy('name');   ok('NAME still sorts alphabetically', sorted().join(',') === 'a,b,c');
  sortBy('rarity'); ok('RARITY still sorts legendary first', sorted()[0] === 'a');
  sortBy('obtained');
}

if(fails){ console.error('\nlocker: ' + fails + ' failure(s)'); process.exit(1); }
console.log('locker: ok');
