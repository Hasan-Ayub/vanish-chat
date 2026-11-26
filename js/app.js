import * as db from './db.js';
import { uuid, hashPassword, verifyPassword, randomToken } from './crypto.js';
import * as cloud from './cloud.js';
import {
  isCloudConfigured,
  getCloudConfig,
  setCloudConfig,
  clearCloudConfig,
} from '../config.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_EMBED_BYTES = 25 * 1024 * 1024;
const SESSION_KEY = 'vanish-chat.session';

const state = {
  authTab: 'login',
  currentUser: null,
  accounts: [],
  chats: [],
  messages: [],
  selectedChatId: null,
  search: '',
  attachment: null,
  previewUrl: '',
  mediaUrls: new Map(),
  polling: false,
  purging: false,
};

let messageSignature = '';

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  el('toast-root').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatChatTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(timestamp);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function countdown(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'Expired';
  const minutes = Math.floor(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `${hours}h ${minutes % 60}m left`;
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}m ${seconds}s left`;
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (const char of String(name || '?')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `linear-gradient(145deg, hsl(${hash} 65% 64%), hsl(${(hash + 35) % 360} 60% 45%))`;
}

function decorateAvatar(node, name) {
  if (!node) return;
  node.textContent = initials(name);
  node.style.background = avatarColor(name);
}

function identity() {
  return state.currentUser ? (state.currentUser.cloudId || state.currentUser.id) : '';
}

function chatIdFor(a, b) {
  return [a, b].sort().join('::');
}

function peerOf(chat) {
  return chat.participants.find((id) => id !== identity()) || '';
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

async function findAccountByUsername(username) {
  const local = await db.getByIndex('accounts', 'by-username', username);
  if (local[0]) return local[0];
  if (cloud.cloudEnabled()) {
    try {
      const profile = await cloud.cloudGetProfile(username);
      if (profile) {
        const account = {
          id: profile.id,
          cloudId: profile.id,
          username: profile.username,
          salt: profile.salt,
          hash: profile.password_hash,
          createdAt: Date.parse(profile.created_at) || Date.now(),
        };
        await db.put('accounts', account);
        return account;
      }
    } catch (error) {
      throw new Error(`Could not reach the cloud: ${error.message}`);
    }
  }
  return null;
}

async function resolvePeerName(peerId) {
  const accounts = await db.getAll('accounts');
  const local = accounts.find((a) => a.id === peerId || a.cloudId === peerId);
  if (local) return local.username;
  if (cloud.cloudEnabled()) {
    try {
      const profile = await cloud.cloudGetProfileById(peerId);
      if (profile) return profile.username;
    } catch { /* fall through */ }
  }
  return `User ${peerId.slice(0, 6)}`;
}

/* ---------------- Session / auth ---------------- */

async function restoreSession() {
  const token = localStorage.getItem(SESSION_KEY);
  if (!token) return false;
  const session = await db.get('sessions', token);
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return false;
  }
  const account = await db.get('accounts', session.accountId);
  if (!account) return false;

  if (cloud.cloudEnabled() && !account.cloudId) {
    try {
      const profile = await cloud.cloudGetProfile(account.username);
      if (profile && profile.id) {
        account.cloudId = profile.id;
        await db.put('accounts', account);
      }
    } catch { /* keep local identity */ }
  }

  state.currentUser = account;
  cloud.setCloudUser(account.cloudId || account.id);
  return true;
}

async function signIn(accountId) {
  const token = randomToken();
  await db.put('sessions', { token, accountId, createdAt: Date.now(), expiresAt: null });
  localStorage.setItem(SESSION_KEY, token);
  state.currentUser = await db.get('accounts', accountId);
  cloud.setCloudUser(state.currentUser.cloudId || state.currentUser.id);
  await enterApp();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  el('auth-error').textContent = '';
  const username = normalizeUsername(el('auth-username').value);
  const password = el('auth-password').value;
  const confirm = el('auth-confirm').value;
  const submit = el('auth-submit');

  if (!username || username.length < 3) {
    el('auth-error').textContent = 'Username must be at least 3 characters (letters, numbers, _, ., -).';
    return;
  }
  if (!password || password.length < 6) {
    el('auth-error').textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (state.authTab === 'register' && password !== confirm) {
    el('auth-error').textContent = 'Passwords do not match.';
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Please wait…';
  try {
    if (state.authTab === 'register') {
      const existing = await findAccountByUsername(username);
      if (existing) throw new Error('That username is already taken.');

      const { salt, hash } = await hashPassword(password);
      const id = uuid();
      let cloudId = null;
      if (cloud.cloudEnabled()) {
        cloud.setCloudUser(id);
        const profile = await cloud.cloudCreateProfile({ id, username, salt, hash });
        cloudId = profile.id || id;
      }
      await db.put('accounts', { id, cloudId, username, salt, hash, createdAt: Date.now() });
      await signIn(id);
    } else {
      const account = await findAccountByUsername(username);
      const valid = account && (await verifyPassword(password, account.salt, account.hash));
      if (!valid) throw new Error('Invalid username or password.');

      if (cloud.cloudEnabled()) {
        if (!account.cloudId) {
          const profile = await cloud.cloudGetProfile(username);
          if (!profile || !(await verifyPassword(password, profile.salt, profile.password_hash))) {
            throw new Error('This account is not registered in the connected cloud project.');
          }
          account.cloudId = profile.id;
          account.hash = profile.password_hash;
          account.salt = profile.salt;
          await db.put('accounts', account);
        }
        cloud.setCloudUser(account.cloudId);
      }
      await signIn(account.id);
    }
  } catch (error) {
    el('auth-error').textContent = error.message || 'Something went wrong.';
  } finally {
    submit.disabled = false;
    submit.textContent = state.authTab === 'register' ? 'Create account' : 'Sign in';
  }
}

function setAuthTab(tab) {
  state.authTab = tab;
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.authTab === tab);
  });
  el('confirm-field').classList.toggle('hidden', tab !== 'register');
  el('auth-submit').textContent = tab === 'register' ? 'Create account' : 'Sign in';
  el('auth-error').textContent = '';
}

function logout() {
  const token = localStorage.getItem(SESSION_KEY);
  if (token) db.del('sessions', token);
  localStorage.removeItem(SESSION_KEY);
  state.currentUser = null;
  state.chats = [];
  state.messages = [];
  state.selectedChatId = null;
  state.attachment = null;
  clearPreview();
  revokeMediaUrls();
  closeModal();
  document.querySelector('.app-shell')?.classList.remove('chat-open');
  el('main-screen').classList.add('hidden');
  el('auth-screen').classList.remove('hidden');
  el('auth-password').value = '';
  el('auth-confirm').value = '';
  setAuthTab('login');
  renderModePill();
}

/* ---------------- Data loading / rendering ---------------- */

async function loadData() {
  const allChats = await db.getAll('chats');
  const me = identity();
  const chats = allChats
    .filter((chat) => chat.participants.includes(me))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const chatIds = new Set(chats.map((chat) => chat.id));
  const allMessages = await db.getAll('messages');
  const messages = allMessages
    .filter((message) => chatIds.has(message.chatId))
    .sort((a, b) => a.createdAt - b.createdAt);

  // Fill in cached peer names when possible.
  const accounts = await db.getAll('accounts');
  state.accounts = accounts;
  let changed = false;
  for (const chat of chats) {
    if (chat.peerName) continue;
    const peerId = peerOf(chat);
    const match = accounts.find((a) => a.id === peerId || a.cloudId === peerId);
    if (match) {
      chat.peerName = match.username;
      await db.put('chats', chat);
      changed = true;
    }
  }
  if (changed) chats.sort((a, b) => b.updatedAt - a.updatedAt);

  state.chats = chats;
  state.messages = messages;
}

async function enterApp() {
  el('auth-screen').classList.add('hidden');
  el('main-screen').classList.remove('hidden');
  await loadData();
  if (!state.chats.some((chat) => chat.id === state.selectedChatId)) state.selectedChatId = null;
  renderAll();
  renderStorageInfo();
  if (cloud.cloudEnabled()) pollCloud();
}

function renderAll() {
  renderHeader();
  renderChatList();
  renderChat();
}

function renderModePill() {
  const pill = el('mode-pill');
  const enabled = isCloudConfigured();
  pill.textContent = enabled ? 'Cloud connected' : 'Local demo mode';
  pill.classList.toggle('cloud', enabled);
}

function renderHeader() {
  const user = state.currentUser;
  if (!user) return;
  el('me-name').textContent = user.username;
  decorateAvatar(el('me-avatar'), user.username);
  el('me-status').textContent = cloud.cloudEnabled() ? 'Cloud connected' : 'Local demo mode';
}

async function renderStorageInfo() {
  const info = await db.storageEstimate();
  if (!info) {
    el('storage-info').textContent = 'Storage: browser managed';
    return;
  }
  const percent = info.quota ? ((info.usage / info.quota) * 100).toFixed(1) : '0';
  el('storage-info').textContent = `Storage: ${formatBytes(info.usage)} (${percent}%)`;
}

function renderChatList() {
  const list = el('chat-list');
  const chats = state.chats.filter((chat) =>
    !state.search || (chat.peerName || '').toLowerCase().includes(state.search)
  );

  if (!chats.length) {
    list.innerHTML = `<div class="chat-empty">${state.search
      ? 'No matching chats.'
      : 'No chats yet. Tap “New chat” to find someone by username.'}</div>`;
    return;
  }

  list.innerHTML = chats.map((chat) => {
    const peerName = chat.peerName || resolvePeerNameSync(peerOf(chat));
    const last = state.messages.filter((m) => m.chatId === chat.id).at(-1);
    let preview = 'No messages yet';
    if (last) {
      if (last.type === 'image') preview = '📷 Photo';
      else if (last.type === 'video') preview = '🎬 Video';
      else preview = last.text || 'Message';
    }
    return `
      <button class="chat-item ${chat.id === state.selectedChatId ? 'active' : ''}" data-chat-id="${escapeHtml(chat.id)}">
        <div class="avatar" style="background:${avatarColor(peerName)}">${escapeHtml(initials(peerName))}</div>
        <div class="chat-body">
          <div class="chat-top">
            <span class="chat-name">${escapeHtml(peerName)}</span>
            <span class="chat-time">${last ? formatChatTime(last.createdAt) : ''}</span>
          </div>
          <div class="chat-preview">${escapeHtml(preview)}</div>
        </div>
      </button>`;
  }).join('');
}

function resolvePeerNameSync(peerId) {
  const accounts = state.accounts || [];
  const match = accounts.find((a) => a.id === peerId || a.cloudId === peerId);
  return match ? match.username : `User ${peerId.slice(0, 6)}`;
}

function revokeMediaUrls() {
  for (const url of state.mediaUrls.values()) URL.revokeObjectURL(url);
  state.mediaUrls.clear();
}

function forceMessageRender() {
  messageSignature = '';
}

async function renderChat() {
  const chat = state.chats.find((c) => c.id === state.selectedChatId);
  const panel = document.querySelector('.app-shell');
  if (!chat) {
    el('chat-head').classList.add('hidden');
    el('composer').classList.add('hidden');
    el('messages').classList.add('hidden');
    el('empty-state').classList.remove('hidden');
    panel?.classList.remove('chat-open');
    return;
  }

  el('chat-head').classList.remove('hidden');
  el('composer').classList.remove('hidden');
  el('messages').classList.remove('hidden');
  el('empty-state').classList.add('hidden');
  panel?.classList.add('chat-open');

  const peerName = chat.peerName || resolvePeerNameSync(peerOf(chat));
  el('peer-name').textContent = peerName;
  decorateAvatar(el('peer-avatar'), peerName);

  const messages = state.messages.filter((m) => m.chatId === chat.id);
  const signature = messages.map((m) => m.id).join('|');
  if (signature === messageSignature) {
    updateCountdowns();
    return;
  }
  messageSignature = signature;
  revokeMediaUrls();

  const rows = await Promise.all(messages.map(async (message) => {
    const mine = message.senderId === identity();
    let mediaHtml = '';
    if (message.mediaId) {
      const media = await db.get('media', message.mediaId);
      if (media) {
        const url = URL.createObjectURL(media.blob);
        state.mediaUrls.set(message.mediaId, url);
        const tag = message.type === 'video'
          ? `<video src="${url}" controls playsinline></video>`
          : `<img src="${url}" alt="${escapeHtml(message.mediaName || 'image')}">`;
        mediaHtml = `<div class="bubble-media">${tag}</div>`;
      } else {
        mediaHtml = '<div class="media-missing">Media expired or unavailable</div>';
      }
    }
    return `
      <div class="msg-row ${mine ? 'out' : ''}">
        <div class="bubble">
          ${mediaHtml}
          ${message.text ? `<div class="bubble-text">${escapeHtml(message.text)}</div>` : ''}
          <div class="bubble-foot">
            ${message.mediaId ? `<button class="download-btn" data-download="${escapeHtml(message.id)}">Download</button>` : ''}
            <span class="expiry-chip ${message.expiresAt - Date.now() < 3600000 ? 'urgent' : ''}" data-expiry="${message.expiresAt}">${countdown(message.expiresAt)}</span>
            <span class="msg-time">${formatTime(message.createdAt)}</span>
          </div>
        </div>
      </div>`;
  }));

  el('messages').innerHTML = rows.join('');
  requestAnimationFrame(() => scrollToBottom());
}

function scrollToBottom() {
  const container = el('messages');
  container.scrollTop = container.scrollHeight;
}

function updateCountdowns() {
  document.querySelectorAll('[data-expiry]').forEach((node) => {
    node.textContent = countdown(Number(node.dataset.expiry));
  });
}

/* ---------------- Chats / sending ---------------- */

function openModal(html) {
  el('modal-root').innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true">${html}</div>
    </div>`;
}

