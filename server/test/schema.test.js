/* Every foreign key must say what happens when its target is deleted.

   This exists because of one that did not. listings.part_uid was written as a plain
   `references parts(uid)`, which defaults to NO ACTION, so the part row could never
   be deleted while ANY listing pointed at it. scrap_part guarded only against an
   ACTIVE listing - the game rule - while the constraint enforced the data rule, and
   the two are not the same rule. Cancel a listing and that part was unscrappable
   forever; buy one at auction and the sold row followed it to its new owner, so the
   buyer inherited a part they could never delete and a Postgres constraint name as
   the only explanation.

   Nothing surfaced it for months, because the common path - scrapping a part that
   was never listed - works perfectly. That is the shape of this whole class: silent
   until someone deletes something, and by then it is live data.

   So the rule here is not "use CASCADE". It is that the choice must be WRITTEN DOWN.
   `on delete no action` passes; omitting the clause does not, because then nobody
   decided - the default decided.

     node server/test/schema.test.js                                              */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

const files = [['supabase-pvp.sql', path.join(ROOT, 'supabase-pvp.sql')]];
for(const f of fs.readdirSync(path.join(ROOT, 'migrations')).sort()){
  if(f.endsWith('.sql')) files.push(['migrations/' + f, path.join(ROOT, 'migrations', f)]);
}
ok('the schema is where it is expected to be', files.length > 1);

/* Comments have to go first. Migration 012's header quotes the broken constraint
   verbatim to explain itself - scanning raw text reports the explanation as the bug. */
const strip = sql => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

/* A foreign key reaches to the end of its clause: the next comma at depth zero, or
   the statement's semicolon. Anything inside that span counts as part of the key. */
function fkClauses(sql){
  const out = [];
  const re = /references\s+[a-z_]+\s*\(\s*[a-z_]+\s*\)/gi;
  let m;
  while((m = re.exec(sql)) !== null){
    let i = m.index + m[0].length, depth = 0;
    while(i < sql.length){
      const c = sql[i];
      if(c === '(') depth++;
      else if(c === ')'){ if(depth === 0) break; depth--; }
      else if((c === ',' || c === ';') && depth === 0) break;
      i++;
    }
    out.push({ at: m.index, text: sql.slice(m.index, i).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

let total = 0;
const bare = [];
for(const [label, p] of files){
  const sql = strip(fs.readFileSync(p, 'utf8'));
  for(const fk of fkClauses(sql)){
    total++;
    // any explicit choice passes - cascade, set null, restrict, even no action
    if(!/on\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i.test(fk.text)){
      const line = sql.slice(0, fk.at).split('\n').length;
      bare.push(label + ':' + line + '  ' + fk.text);
    }
  }
}

ok('there are foreign keys to check at all', total >= 4);
ok('every foreign key declares ON DELETE explicitly'
   + (bare.length ? '\n        ' + bare.join('\n        ') : ''), bare.length === 0);

/* The specific one this test was written for. Spelled out so a future edit that
   reverts it fails by name rather than as an anonymous count. */
const base = strip(fs.readFileSync(path.join(ROOT, 'supabase-pvp.sql'), 'utf8'));
const partFk = fkClauses(base).find(f => /references\s+parts/i.test(f.text));
ok('listings still points at parts', !!partFk);
ok('  and releases the part on delete, or nothing ever listed can be scrapped',
   !!partFk && /on\s+delete\s+set\s+null/i.test(partFk.text));
/* CASCADE also clears the error, and also deletes unpaid sale rows as a side effect
   of someone tidying a locker - backpay_sellers() pays out of exactly those. */
ok('  and does NOT cascade, which would eat the rows back-pay is computed from',
   !!partFk && !/on\s+delete\s+cascade/i.test(partFk.text));
ok('a live listing can never be left pointing at nothing',
   /check\s*\(\s*status\s*<>\s*'active'\s+or\s+part_uid\s+is\s+not\s+null\s*\)/i.test(base));

/* The other half of the pair: a guard that checks a NARROWER condition than the
   constraint enforces is what produced the original bug. scrap_part is allowed to
   keep its friendly active-listing message, but it must not be the only thing
   standing between a delete and a raw constraint error. */
const scrap = fs.readFileSync(path.join(ROOT, 'migrations', '005_scrap_part.sql'), 'utf8');
ok('scrap_part still refuses to scrap a LIVE listing in readable words',
   /status = 'active'/.test(scrap) && /cancel the listing first/.test(scrap));

console.log('schema: checked ' + total + ' foreign keys across ' + files.length + ' files');
if(fails){ console.error('\nschema: ' + fails + ' failure(s)'); process.exit(1); }
console.log('schema: ok');
