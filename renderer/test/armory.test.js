/* The armory's hover-to-highlight.

   The armory deliberately kept its rotating preview instead of the death card's
   static callouts - the slot rows already name every part, and what they cannot tell
   you is WHICH piece of metal a name refers to. Hovering a row answers that.

   The thing that can break here without throwing is the restore. pvHighlight mutates
   live material colours, so a missed base value does not error, it just leaves the
   gun permanently dimmed or permanently glowing, and only on the parts you happened
   to hover. These run the real function against a stub object graph. */
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

/* ---- a stub of just enough three.js ---- */
function Col(hex){ this.v = hex; }
Col.prototype.getHex = function(){ return this.v; };
Col.prototype.setHex = function(h){ this.v = h; return this; };
Col.prototype.copy = function(o){ this.v = o.v; return this; };
Col.prototype.multiplyScalar = function(k){
  const r = Math.round(((this.v >> 16) & 255) * k), g = Math.round(((this.v >> 8) & 255) * k),
        b = Math.round((this.v & 255) * k);
  this.v = (r << 16) | (g << 8) | b; return this;
};
function mesh(slot, col){
  return { isMesh:true, userData: slot ? {slot} : {},
           material: { userData:{}, color:new Col(col), emissive:new Col(0x000000),
                       emissiveIntensity:0 } };
}
function gun(parts){
  const kids = parts.slice();
  return { traverse(fn){ fn(this); kids.forEach(fn); }, isMesh:false, userData:{}, children:kids };
}

const ctx = vm.createContext({ Math, console });
vm.runInContext('let pvGun = null, pvLit = null;\n' + lift('pvHighlight'), ctx);
const set = g => vm.runInContext('(function(g){ pvGun = g; })', ctx)(g);
const hi  = s => vm.runInContext('(function(s){ pvHighlight(s); })', ctx)(s);
const lit = () => vm.runInContext('pvLit', ctx);

const BARREL = 0xE8A33D, STOCK = 0xB463E8, ACCENT = 0x4C9BE8;
let barrel, stock, accent, g;
const build = () => {
  barrel = mesh('barrel', BARREL); stock = mesh('stock', STOCK);
  accent = mesh(null, ACCENT);                 // the set-status strip: no slot, never ours
  g = gun([barrel, stock, accent]); set(g);
};

/* ---- 1. it highlights, and it is unambiguous ---- */
build();
hi('barrel');
ok('the hovered slot is recorded', lit() === 'barrel');
ok('the hovered part keeps its own colour', barrel.material.color.getHex() === BARREL);
/* Glow alone was not enough: every part is already a different saturated colour by
   rarity, so brightening one just made it a lighter shade of what it already was.
   Taking the others down is what makes it readable at a glance. */
ok('every other part is dimmed', stock.material.color.getHex() !== STOCK);
ok('and dimmed DOWN, not up', (stock.material.color.getHex() & 255) < (STOCK & 255));
ok('the set-status strip is left alone', accent.material.color.getHex() === ACCENT);

/* ---- 2. it puts everything back ---- */
hi(null);
ok('releasing clears the hover', lit() === null);
ok('  the dimmed part is restored exactly', stock.material.color.getHex() === STOCK);
ok('  the hovered part is restored exactly', barrel.material.color.getHex() === BARREL);
ok('  and its glow is wound back', barrel.material.emissiveIntensity === 0
   && barrel.material.emissive.getHex() === 0x000000);

/* ---- 3. moving between rows does not compound ----
   The bug this catches: dimming a part that is ALREADY dimmed. Sweeping the mouse
   down six rows would darken the gun a little more each time and never come back. */
build();
for(const s of ['barrel','stock','barrel','stock','barrel']) hi(s);
hi('barrel');
ok('sweeping across rows does not compound the dimming',
   stock.material.color.getHex() === new Col(STOCK).multiplyScalar(0.42).getHex());
hi(null);
ok('and it still restores perfectly afterwards', stock.material.color.getHex() === STOCK);

/* ---- 4. hovering with no model up is harmless ---- */
set(null);
let threw = false;
try{ hi('barrel'); }catch(e){ threw = true; }
ok('hovering before the preview exists does not throw', !threw);

/* ---- 5. wiring ---- */
ok('every slot row arms the highlight', /onmouseenter="pvHighlight\(/.test(html));
/* An enter with no leave leaves the gun stuck dim around whichever row you left by. */
ok('and every slot row disarms it', /onmouseleave="pvHighlight\(null\)/.test(html));
// the handlers live inside a JS string literal, so the quotes are backslash-escaped
ok('the row itself shows it is hoverable', /\.slotrow\.hot\{/.test(html)
   && html.includes("classList.add(\\'hot\\')")
   && html.includes("classList.remove(\\'hot\\')"));
ok('a new model starts with nothing lit',
   /pvScene=null; pvGun=null; pvLit=null;/.test(html) && /pvIdle=0; pvLit=null;/.test(html));
/* Stopping the spin felt right until the part you are hovering is on the far side,
   with no way to bring it round but dragging. */
ok('hovering SLOWS the spin rather than stopping it',
   /rotation\.y \+= dt\*0\.7\*\(pvLit \? 0\.25 : 1\)/.test(html));
ok('the highlight pulses, so it reads as a callout not a colour',
   /Math\.sin\(t\*0\.006\)/.test(html));
/* killPreview calls forceContextLoss(), and a canvas that lost its context that way
   can never be given another. It only works because the panel is rebuilt first. */
const panel = html.indexOf("$('#loadout').innerHTML =");
const init = html.indexOf('initPreview(w.id);', panel);
ok('the preview canvas is rebuilt before initPreview claims it', panel > 0 && init > panel);

/* ---- 6. it rides on the death card's tagging ---- */
ok('highlighting only ever touches tagged meshes',
   /if\(!o\.isMesh \|\| !o\.userData\.slot\) return;/.test(html));

if(fails){ console.error('\narmory: ' + fails + ' failure(s)'); process.exit(1); }
console.log('armory: ok');