function closeModal() {
  el('modal-root').innerHTML = '';
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
}

function openNewChatModal() {
  const example = cloud.cloudEnabled()
    ? 'Search any username registered in the connected cloud project.'
    : 'In local demo mode you can only find accounts created in this browser. Connect a cloud project to message other devices.';
  openModal(`
    <div class="modal-head"><h3>New chat</h3><button class="icon-btn" data-action="close-modal">✕</button></div>
    <div class="modal-section">
      <p>${escapeHtml(example)}</p>
      <label class="field"><span>Username</span>
        <input id="new-chat-username" placeholder="username" autocomplete="off" spellcheck="false">
      </label>
      <div class="modal-actions">
        <button class="btn primary" data-action="new-chat-submit">Start chat</button>
      </div>
    </div>`);
  setTimeout(() => el('new-chat-username')?.focus(), 50);
}

async function startChatWith(rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!username) return toast('Enter a username first.', 'error');
  if (username === normalizeUsername(state.currentUser.username)) {
    return toast("You can't chat with yourself.", 'error');
  }

  let peerId;
  let peerName;
  try {
    if (cloud.cloudEnabled()) {
      const profile = await cloud.cloudGetProfile(username);
      if (!profile) return toast('No user with that username.', 'error');
      peerId = profile.id;
      peerName = profile.username;
    } else {
      const found = await db.getByIndex('accounts', 'by-username', username);
      if (!found.length) {
        return toast('No local account found. Connect a cloud project to message other devices.', 'error');
      }
      peerId = found[0].cloudId || found[0].id;
      peerName = found[0].username;
    }
  } catch (error) {
    return toast(`Lookup failed: ${error.message}`, 'error');
  }

  const id = chatIdFor(identity(), peerId);
  let chat = state.chats.find((c) => c.id === id);
  if (!chat) {
    chat = { id, participants: [identity(), peerId], peerName, createdAt: Date.now(), updatedAt: Date.now() };
  } else if (chat.peerName !== peerName) {
    chat.peerName = peerName;
  }
  await db.put('chats', chat);
  state.selectedChatId = id;
  closeModal();
  await loadData();
  renderAll();
}

