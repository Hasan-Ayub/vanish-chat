# Vanish Chat

A messaging web app where every message, image and video is **permanently deleted after 24 hours**. Built as a zero-build static site so it runs on GitHub Pages.

Features:

- Username + password accounts (salted PBKDF2-SHA256 hashing in the browser)
- Stay signed in on a device until you explicitly log out
- Cross-device messaging through a **zero-setup public relay** — no Supabase, no API keys, no configuration
- Images and videos up to **500 MB** per file (split into chunks and reassembled by the recipient)
- Automatic 24-hour deletion, with live countdowns and upload progress
- Download individual files or export a whole chat (small media embedded) before expiry
- Local-first storage in IndexedDB; relay messages are retained only for 24 hours

## Live site

Enabled via GitHub Pages at `https://hasan-ayub.github.io/vanish-chat/`.

## How cross-account messaging works

GitHub Pages only serves static files, so it cannot store or forward chats. Vanish Chat uses a **public anonymous MQTT-over-WebSocket broker** as a relay:

1. On startup the app connects to the broker and subscribes to your private inbox topic (derived from a hash of your username).
2. When you send a message, it is published to the recipient's inbox as a **retained** message with a **24-hour expiry**. If they are offline, the broker keeps it until they open the app.
3. Files over 256 KB are split into 256 KB chunks, published to chunk topics, and reassembled into a Blob on the recipient's device.
4. When a message expires, the app deletes its local copy and publishes an empty retained payload to clear the broker topic. The broker's own message-expiry timer is a second line of defence.

You can switch brokers in **Settings → Relay connection** if the default is unavailable.

## Storage and expiry

| Item | Where it lives | Lifetime |
| --- | --- | --- |
| Account + session | Browser IndexedDB / localStorage | Until logout / app data cleared |
| Chats and message text | Browser IndexedDB + retained relay topic | 24 hours from send time |
| Images and videos | Browser IndexedDB + relay chunk topics | 24 hours from send time |

A purge runs on page load, every minute, and on every sync. Each browser also re-downloads and reassembles media it has not seen yet.

**Important:** "deleted" means removed from your storage and the relay. Recipients can still screenshot, copy text or download files before they expire. There is no way to revoke a file someone already downloaded.

## Limits and security notes

- **Per file:** 500 MB. Very large files are slow because they travel as many chunks — keep this tab open while sending.
- The relay is **public**. Topics are derived from username hashes, but anyone who knows a username could subscribe to that inbox. **Do not use this for sensitive information.**
- A password hash is stored in a retained profile topic so you can sign in on another device. It is salted and PBKDF2-hardened (210,000 iterations), but it is still public data — use a strong, unique password.
- The "stay signed in" token is a random 32-byte value kept in the browser until you log out. Anyone with access to your browser profile can use your session.
- Public brokers can be slow or rate-limited. For private, production-grade messaging, use a real backend (the old `supabase/schema.sql` is kept as an example of that approach).

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
- `styles.css` — liquid glass styling
- `config.js` — relay broker selection
- `js/db.js` — IndexedDB storage, chunks and purging
- `js/crypto.js` — password hashing and session tokens
- `js/relay.js` — MQTT WebSocket relay client and chunked file transfer
- `js/app.js` — UI and app logic
- `supabase/schema.sql` — legacy optional backend schema
