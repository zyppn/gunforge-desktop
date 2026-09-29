/* While you are dead, your own HUD is off screen - crosshair above all.

   The kill streak CSS was once inserted in the MIDDLE of this rule's selector list, so
   "#hud.dead #crosshair, ... #hud.dead #hudbr," ran straight into "#streak{...}". The
   dead crosshair then took the streak emblem's box (84x70, shifted 42px left) and lost
   its opacity:0 !important - and since the ADS code sets the crosshair's opacity inline
   every frame, it stayed visible, up and to the left of centre, on every death.
   Measured in Chromium before the fix: 84x70 at -42px, opacity 1. After: 18x18, 0.

   node renderer/test/hud-dead.test.js */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d !== undefined ? '   [' + d + ']' : '')); if(!cond) fails++; };
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
// every top-level rule as [selectors, body]; @keyframes bodies are skipped
const rules = []; let i = 0;
while(i < css.length){
  const o = css.indexOf('{', i); if(o < 0) break;
  const sel = css.slice(i, o).trim();
  let d = 0, j = o; for(; j < css.length; j++){ if(css[j] === '{') d++; else if(css[j] === '}'){ d--; if(!d) break; } }
  rules.push([sel, css.slice(o + 1, j)]); i = j + 1;
}
const selOf = s => s.split(',').map(x => x.replace(/\s+/g, ' ').trim());
const deadRule = rules.find(([s]) => selOf(s).includes('#hud.dead #crosshair'));
ok('there is a rule for the crosshair while dead', !!deadRule);
ok('  it hides it outright (opacity:0 !important beats the inline ADS opacity)', deadRule && /opacity:\s*0\s*!important/.test(deadRule[1]), deadRule && deadRule[1].trim().slice(0, 60));
ok('  and it covers all of your own HUD, nothing else',
   deadRule && JSON.stringify(selOf(deadRule[0]).sort()) === JSON.stringify(['#hud.dead #burnov', '#hud.dead #crosshair', '#hud.dead #frostov', '#hud.dead #hitmark', '#hud.dead #hudbl', '#hud.dead #hudbr', '#hud.dead #lowhp']),
   deadRule && selOf(deadRule[0]).join(' | '));
const crossRules = rules.filter(([s]) => selOf(s).some(x => /#crosshair\b/.test(x) && !/:(before|after)/.test(x)));
ok('nothing else sizes or moves the crosshair (only its own rule and the dead rule)', crossRules.length === 2, crossRules.map(r => r[0].replace(/\s+/g, ' ')).join(' || '));
console.log(fails ? '\nhud-dead: ' + fails + ' failure(s)' : '\nhud-dead: all clear');
process.exit(fails ? 1 : 0);