function clearPreview() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
  state.attachment = null;
  el('attachment-preview').innerHTML = '';
  el('attachment-preview').classList.add('hidden');
}

function handleFileSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return toast('Please choose an image or a video.', 'error');
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return toast(`Files must be under ${formatBytes(MAX_MEDIA_BYTES)}.`, 'error');
  }
  clearPreview();
  state.attachment = file;
  state.previewUrl = URL.createObjectURL(file);
  const preview = el('attachment-preview');
  preview.innerHTML = file.type.startsWith('video/')
    ? `<video src="${state.previewUrl}" controls></video><button type="button" class="remove-attachment" data-action="remove-attachment">×</button>`
    : `<img src="${state.previewUrl}" alt="Attachment preview"><button type="button" class="remove-attachment" data-action="remove-attachment">×</button>`;
  preview.classList.remove('hidden');
}

async function handleSend(event) {
  event.preventDefault();
  if (!state.selectedChatId) return;
  const text = el('message-input').value.trim();
  const file = state.attachment;
  if (!text && !file) return;

  const button = el('btn-send');
  button.disabled = true;
  try {
    const chat = state.chats.find((c) => c.id === state.selectedChatId);
    if (!chat) throw new Error('Chat not found.');

    const now = Date.now();
    const message = {
      id: uuid(),
      chatId: chat.id,
      senderId: identity(),
      recipientId: peerOf(chat),
      type: file ? (file.type.startsWith('video/') ? 'video' : 'image') : 'text',
      text,
      mediaId: file ? uuid() : null,
      mediaPath: null,
      mediaName: file ? file.name : null,
      mediaMime: file ? file.type : null,
      mediaSize: file ? file.size : null,
      createdAt: now,
      expiresAt: now + RETENTION_MS,
      remote: false,
    };

    if (file) {
      await db.put('media', {
        id: message.mediaId,
        blob: file,
        name: file.name,
        mime: file.type,
        size: file.size,
        createdAt: now,
        expiresAt: message.expiresAt,
      });
      if (cloud.cloudEnabled()) {
        try {
          message.mediaPath = await cloud.cloudUploadMedia(message.mediaId, file, file.name, file.type);
        } catch (error) {
          await db.del('media', message.mediaId);
          throw new Error(`Upload failed: ${error.message}`);
        }
      }
    }

    if (cloud.cloudEnabled()) {
      await cloud.cloudInsertMessage(message);
      message.remote = true;
    }
    await db.put('messages', message);
    await db.put('chats', { ...chat, updatedAt: now });

    el('message-input').value = '';
    clearPreview();
    await loadData();
    renderAll();
    renderStorageInfo();
  } catch (error) {
    toast(error.message || 'Could not send the message.', 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------------- Expiry, cloud polling ---------------- */

async function purgeExpiredNow() {
  if (state.purging) return;
  state.purging = true;
  try {
    const result = await db.purgeExpired();
    for (const message of result.messages) {
      if (cloud.cloudEnabled() && message.remote) {
        try {
          await cloud.cloudDeleteMessage(message.id);
          if (message.mediaPath) await cloud.cloudDeleteMedia(message.mediaPath);
        } catch { /* cloud row may already be gone */ }
      }
    }
    if (result.messages.length) {
      forceMessageRender();
      await loadData();
      renderAll();
      toast(`Deleted ${result.messages.length} expired message${result.messages.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    console.warn('Purge failed', error);
  } finally {
    state.purging = false;
  }
}

async function pollCloud() {
  if (!cloud.cloudEnabled() || !state.currentUser || state.polling) return;
  state.polling = true;
  try {
    const me = identity();
    const rows = await cloud.cloudFetchMessages(me);
    const remoteIds = new Set(rows.map((row) => row.id));
    let added = false;

    for (const row of rows) {
      if (await db.get('messages', row.id)) continue;
      let chat = await db.get('chats', row.chat_id);
      if (!chat) {
        const peerId = row.sender_id === me ? row.recipient_id : row.sender_id;
        chat = {
          id: row.chat_id,
          participants: [me, peerId],
          peerName: await resolvePeerName(peerId),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.put('chats', chat);
      }

      const message = {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
        type: row.kind || 'text',
        text: row.body || '',
        mediaId: row.media_path ? `${row.id}-media` : null,
        mediaPath: row.media_path || null,
        mediaName: row.media_name || null,
        mediaMime: row.media_mime || null,
        mediaSize: row.media_size || null,
        createdAt: Date.parse(row.created_at) || Date.now(),
        expiresAt: Date.parse(row.expires_at) || Date.now() + RETENTION_MS,
        remote: true,
      };
      await db.put('messages', message);
      added = true;

      if (row.media_path && !(await db.get('media', message.mediaId))) {
        fetchCloudMedia(message);
      }
    }

    // A row disappearing from the server means it expired or was deleted.
    const locals = await db.getAll('messages');
    for (const message of locals) {
      if (message.remote && !remoteIds.has(message.id)) {
        if (message.mediaId) await db.del('media', message.mediaId);
        await db.del('messages', message.id);
        added = true;
      }
    }

    if (added) {
      forceMessageRender();
      await loadData();
      renderAll();
    }
  } catch (error) {
    console.warn('Cloud sync failed', error);
  } finally {
    state.polling = false;
  }
}

async function fetchCloudMedia(message) {
  try {
    const url = cloud.cloudMediaUrl(message.mediaPath);
    const response = await fetch(url);
    if (!response.ok) return;
    const blob = await response.blob();
    await db.put('media', {
      id: message.mediaId,
      blob,
      name: message.mediaName || 'media',
      mime: message.mediaMime || blob.type,
      size: blob.size,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    });
    forceMessageRender();
    renderChat();
  } catch (error) {
    console.warn('Could not download media', error);
  }
}

/* ---------------- Download / export ---------------- */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function safeFilename(value) {
  return String(value || 'vanish-chat').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadMessage(id) {
  const message = state.messages.find((m) => m.id === id);
  if (!message) return;
  if (message.mediaId) {
    let media = await db.get('media', message.mediaId);
    if (!media && message.mediaPath && cloud.cloudEnabled()) {
      await fetchCloudMedia(message);
      media = await db.get('media', message.mediaId);
    }
    if (media) return downloadBlob(media.blob, media.name || 'media');
    toast('Media is no longer available.', 'error');
    return;
  }
  downloadBlob(new Blob([message.text], { type: 'text/plain' }), `${safeFilename(message.id)}.txt`);
}

async function exportData(chatIds, label) {
  const exportButton = document.querySelector('[data-action="export-all"]') || el('btn-export');
  if (exportButton) exportButton.disabled = true;
  try {
    const chats = state.chats.filter((chat) => chatIds.includes(chat.id));
    const messages = state.messages.filter((message) => chatIds.includes(message.chatId));
    const totalMedia = messages.reduce((sum, message) => sum + (message.mediaSize || 0), 0);
    const embedMedia = totalMedia <= MAX_EMBED_BYTES;

    const payload = {
      app: 'Vanish Chat',
      exportedAt: new Date().toISOString(),
      retentionHours: 24,
      note: embedMedia
        ? 'Media is embedded as data URLs. Save this file somewhere safe.'
        : `Media was too large (${formatBytes(totalMedia)}) to embed. Download individual files before they expire.`,
      chats: chats.map((chat) => ({
        id: chat.id,
        peer: chat.peerName || peerOf(chat),
        createdAt: new Date(chat.createdAt).toISOString(),
      })),
      messages: [],
    };

    for (const message of messages) {
      const entry = {
        id: message.id,
        chatId: message.chatId,
        from: message.senderId === identity() ? 'me' : (message.peerName || message.senderId),
        type: message.type,
        text: message.text,
        createdAt: new Date(message.createdAt).toISOString(),
        expiresAt: new Date(message.expiresAt).toISOString(),
        mediaName: message.mediaName || null,
      };
      if (message.mediaId && embedMedia) {
        const media = await db.get('media', message.mediaId);
        if (media) {
          entry.mediaData = await blobToDataUrl(media.blob);
        } else {
          entry.mediaNote = 'Media no longer available locally.';
        }
      }
      payload.messages.push(entry);
    }

    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `vanish-chat-${safeFilename(label)}-${new Date().toISOString().slice(0, 10)}.json`
    );
    toast('Export downloaded.', 'success');
  } catch (error) {
    toast(`Export failed: ${error.message}`, 'error');
  } finally {
    if (exportButton) exportButton.disabled = false;
  }
}

function exportCurrentChat() {
  if (!state.selectedChatId) return;
  const chat = state.chats.find((c) => c.id === state.selectedChatId);
  exportData([state.selectedChatId], chat?.peerName || 'chat');
}

/* ---------------- Settings modal ---------------- */

function openSettings() {
  const user = state.currentUser;
  const cfg = getCloudConfig();
  openModal(`
    <div class="modal-head"><h3>Settings</h3><button class="icon-btn" data-action="close-modal">✕</button></div>

    <div class="modal-section">
      <h4>Account</h4>
      <div class="kv"><span>Username</span><span>${escapeHtml(user.username)}</span></div>
      <div class="kv"><span>Member since</span><span>${new Date(user.createdAt).toLocaleDateString()}</span></div>
      <div class="kv"><span>Session</span><span>Until logout</span></div>
    </div>

    <div class="modal-section">
      <h4>Change password</h4>
      <label class="field"><span>Current password</span><input id="current-password" type="password" autocomplete="current-password"></label>
      <label class="field"><span>New password</span><input id="new-password" type="password" autocomplete="new-password"></label>
      <div class="modal-actions"><button class="btn small" data-action="change-password">Update password</button></div>
    </div>

    <div class="modal-section">
      <h4>Cloud connection</h4>
      <p>Leave blank for local-only mode. Cloud mode is required to message people on other devices. See the repository README and <code>supabase/schema.sql</code>.</p>
      <label class="field"><span>Project URL</span><input id="cloud-url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url)}"></label>
      <label class="field"><span>Anon / public key</span><input id="cloud-key" placeholder="eyJ..." value="${escapeHtml(cfg.anonKey)}"></label>
      <div class="modal-actions">
        <button class="btn small primary" data-action="save-cloud">Save &amp; reload</button>
        <button class="btn small ghost" data-action="disconnect-cloud">Disconnect</button>
      </div>
    </div>

    <div class="modal-section">
      <h4>Data &amp; retention</h4>
      <p class="warn">Every message and file is permanently deleted 24 hours after it is sent. Download anything you want to keep before it expires.</p>
      <div class="modal-actions">
        <button class="btn small" data-action="purge-now">Delete expired now</button>
        <button class="btn small" data-action="export-all">Export all my data</button>
        <button class="btn small danger" data-action="modal-logout">Log out</button>
      </div>
    </div>`);
}

async function changePassword() {
  const current = el('current-password')?.value || '';
  const next = el('new-password')?.value || '';
  if (next.length < 6) return toast('New password must be at least 6 characters.', 'error');
  const user = state.currentUser;
  if (!(await verifyPassword(current, user.salt, user.hash))) {
    return toast('Current password is incorrect.', 'error');
  }
  const { salt, hash } = await hashPassword(next);
  if (cloud.cloudEnabled() && user.cloudId) {
    try {
      await cloud.cloudUpdateProfileHash(user.cloudId, salt, hash);
    } catch (error) {
      return toast(`Cloud update failed: ${error.message}`, 'error');
    }
  }
  user.salt = salt;
  user.hash = hash;
  await db.put('accounts', user);
  el('current-password').value = '';
  el('new-password').value = '';
  toast('Password updated.', 'success');
}

/* ---------------- Events ---------------- */

function handleGlobalClick(event) {
  const download = event.target.closest('[data-download]');
  if (download) {
    downloadMessage(download.dataset.download);
    return;
  }

  const actionNode = event.target.closest('[data-action]');
  if (!actionNode) {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    return;
  }
  const action = actionNode.dataset.action;

  if (action === 'close-modal') {
    if (actionNode.classList.contains('modal-backdrop') && event.target !== actionNode) return;
    closeModal();
  } else if (action === 'remove-attachment') {
    clearPreview();
  } else if (action === 'new-chat-submit') {
    startChatWith(el('new-chat-username')?.value || '');
  } else if (action === 'save-cloud') {
    setCloudConfig({ url: el('cloud-url').value, anonKey: el('cloud-key').value });
    toast('Cloud settings saved. Reloading…', 'success');
    setTimeout(() => location.reload(), 600);
  } else if (action === 'disconnect-cloud') {
    clearCloudConfig();
    toast('Cloud disconnected. Reloading…');
    setTimeout(() => location.reload(), 600);
  } else if (action === 'change-password') {
    changePassword();
  } else if (action === 'purge-now') {
    purgeExpiredNow();
  } else if (action === 'export-all') {
    exportData(state.chats.map((chat) => chat.id), 'all');
  } else if (action === 'modal-logout') {
    logout();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.addEventListener('click', () => setAuthTab(button.dataset.authTab));
  });
  el('auth-form').addEventListener('submit', handleAuthSubmit);
  el('btn-new-chat').addEventListener('click', openNewChatModal);
  el('btn-settings').addEventListener('click', openSettings);
  el('btn-logout').addEventListener('click', logout);
  el('btn-back').addEventListener('click', () => {
    state.selectedChatId = null;
    renderAll();
  });
  el('btn-export').addEventListener('click', exportCurrentChat);
  el('btn-attach').addEventListener('click', () => el('file-input').click());
  el('file-input').addEventListener('change', handleFileSelected);
  el('composer').addEventListener('submit', handleSend);
  el('message-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el('composer').requestSubmit();
    }
  });
  el('chat-search').addEventListener('input', (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderChatList();
  });
  el('chat-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-chat-id]');
    if (!item) return;
    state.selectedChatId = item.dataset.chatId;
    renderAll();
  });
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

async function init() {
  cloud.refreshCloudConfig();
  await db.openDB();
  await db.purgeExpired();
  bindEvents();
  renderModePill();

  const restored = await restoreSession();
  if (restored) await enterApp();
  else el('auth-screen').classList.remove('hidden');

  setInterval(updateCountdowns, 1000);
  setInterval(purgeExpiredNow, 60000);
  setInterval(pollCloud, 5000);
}

init().catch((error) => {
  console.error(error);
  toast(`Failed to start: ${error.message}`, 'error');
});
