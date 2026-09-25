# Accounts, backups and the database: one-time setup

Everything here is done in the Supabase dashboard (project `rrpqxsiqvjhwbryencpj`)
or on the arena server. None of it is in code, which is why it is written down.

## 1. Check who can call the economy functions (do this first)

SQL editor:

```sql
select p.proname,
       p.prosecdef                                               as security_definer,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as players_can_call
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by 1;
```

`add_progress` and `buy_store_part` must read **false / false**. If either reads true,
any copy of the game can call it directly with its own parameters (free parts, free
credits, for any player). Run `migrations/015_server_only_rpcs.sql`, then re-run the
query. The arena server uses the service key and is unaffected.

## 2. Save `add_progress` into the repo

It exists only in the live database. Dump it:

```sql
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'add_progress';
```

Paste the output into `migrations/016_add_progress.sql` (as `create or replace function`),
then remove `add_progress` from `KNOWN_MISSING` in `server/test/rpcs.test.js`. That test
fails until both are done, in either order.

## 3. Backups

Dashboard → Database → Backups shows what the plan keeps. The Free plan keeps
nothing; Pro keeps daily backups for 7 days, restorable only into this same project.
Either way, keep our own: `server/ops/backup-db.sh` dumps the `public` schema nightly
on the arena server. Setup steps are at the top of that file. The connection string is
Project Settings → Database → Connection string → **Session pooler** (the direct
connection is IPv6-only and the Oracle box may not route IPv6).

Test a restore once, into a scratch project. A backup nobody has restored is a hope.

## 4. Sign-in: Discord and username + password

### Discord

Guests click CONNECT DISCORD on the main menu. That attaches Discord to the account
they already have (the uid does not change, so the locker stays), and on any other PC
signing in with Discord lands on the same account. Discord's page opens in the
player's own browser; the result comes back to the game through a one-shot listener on
127.0.0.1 (`oauth-loopback.js`).

1. **Discord app.** https://discord.com/developers/applications → New Application
   (name it GUNFORGE; players see this name and icon on the approval page).
   OAuth2 → Redirects → add exactly:
   `https://rrpqxsiqvjhwbryencpj.supabase.co/auth/v1/callback`
   Copy the **Client ID**, then Reset Secret and copy the **Client Secret**.
2. **Supabase provider.** Authentication → Sign In / Providers → Discord → enable,
   paste the Client ID and Client Secret, save.
3. **Manual linking ON.** Authentication → Sign In / Up → "Allow manual linking".
   This is what lets a guest attach Discord instead of getting a new, empty account.
   With it off, CONNECT DISCORD on a guest with progress reports a setup error.
4. **Anonymous sign-ins stay ON** (same page). Every new install starts as a guest.
5. **Redirect URLs.** Authentication → URL Configuration → Redirect URLs → add all
   three, exactly:
   `http://127.0.0.1:53682/auth/callback`
   `http://127.0.0.1:53683/auth/callback`
   `http://127.0.0.1:53684/auth/callback`
   The game uses the first free port. A URL missing from this list does not error: Supabase
   silently sends the player to the Site URL instead, and the game waits until it times out.
6. **Test** on a guest with a part or two: CONNECT DISCORD, approve in the browser, and
   the menu should read ACCOUNT SECURED with your Discord name and the same locker. Then
   sign in on a second machine (or a fresh user profile) and check it is the same locker.

`renderer/test/account.test.js` checks the flow against these endpoints and
`renderer/test/oauth.test.js` checks the listener on a real socket.

### Username + password

The other button on the guest row. A player can have this, Discord, or both on one
account; the menu offers whichever is missing.

1. **Confirm email OFF.** Authentication → Sign In / Providers → Email → turn off
   "Confirm email". Usernames are stored as hidden addresses (`name@players.voxabase.com`,
   see `LOGIN_DOMAIN` in the client) that no mail is ever sent to. With confirmation on,
   a new login waits for an email nobody will read and never works; the game detects this
   and says it is a setup problem.
2. Same page: **Minimum password length** 8, to match what the game asks for.
3. **Test both directions on one account**, because this is the one behaviour the
   automated test can only model: create a login on a guest, add Discord, then sign in
   on another machine with the USERNAME. Then the reverse order with a fresh guest. Both
   sign-ins must land on the same locker.

There is no password reset: nothing is behind the hidden address to send one to. The
game says so before a player creates a login, and suggests adding Discord as a second
way in.

### Email (optional, later)

The email-code functions (`authLinkEmail`, `authSendLoginCode`, `authVerifyCode`) are
still in the client and tested, with no menu button. To offer real email: set up custom
SMTP (Supabase's built-in mailer only delivers to your own Supabase team), put
`{{ .Token }}` in the **Change Email Address** and **Magic Link** templates, and give
them a screen.

## 5. Moving to Steam later

Yes, this carries over. Accounts are keyed by the Supabase user id
(`players.auth_uid`), not by how someone signs in. Discord is one identity on that user,
and Steam becomes another one on the same user:

- The Steam build gets a session ticket from Steamworks (`GetAuthTicketForWebApi`) and
  sends it to the arena server, which verifies it with Steam's Web API
  (`ISteamUserAuth/AuthenticateUserTicket`) and gets a SteamID.
- First launch on Steam: the player signs in once with Discord or their username, and
  the server stores the SteamID against that Supabase user. From then on the SteamID
  alone signs them in.
- Supabase has no built-in Steam provider (Steam uses OpenID 2.0, not OAuth), so the
  arena server issues the session. It already holds the service key.

What makes this work is that players have a recoverable identity **before** the move.
A guest who never connected Discord can still carry over from the same PC (the guest
session is on disk), but not from a new one. So the more players connect Discord before
a Steam launch, the fewer lockers are stranded.

### Retiring Discord and username logins afterwards

Order matters, or players are locked out of their own lockers:

1. Ship the Steam build with the one-time "sign in to link Steam" step above.
2. Keep both old logins working for a grace period (a season, a couple of months)
   while the standalone build is still in players' hands.
3. Then remove the CONNECT DISCORD / CREATE LOGIN / SIGN IN buttons from the menu.
   Leave the identities valid in Supabase: it costs nothing, and a player who links
   late can still get in once to attach Steam.

