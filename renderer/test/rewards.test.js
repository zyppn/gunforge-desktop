/* Rewards that were queued while offline.

   They used to land as a toast: one line of text, 3.4 seconds, gone. That line was
   carrying the same payload as the end-of-match screen - credits, XP and a part -
   and the part is the thing the player came for. A legendary announced as a sentence
   with no card, no image, no mods and no sound is indistinguishable from a status
   message, which is why it read as "nothing happened".

   These check the reveal itself, and the three places that have to call it. The
   wiring checks matter as much as the rendering: on this codebase the recurring bug
   is not code that throws, it is code that is never reached. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

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

/* ---- 1. every drain path opens the reveal ---------------------------------------
   There are exactly three ways a queued match gets credited, and all three used to
   end in toast(drainToast(...)). Any one of them left behind is a path where the
   player still gets a line of text instead of their part. */
{
  ok('no drain path still summarises the reward as a toast',
     html.indexOf('toast(drainToast(') < 0);

  // the connectivity-restored listener
  const onl = html.slice(html.indexOf("window.addEventListener('online'"));
  ok('reconnecting mid-session opens the reveal',
     /outboxDrain\(\)[\s\S]{0,600}?rewardModal\(got, lvlBefore\)/.test(onl));
  ok('and reads the level BEFORE the fresh profile overwrites it',
     onl.indexOf('const lvlBefore') < onl.indexOf('loadCloudProfile'));

  // the Retry now link on the menu badge
  const rp = lift('retryPending');
  ok('the Retry now link opens the reveal', rp.indexOf('rewardModal(got, lvlBefore)') > 0);
  ok('and captures the level before the profile refresh',
     rp.indexOf('const lvlBefore') < rp.indexOf('loadCloudProfile'));
  /* Ordering is load-bearing: renderMenu() rewrites the screen, and a modal opened
     first would be torn down by the repaint before anyone saw it. */
  ok('the reveal opens AFTER renderMenu, or the repaint eats the overlay',
     rp.indexOf('renderMenu()') < rp.indexOf('rewardModal('));
  ok('a failed drain still says so rather than opening an empty panel',
     /STILL UNREACHABLE/.test(rp));

  // the boot replay
  ok('boot hoists replayed so the post-menu reveal can see it',
     /let cloud = null, replayed = \[\];/.test(html));
  ok('and does not shadow it back inside the uplink block',
     html.indexOf('      let replayed = [];') < 0);
  const boot = html.slice(html.indexOf('renderMenu();\n    if(cloud) toast('));
  ok('boot opens the reveal only after the menu has painted',
     /renderMenu\(\);[\s\S]{0,400}?rewardModal\(replayed\)/.test(boot));
  ok('boot no longer races the rest of the uplink on a bare timer',
     html.indexOf('setTimeout(()=>toast(drainToast(replayed)), 900)') < 0);
}

/* ---- 2. the reveal itself -------------------------------------------------------
   rewardModal is lifted out of the shipped file and run against a stub DOM, so this
   exercises the real source rather than a copy of it. */
const seen = { html: '', toasts: [], thumbs: 0, sounds: [] };
const ctx = vm.createContext({ console, Math, setTimeout: (fn)=>fn() });
vm.runInContext(
    'const RKEYS = ["common","uncommon","rare","epic","legendary"];\n'
  + 'const PART_CAP = 200;\n'
  + 'let P = { level: 7 };\n'
  + 'let OUT = { html:"", toasts:[], thumbs:0, sounds:[] };\n'
  + 'function modal(h){ OUT.html = h; }\n'
  + 'function toast(t){ OUT.toasts.push(t); }\n'
  + 'function hydrateThumbs(){ OUT.thumbs++; }\n'
  + 'function playDropSound(r){ OUT.sounds.push(r); }\n'
  + 'function partCard(p){ return \'<div class="part" data-n="\' + p.name + \'"></div>\'; }\n'
  + lift('rewardModal'), ctx);

const run = (got, lvlBefore, level) => {
  vm.runInContext('OUT = { html:"", toasts:[], thumbs:0, sounds:[] };', ctx);
  if(level !== undefined) vm.runInContext('P = { level: ' + level + ' };', ctx);
  vm.runInContext('(function(g,l){ rewardModal(g,l); })', ctx)(got, lvlBefore);
  return vm.runInContext('OUT', ctx);
};
const part = (name, rarity) => ({ name, rarity, slot:'barrel', weapon:'m17', mods:{} });
const cards = h => (h.match(/class="part"/g) || []).length;

