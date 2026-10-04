# SplitEasy 💸

Split trip, party and group expenses with friends: log who paid, who's in, and see who owes whom.
Works on desktop and mobile and installs as an app (PWA).

Live: https://subhodippal.github.io/billSplit/

## Two modes

| | Offline mode | Cloud mode (Supabase) |
|---|---|---|
| Turned on when | `config.js` is empty | `config.js` has your Supabase URL + anon key |
| Login | Just your name, on this device | Real accounts (email + password or email link) |
| Data | This browser only | Supabase Postgres |
| Sharing | Link carrying a copy of the split; you merge copies by hand | Invite by email or link; everyone edits the same split **live** |

## Set up Supabase (about 5 minutes)

1. **Create a project** at [supabase.com](https://supabase.com). The free tier is plenty.
2. **Create the database.** Open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   It creates the tables, row-level security rules, sharing functions and realtime. It's safe to run again after updates.
3. **Allow your site to log in.** Under **Authentication → URL Configuration**:
   - **Site URL:** `https://subhodippal.github.io/billSplit/`
   - **Redirect URLs:** add `https://subhodippal.github.io/billSplit/` (and `http://localhost:8000/` if you test locally).
4. **Connect the app.** Under **Project Settings → API**, copy the **Project URL** and the **anon public** key into `config.js`:
   ```js
   window.SPLITEASY_CONFIG = {
     supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
     supabaseAnonKey: 'eyJhbGciOi...'
   };
   ```
   The anon key is meant to be public. The security rules in the database decide who can read or change what.
   **Never** put the `service_role` key in this file.
5. Commit and push. GitHub Pages serves the new version.

Leave **Authentication → Providers → Email → Confirm email** on (the default). It makes sure
nobody can sign up with someone else's email and claim invites meant for them.

## How sharing works (cloud mode)

- Open a split and tap **↗ Share**:
  - **Invite by email.** If they already have an account they get access immediately. If not, they get it the moment they sign up with that email.
  - **Invite link.** Anyone who opens it and signs in joins the split. The owner can **Reset link** to stop old links from working.
- Everyone with access can add, edit and delete entries, and add or rename people. Changes appear on everyone's
  screen instantly (look for the green **● LIVE** tag).
- The creator is the **owner**: only they can delete the split, remove people's access or reset the link.
  Others can **Leave split**.
- Splits you made in offline mode show a **Move to my account** banner after you sign in.

"People" in a split (Alex, Max, Neil…) are just names for splitting costs. They don't need an account.
Only people who should *edit* the split need to sign up.

## Files

- `index.html`, `style.css`: UI
- `script.js`: app logic (views, entries, exclusions, settle-up)
- `cloud.js`: Supabase layer (auth, storage, sharing, realtime)
- `config.js`: your Supabase keys
- `supabase/schema.sql`: database schema, security rules and functions
- `sw.js`, `manifest.json`: offline/PWA support
