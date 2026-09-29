/* Which parts can go on the auction, and the UI saying so.

   Tradeable: live PvP drops (and anything bought on the auction). Soulbound: offline
   drops and, since migration 022, daily-store buys - the shop is personal, so letting its
   parts move meant alt accounts were free shop rerolls. The database refuses to list a
   bound part; the UI must agree: a brass mark on tradeable cards only, and no AUCTION
   button where it could only fail.

   node renderer/test/tradeable.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d !== undefined ? '   [' + d + ']' : '')); if(!cond) fails++; };
function lift(n){
  const m = html.match(new RegExp('(?:async\\s+)?function ' + n + '\\('));
  if(!m) throw new Error('missing function ' + n);
  let j = html.indexOf('{', html.indexOf(')', m.index)), d = 0;
  for(; j < html.length; j++){ if(html[j] === '{') d++; else if(html[j] === '}'){ d--; if(!d) return html.slice(m.index, j + 1); } }
  throw new Error('unbalanced ' + n);
}
const ctx = vm.createContext({ ACCOUNT: { online: true } });
const icons = html.slice(html.indexOf('const TB_ICON = {'), html.indexOf('};', html.indexOf('const TB_ICON = {')) + 2);
vm.runInContext(icons + lift('tradeBadge') + lift('partFromRow'), ctx);

ok('a part row from the database carries its soulbound flag', ctx.partFromRow({ uid: 'a', bound: true }).bound === true && ctx.partFromRow({ uid: 'b', bound: false }).bound === false);
ok('tradeable parts get the brass trade mark, named on hover', /class="tb tr" title="Tradeable/.test(ctx.tradeBadge({ bound: false })));
ok('soulbound parts get no mark at all (the lock is kept for a future scrap-protect toggle)', ctx.tradeBadge({ bound: true }) === '' && !/TB_ICON\.sb|class="tb sb"/.test(html));
ok('no mark when the status is unknown (a local-only save)', ctx.tradeBadge({}) === '' && ctx.tradeBadge({ bound: 'x' }) === '');
ctx.ACCOUNT.online = false;
ok('no mark without an account session (no auction to trade on)', ctx.tradeBadge({ bound: false }) === '');
ok('every part card shows the mark beside its rarity', /'<\/span>'\+tradeBadge\(p\)\+'<span class="ww">'/.test(lift('partCard')));
ok('daily-store cards carry no trade mark (they are soulbound), and the store says so', /partCard\(Object\.assign\(\{ bound: true \}, it\)/.test(lift('renderStore')) && /Store parts are soulbound/.test(lift('renderStore')));
ok('the locker has no AUCTION button on soulbound parts', /\(p\.bound \? '' : '<button class="btn sm" '\+lock\+' onclick="openList\(/.test(lift('renderInventory')));
ok('  and opening a listing for one is refused before it reaches the server', /if\(p\.bound\)\{ toast\('SOULBOUND/.test(lift('openList')));
console.log(fails ? '\ntradeable: ' + fails + ' failure(s)' : '\ntradeable: all clear');
process.exit(fails ? 1 : 0);
