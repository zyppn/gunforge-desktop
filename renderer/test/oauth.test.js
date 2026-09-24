/* The loopback listener that carries a Discord sign-in back into the desktop app.
   Run for real against 127.0.0.1 - it is a socket, and the ways it fails (a busy port,
   an error delivered in the #fragment, a tab left open) only show up on a real one.

   Also the packaging tripwire: electron-builder ships ONLY the files listed in
   build.files. A module main.js requires that is not on that list works perfectly
   under `npm start` and kills the packaged app at launch.

   node renderer/test/oauth.test.js */
const http = require('http'), path = require('path'), fs = require('fs'), net = require('net');
const ROOT = path.join(__dirname, '..', '..');
const { oauthListen, isAuthUrl, PORTS } = require(path.join(ROOT, 'oauth-loopback.js'));
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d ? '   [' + d + ']' : '')); if(!cond) fails++; };
const get = url => new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
// test ports, so a running copy of the game cannot collide with the suite
const T = [55682, 55683, 55684];

(async () => {
  /* packaging */
  const files = require(path.join(ROOT, 'package.json')).build.files;
  const reqs = [...fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').matchAll(/require\('\.\/([^']+)'\)/g)]
    .map(m => m[1].replace(/\.js$/, '') + '.js');
  for(const r of reqs) ok(r + ' (required by main.js) ships in build.files', files.includes(r));
  ok('the shipped ports are the three listed in AUTH_SETUP.md', PORTS.join() === '53682,53683,53684'
     && PORTS.every(p => fs.readFileSync(path.join(ROOT, 'server', 'AUTH_SETUP.md'), 'utf8').includes('127.0.0.1:' + p)));

  /* a code arrives */
  {
    const L = await oauthListen({ ports: T });
    ok('binds to loopback only', L.server.address().address === '127.0.0.1');
    ok('redirect is the callback path on that port', L.redirect === 'http://127.0.0.1:' + T[0] + '/auth/callback');
    ok('other paths are 404', (await get('http://127.0.0.1:' + T[0] + '/')).status === 404);
    const page = await get(L.redirect + '?code=abc123');
    const r = await L.result;
    ok('the code is delivered', r.code === 'abc123');
    ok('the browser tab says it worked', /DISCORD CONNECTED/.test(page.body));
    await new Promise(z => setTimeout(z, 30));
    let closed = false; await get(L.redirect).catch(() => { closed = true; });
    ok('the listener closes after one result', closed);
  }
  /* a busy port falls through to the next */
  {
    const blocker = net.createServer().listen(T[0], '127.0.0.1');
    await new Promise(z => blocker.once('listening', z));
    const L = await oauthListen({ ports: T });
    ok('a busy first port falls through to the second', L.port === T[1]);
    L.close(); ok('close() settles as cancelled', (await L.result).cancelled === true);
    blocker.close();
  }
  /* errors, in the query and in the fragment */
  {
    const L = await oauthListen({ ports: T });
    const p = await get(L.redirect + '?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked');
    const r = await L.result;
    ok('a query-string error is delivered with its code', r.error_code === 'identity_already_exists');
    ok('  and the tab says what happened', /already linked/.test(p.body));
  }
  {
    const L = await oauthListen({ ports: T });
    const first = await get(L.redirect);                   // what the browser sees when the error is in #fragment
    ok('with nothing in the query, the page relays the #fragment back', /location\.hash/.test(first.body));
    await get(L.redirect + '?error=access_denied&error_description=cancelled');   // what that script sends
    ok('  and the relayed error is delivered', (await L.result).error === 'access_denied');
  }
  /* nobody comes back */
  {
    const L = await oauthListen({ ports: T, timeoutMs: 60 });
    ok('an abandoned tab times out instead of waiting forever', (await L.result).timeout === true);
  }
  /* what main is allowed to open */
  ok('opens the project auth URL', isAuthUrl('https://rrpqxsiqvjhwbryencpj.supabase.co/auth/v1/authorize?provider=discord'));
  ok('opens Discord', isAuthUrl('https://discord.com/oauth2/authorize?client_id=1'));
  for(const bad of ['file:///etc/passwd', 'http://evil.supabase.co/x', 'https://supabase.co.evil.com/', 'https://evil.com/?discord.com', 'javascript:alert(1)'])
    ok('refuses ' + bad, !isAuthUrl(bad));

  console.log(fails ? '\noauth: ' + fails + ' failure(s)' : '\noauth: all clear');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
