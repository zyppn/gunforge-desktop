/* The duel harness must give the same answer for the same build no matter what it
   measured beforehand.

   It did not. pFor() memoises hit probability, and on a cache MISS it called seed(13)
   and then burned 15,000 draws in hitP. So a fight that hit a warm cache continued the
   existing random stream while the identical fight against a cold cache got a freshly
   seeded one - the same build scored 66.9% or 68.8% depending only on measurement order.
   That is how a "pick the best 2 of 3 slots" sweep scored BELOW the forced pair it
   contains, which cannot happen. pFor now saves and restores the stream.

   This test fails if that restore is ever removed: it scores a build cold, then scores a
   different build to warm the cache, then scores the first one again. */
const { C, build, kits, fight, seedAll } = require('./duel/builds.js');

const opps = ['m17','havoc9','vkraptor','warden','ls1','goliath']
  .map(id => build('o|'+id, id, [], ['deadeye','swift','deadeye','swift','cryo','vampiric'], []));

function score(X){
  seedAll(4242); let a = 0, n = 0;
  for(const o of opps) for(const d of [5, 14, 28]) for(const q of [0.6, 0.85]){
    if(fight(X, o, d, q, {hp:100, sh:0})) a++;
    if(!fight(o, X, d, q, {hp:100, sh:0})) a++;
    n += 2;
  }
  return a / n;
}

const subject = () => build('s', 'vkraptor', ['barrel','magazine'],
  ['deadeye','deadeye','swift','incendiary'], ['fire_nova']);
const other   = () => build('w', 'goliath', [],
  ['swift','swift','deadeye','cryo','vampiric','incendiary'], []);

const cold = score(subject());
score(other());                       // warms PC with a different weapon's entries
const warm = score(subject());

if(cold !== warm){
  console.error('duel harness is order-dependent: same build scored '
    + (cold*100).toFixed(2) + '% cold and ' + (warm*100).toFixed(2) + '% after warming.');
  console.error('pFor() must leave the random stream exactly as it found it.');
  process.exit(1);
}

/* And the structural invariant the bug broke: a set allowed to choose any 2 of 3 slots
   can never do worse than the same set forced into a specific 2 of those 3. */
const S = 909;
function vs(X){ seedAll(S); let a=0,n=0;
  for(const o of opps) for(const d of [5,14,28]){
    if(fight(X,o,d,0.8,{hp:100,sh:0})) a++; if(!fight(o,X,d,0.8,{hp:100,sh:0})) a++; n+=2; }
  return a/n; }
const hor = C.SETS.find(s => s.id === 'hornet');
const slots = Object.keys(hor.pieces);
if(slots.length < 3) throw new Error('hornet no longer has a 3rd piece - retarget this test');
const kit = ['deadeye','deadeye','swift','cryo'];
const forced = vs(build('f','havoc9', slots.slice(0,2), kit, [hor.effect]));
let best = -1;
for(let i=0;i<slots.length;i++) for(let j=i+1;j<slots.length;j++)
  best = Math.max(best, vs(build('b','havoc9',[slots[i],slots[j]], kit, [hor.effect])));
if(best + 1e-9 < forced){
  console.error('free slot choice (' + (best*100).toFixed(2) + '%) scored below the forced pair it contains ('
    + (forced*100).toFixed(2) + '%) - the harness is not deterministic.');
  process.exit(1);
}

console.log('duel-warmth: harness is order-independent (' + (cold*100).toFixed(2) + '% both ways)');
