# Vanish Chat

A messaging web app where every message, image and video is **permanently deleted after 24 hours**. Built as a zero-build static site so it runs on GitHub Pages.

Features:

- Username + password accounts (salted PBKDF2-SHA256 hashing in the browser)
- Stay signed in on a device until you explicitly log out
- Direct image and video sharing (up to 50 MB per file)
- Automatic 24-hour deletion of messages **and** media, with live countdowns
- Download individual messages/files or export a whole chat (media embedded) before expiry
- Local-first storage in IndexedDB, with optional Supabase sync for real cross-device messaging

## Live site

Enabled via GitHub Pages at `https://hasan-ayub.github.io/vanish-chat/`.

## Two modes

### 1. Local demo mode (default, no setup)

Everything — accounts, chats, messages and media — lives in **this browser only**. You can create multiple accounts and switch between them on the same device, but two people on different devices cannot see each other's messages.

This mode is useful for trying the app and for understanding the 24-hour behaviour.

### 2. Cloud mode (Supabase)

To actually message other people across devices, connect a Supabase project:

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql). Run it.
3. In **Project Settings → API**, copy the **Project URL** and the **anon / public** key.
4. Open the app, create/sign in to an account, then go to **Settings → Cloud connection**, paste both values and click **Save & reload**.

Now accounts are shared across devices, users can find each other by username, and messages/media sync through Supabase. Messages still disappear after 24 hours: each client purges its local copy and the cloud row, and you can optionally schedule `select public.delete_expired_messages();` with Supabase Cron to clean up server rows even when no one is online.

You can also set the values directly in [`config.js`](config.js).

## Storage and expiry

| Item | Where it lives | Lifetime |
| --- | --- | --- |
| Account + session | Browser IndexedDB / localStorage | Until logout / app data cleared |
| Chats and message text | Browser IndexedDB, optionally Supabase | 24 hours from send time |
| Images and videos | Browser IndexedDB, optionally Supabase Storage | 24 hours from send time |

A purge runs on page load, every minute, and whenever cloud sync runs. Expired rows are removed from both the browser and (in cloud mode) Supabase.

**Important:** "deleted" means removed from your storage. Recipients can still screenshot, copy text or download files before they expire. There is no way to revoke a file someone already downloaded.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (210,000 iterations) before being stored. The raw password is never saved.
- The "stay signed in" token is a random 32-byte value kept in the browser until you log out. Anyone with access to your browser profile can use your session.
- The Supabase anon key is public by design. The included RLS policies use a client-supplied `x-vanish-user` header, which is suitable for a **prototype**, not for sensitive data — a determined user can spoof that header. For production, replace it with [Supabase Auth](https://supabase.com/docs/guides/auth) and base policies on `auth.uid()`.
- Media in the Supabase `media` bucket is public-by-URL for 24 hours. URLs are random UUID paths and the objects are deleted on expiry.

## Development

No build step, no dependencies. Serve the folder over HTTP (ES modules need it):

```bash
python -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080`.

## Files

- `index.html` — app shell
- `styles.css` — styling
- `config.js` — optional Supabase credentials
- `js/db.js` — IndexedDB storage and purging
- `js/crypto.js` — password hashing and session tokens
- `js/cloud.js` — Supabase REST/Storage adapter
- `js/app.js` — UI and app logic
- `supabase/schema.sql` — database schema and policies
