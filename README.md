# Vanish Chat

A messaging web app where every message, image and video is **permanently deleted after 24 hours**. Built as a zero-build static site so it runs on GitHub Pages, with an optional hosted database for real cross-device accounts.

## Features

- Username + password accounts that work on **every device** when Supabase is configured
- Stay signed in on a device until you explicitly log out
- Server-side accounts, chats, messages and media (Supabase), with a zero-setup MQTT relay fallback
- Send up to **10 images/videos at once**, each up to **500 MB** (split into chunks and reassembled by the recipient)
- Automatic 24-hour deletion, live countdowns and upload progress
- On phones, choose saved photos/videos or open the camera from the attach sheet
- Tap a received photo/video to open it in the app's own viewer, with next/previous and download buttons
- Download individual files or export a whole chat before expiry
- iPhone-inspired liquid glass UI for phones, tablets and desktops
- IndexedDB is used only as a local cache; the server is the source of truth when configured

## Live site

Enabled via GitHub Pages at `https://hasan-ayub.github.io/vanish-chat/`.

GitHub Pages only serves static files — it **cannot host a database**. To have the same account and data on multiple devices, connect a free Supabase project as described below.

## Set up the server database (required for shared accounts)

1. Create a free project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor** and paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql). Run it once. If you ran an older version, run it again — it safely adds the newer `peer_name`, `sender_name`, and `attachments` columns. This creates `profiles`, `chats`, `messages`, the public `media` storage bucket, and row-level security policies.
3. Open **Project Settings → API**. Copy the **Project URL** and the **anon / public key**.
4. Paste both values into [`config.js`](config.js):

   ```js
   const SUPABASE_URL = 'https://your-project.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-key';
   ```

5. Commit and push. Every device running the published site will now use the same database, so the same username/password signs in everywhere and chats/messages/media sync between devices.

You can also paste the values into **Settings → Server database** for a quick test, but values entered there only affect that one browser. Put them in `config.js` before publishing so all devices match.

### Optional: automatic expiry with no user online

The app deletes expired messages whenever it is open. To guarantee cleanup even when nobody is online, schedule the included SQL function with Supabase Cron:

```sql
select cron.schedule(
  'vanish-expiry',
  '*/10 * * * *',
  $$select public.delete_expired_messages()$$
);
```

## How syncing works

With Supabase configured:

1. **Registration** creates a profile row with a salted PBKDF2-SHA256 password hash. Signing in on a new device fetches that profile from the server, so the same credentials work everywhere.
2. **Chats** are rows in `public.chats`, visible only to the two participants through RLS.
3. **Messages** are rows in `public.messages`, readable/deletable only by the sender and recipient. The app polls every 5 seconds and caches rows in IndexedDB.
4. **Files** are uploaded as numbered objects to the `media` bucket (`{sender-id}/{media-id}/{part}`) and reassembled by the recipient. Uploads are scoped by RLS to the signed-in user's folder.
5. **Expiry** removes the row and its media objects 24 hours after send time. A server-side cleanup function can run even when no device is online.

If no Supabase URL/key is present, the app falls back to the older zero-setup public MQTT relay:

- Messages are retained on per-user topics with a 24-hour broker expiry.
- Files are split into 256 KB chunks, published to chunk topics, and reassembled locally.
- You can switch brokers in **Settings → Relay fallback** if the default is unavailable.

## Storage and expiry

| Item | Where it lives (Supabase mode) | Lifetime |
| --- | --- | --- |
| Account + password hash | Server `profiles` table | Until changed/deleted |
| Chat list | Server `chats` table + local cache | Until a participant deletes it |
| Messages | Server `messages` table + local cache | 24 hours from send time |
| Images and videos | Server `media` bucket + local cache | 24 hours from send time |
| Session token | localStorage | Until logout |

**Important:** "deleted" means removed from your storage and the server. Recipients can still screenshot, copy text or download files before they expire. There is no way to revoke a file someone already downloaded.

## Limits and security notes

- **Per file:** 500 MB, up to 10 files per message. Very large files are slow because they travel as many chunks — keep the tab open while sending.
- The Supabase **anon key is public by design**; RLS is what restricts data access. Before production use, review the policies in `supabase/schema.sql`.
- Password hashes are readable by the anon role because client-side sign-in needs them to verify a password on a new device. They are salted and PBKDF2-hardened (210,000 iterations), but they are still sensitive data — use a strong, unique password. For a production app, move login to Supabase Auth so the browser never sees a hash.
- The `media` bucket is public so recipients can fetch files without signed URLs. Object IDs are random UUIDs, but anyone with a full URL can read the object until it is deleted.
- The "stay signed in" token is a random 32-byte value kept in the browser until you log out. Anyone with access to your browser profile can use your session.
- In relay-only mode, topics are derived from username hashes and the broker is public. **Do not use relay-only mode for sensitive information.**

## Development

No build step, no dependencies. Serve the folder over HTTP (ES modules need it):

```bash
python -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080`.

## Files

- `index.html` — responsive app shell
- `styles.css` — liquid glass styling for mobile, tablet and desktop
- `config.js` — Supabase credentials and relay broker selection
- `js/backend.js` — switches between Supabase and the relay fallback
- `js/cloud.js` — Supabase adapter (accounts, chats, messages, media)
- `js/relay.js` — MQTT WebSocket relay client and chunked file transfer
- `js/db.js` — IndexedDB local cache, chunks and purging
- `js/crypto.js` — password hashing and session tokens
- `js/app.js` — UI and app logic
- `supabase/schema.sql` — database tables, RLS policies and cleanup function