{ // nothing at all
  const o = run([], undefined);
  ok('an empty drain opens nothing', o.html === '' && o.toasts.length === 0);
}
{ /* A duplicate is the server saying "I already had this one" - it grants zero.
     Counting it would open a fanfare announcing a match credited for +0. */
  const o = run([{ok:true, duplicate:true, credits:0, xp:0, part:null},
                 {ok:true, duplicate:true, credits:0, xp:0, part:null}], undefined);
  ok('a drain of nothing but duplicates opens no panel', o.html === '');
  ok('but still says what happened', /ALREADY CREDITED/.test(o.toasts.join(' ')));
}
{ // the ordinary case
  const o = run([{ok:true, credits:200, xp:300, part:null},
                 {ok:true, credits:214, xp:185, part:part('Match Barrel','common')}], undefined);
  ok('credits are summed across the drain', /\+414/.test(o.html));
  ok('XP is summed across the drain', /\+485/.test(o.html));
  ok('the match count is in the headline', /2 MATCHES/.test(o.html));
  ok('the part is rendered as a real card, not as its name in a sentence',
     cards(o.html) === 1 && /data-n="Match Barrel"/.test(o.html));
  ok('the card is wrapped in the same dropcard reveal the results screen uses',
     /class="dropcard"/.test(o.html));
  ok('thumbnails are hydrated, or the card renders with an empty image',
     o.thumbs === 1);
  ok('and it plays the drop fanfare', o.sounds.length === 1);
  ok('a locker offer only appears when there is something to look at',
     /PARTS LOCKER/.test(o.html));
}
{ // a duplicate riding along with a real one must not inflate the count
  const o = run([{ok:true, credits:100, xp:100, part:null},
                 {ok:true, duplicate:true, credits:0, xp:0, part:null}], undefined);
  ok('duplicates are excluded from the match count', /1 MATCH</.test(o.html));
  ok('and are still disclosed rather than silently dropped',
     /already credited/i.test(o.html));
}
{ // several parts in one drain
  // common FIRST on purpose: if the fanfare followed array order it would pick this
  const o = run([{ok:true, credits:10, xp:10, part:part('Plain Grip','common')},
                 {ok:true, credits:10, xp:10, part:part('Ghost Bore','legendary')}], undefined);
  ok('two parts are two cards, not a comma-separated list', cards(o.html) === 2);
  /* If the fanfare followed array order this drain would announce a legendary
     with the three-note common chime. */
  ok('the rarest part wins the fanfare', o.sounds[0] === 'legendary');
}
{ // the locker was full
  const o = run([{ok:true, credits:50, xp:50, part:null, lockerFull:true}], undefined);
  ok('a forfeited drop is reported as forfeited', /FORFEITED/.test(o.html));
  ok('and is not reported as bad luck', !/No salvage recovered/.test(o.html));
  ok('it names the cap so the player knows what to do', /200 parts/.test(o.html));
  ok('with nothing to look at, no locker button is offered',
     !/PARTS LOCKER/.test(o.html));
}
{ // an honest empty run
  const o = run([{ok:true, credits:30, xp:25, part:null}], undefined);
  ok('no drop is stated plainly', /No salvage recovered/.test(o.html));
  ok('and nothing plays', o.sounds.length === 0);
}
{ // levelling up on the strength of the queue
  const o = run([{ok:true, credits:10, xp:900, part:null}], 6, 7);
  ok('a level gained from queued XP is shown', /LEVEL UP/.test(o.html) && /7</.test(o.html));
  const same = run([{ok:true, credits:10, xp:10, part:null}], 7, 7);
  ok('and is not claimed when the level did not move', !/LEVEL UP/.test(same.html));
  const boot = run([{ok:true, credits:10, xp:10, part:null}], undefined, 7);
  ok('boot passes no baseline, so it never invents a level-up', !/LEVEL UP/.test(boot.html));
}
{ // malformed replies must not take the panel down with them
  const o = run([null, undefined, {ok:true, credits:5, xp:5, part:null}], undefined);
  ok('a junk entry in the drain is skipped rather than thrown on', /1 MATCH</.test(o.html));
}
{ // the panel has to be dismissible
  const o = run([{ok:true, credits:5, xp:5, part:null}], undefined);
  ok('there is always a way out of the panel', /closeModal\(\)/.test(o.html));
}

/* ---- 3. a drain can credit more than fits on screen ---------------------------- */
ok('the modal box can scroll, or the last card is clipped off the bottom',
   /#modal \.mbox\{max-height:[\s\S]{0,40}overflow:auto\}/.test(html));

if(fails){ console.error('\nrewards: ' + fails + ' failure(s)'); process.exit(1); }
console.log('rewards: ok');
