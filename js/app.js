import * as db from './db.js?v=13';
import { uuid, hashPassword, verifyPassword, randomToken } from './crypto.js?v=13';
import * as cloud from './backend.js?v=13';
import { BROKERS, getCloudConfig, setCloudConfig, clearCloudConfig } from '../config.js?v=13';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
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
  attachments: [],
  mediaUrls: new Map(),
  polling: false,
  purging: false,
};

let messageSignature = '';

const el = (id) => document.getElementById(id);
const mobileLayout = () => window.matchMedia('(max-width: 800px)').matches;

function selectChat(id) {
  if (state.selectedChatId === id) return;
  state.selectedChatId = id;
  if (id && mobileLayout()) {
    history.pushState({ vanishChat: id }, '', location.href);
  }
}

function goBackFromChat() {
  state.selectedChatId = null;
  const historyState = history.state;
  if (mobileLayout() && historyState && historyState.vanishChat) {
    history.back();
  } else {
    renderAll();
  }
}

function syncViewportHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const keyboardOpen = viewport.height < window.innerHeight - 120;
  document.documentElement.style.setProperty(
    '--app-height',
    keyboardOpen ? `${Math.round(viewport.height)}px` : ''
  );
  if (keyboardOpen) requestAnimationFrame(scrollToBottom);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
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

function isPlaceholderName(name, id) {
  return !name || name === `User ${String(id || '').slice(0, 6)}`;
}

function rememberPeerName(chat, name) {
  if (!chat || isPlaceholderName(name, peerOf(chat))) return false;
  if (chat.peerName === name) return false;
  chat.peerName = name;
  return true;
}

function displayPeerName(chat) {
  const peerId = peerOf(chat);
  if (!isPlaceholderName(chat.peerName, peerId)) return chat.peerName;
  const local = state.accounts.find((account) => account.id === peerId || account.cloudId === peerId);
  return local && local.username ? local.username : (chat.peerName || `User ${peerId.slice(0, 6)}`);
}

function normalizeAttachment(item, message) {
  const data = item || {};
  const id = data.id || data.media_id;
  if (!id) return null;
  const mime = data.mime || data.media_mime || 'application/octet-stream';
  return {
    id,
    path: data.path || data.media_path || null,
    chunks: Number(data.chunks || data.media_chunks) || 0,
    name: data.name || data.media_name || 'media',
    mime,
    size: Number(data.size || data.media_size) || 0,
    type: data.type || (String(mime).indexOf('video/') === 0 ? 'video' : 'image'),
    createdAt: data.createdAt || (message && message.createdAt) || Date.now(),
    expiresAt: data.expiresAt || (message && message.expiresAt) || Date.now() + RETENTION_MS,
  };
}

function messageMedia(message) {
  if (!message) return [];
  if (Array.isArray(message.attachments) && message.attachments.length) {
    return message.attachments.map((item) => normalizeAttachment(item, message)).filter(Boolean);
  }
  if (!message.mediaId) return [];
  return [normalizeAttachment({
    id: message.mediaId,
    path: message.mediaPath,
    chunks: message.mediaChunks,
    name: message.mediaName,
    mime: message.mediaMime,
    size: message.mediaSize,
  }, message)].filter(Boolean);
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
      if (profile && profile.password_hash) {
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
    } catch (ignored) { /* fall through */ }
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
    } catch (ignored) { /* keep local identity */ }
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
        const profile = await cloud.cloudCreateProfile({ username, salt, hash });
        cloudId = profile.id || id;
      }
      await db.put('accounts', { id, cloudId, username, salt, hash, createdAt: Date.now() });
      await signIn(id);
    } else {
      let account = await findAccountByUsername(username);
      if (cloud.cloudEnabled()) {
        const profile = await cloud.cloudGetProfile(username);
        if (profile && profile.password_hash) {
          if (!account) {
            account = {
              id: profile.id,
              cloudId: profile.id,
              username: profile.username,
              salt: profile.salt,
              hash: profile.password_hash,
              createdAt: Date.parse(profile.created_at) || Date.now(),
            };
            await db.put('accounts', account);
          } else if (account.hash !== profile.password_hash) {
            account.hash = profile.password_hash;
            account.salt = profile.salt;
            if (!account.cloudId) account.cloudId = profile.id;
            await db.put('accounts', account);
          }
        }
      }
      const valid = account && (await verifyPassword(password, account.salt, account.hash));
      if (!valid) throw new Error('Invalid username or password.');
      if (cloud.cloudEnabled() && account) cloud.setCloudUser(account.cloudId || account.id);
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
  window.__vanishAuthTab = tab;
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    const selected = button.dataset.authTab === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
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
  clearAttachments();
  revokeMediaUrls();
  closeModal();
  history.replaceState(null, '', location.href);
  const shell = document.querySelector('.app-shell');
  if (shell) shell.classList.remove('chat-open');
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

function relayLabel() {
  const status = cloud.getStatus();
  const name = cloud.backendName() === 'database' ? 'Database' : 'Relay';
  if (status === 'connected') return `${name} connected`;
  if (status === 'connecting') return `${name} connecting…`;
  return `${name} offline`;
}

function renderModePill() {
  const pill = el('mode-pill');
  const status = cloud.getStatus();
  const database = cloud.backendName() === 'database';
  pill.textContent = status === 'connected'
    ? (database ? 'Cloud database' : 'Zero-setup relay')
    : `${database ? 'Database' : 'Relay'} ${status}`;
  pill.classList.toggle('cloud', status === 'connected');
}

function renderHeader() {
  const user = state.currentUser;
  if (!user) return;
  el('me-name').textContent = user.username;
  decorateAvatar(el('me-avatar'), user.username);
  el('me-status').textContent = relayLabel();
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
    !state.search || displayPeerName(chat).toLowerCase().includes(state.search)
  );

  if (!chats.length) {
    list.innerHTML = `<div class="chat-empty">${state.search
      ? 'No matching chats.'
      : 'No chats yet. Tap “New chat” to find someone by username.'}</div>`;
    return;
  }

  list.innerHTML = chats.map((chat) => {
    const peerName = displayPeerName(chat);
    const chatMessages = state.messages.filter((m) => m.chatId === chat.id);
    const last = chatMessages[chatMessages.length - 1];
    let preview = 'No messages yet';
    if (last) {
      const attachments = messageMedia(last);
      const photos = attachments.filter((a) => a.type !== 'video').length;
      const videos = attachments.length - photos;
      const parts = [];
      if (photos) parts.push(`📷 ${photos} photo${photos === 1 ? '' : 's'}`);
      if (videos) parts.push(`🎬 ${videos} video${videos === 1 ? '' : 's'}`);
      if (parts.length) preview = parts.join(', ');
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
    if (panel) panel.classList.remove('chat-open');
    return;
  }

  el('chat-head').classList.remove('hidden');
  el('composer').classList.remove('hidden');
  el('messages').classList.remove('hidden');
  el('empty-state').classList.add('hidden');
  if (panel) panel.classList.add('chat-open');

  const peerName = displayPeerName(chat);
  el('peer-name').textContent = peerName;
  decorateAvatar(el('peer-avatar'), peerName);

  const messages = state.messages.filter((m) => m.chatId === chat.id);
  const signature = [identity(), ...messages.map((m) => [m.id, messageMedia(m).map((a) => a.id).join(',')].join(':'))].join('|');
  if (signature === messageSignature) {
    updateCountdowns();
    return;
  }
  messageSignature = signature;
  revokeMediaUrls();

  const rows = await Promise.all(messages.map(async (message) => {
    const mine = message.senderId === identity();
    const attachments = messageMedia(message);
    let mediaHtml = '';
    for (const attachment of attachments) {
      const media = await db.get('media', attachment.id);
      if (media) {
        const url = URL.createObjectURL(media.blob);
        state.mediaUrls.set(attachment.id, url);
        const tag = attachment.type === 'video'
          ? `<video src="${url}" controls playsinline></video>`
          : `<img src="${url}" alt="${escapeHtml(attachment.name)}">`;
        mediaHtml += `<div class="bubble-media"><div class="bubble-media-item">${tag}<button class="download-btn" data-download="${escapeHtml(message.id)}" data-media-id="${escapeHtml(attachment.id)}">Download</button></div></div>`;
      } else {
        mediaHtml += `<div class="media-missing">${escapeHtml(attachment.name)} — media expired or unavailable</div>`;
      }
    }
    return `
      <div class="msg-row ${mine ? 'out' : ''}">
        <div class="bubble">
          ${mediaHtml}
          ${message.text ? `<div class="bubble-text">${escapeHtml(message.text)}</div>` : ''}
          <div class="bubble-foot">
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
}

function openNewChatModal() {
  const example = 'Enter any username. Messages are delivered through the public relay even if that person is offline — they have 24 hours to open the app and download files.';
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
  setTimeout(() => {
    const input = el('new-chat-username');
    if (input) input.focus();
  }, 50);
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
    if (cloud.getStatus() !== 'connected') {
      return toast('Relay is offline. Wait a moment and try again.', 'error');
    }
    const profile = await cloud.cloudGetProfile(username);
    if (!profile) return toast('Could not resolve that username.', 'error');
    peerId = profile.id;
    peerName = profile.username;
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
  if (cloud.cloudEnabled()) {
    try {
      await cloud.cloudUpsertChat(chat);
    } catch (error) {
      toast(`Chat could not be saved to the server: ${error.message}`, 'error');
    }
  }
  selectChat(id);
  closeModal();
  await loadData();
  renderAll();
}

function clearAttachments() {
  for (const item of state.attachments) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
  state.attachments = [];
  const preview = el('attachment-preview');
  if (preview) {
    preview.innerHTML = '';
    preview.classList.add('hidden');
  }
  const progress = el('upload-progress');
  if (progress) {
    progress.classList.add('hidden');
    el('upload-bar').style.width = '0%';
    el('upload-label').textContent = '';
  }
}

function renderAttachmentPreview() {
  const preview = el('attachment-preview');
  if (!preview) return;
  if (!state.attachments.length) {
    preview.innerHTML = '';
    preview.classList.add('hidden');
    return;
  }
  preview.innerHTML = state.attachments.map((item, index) => {
    const tag = item.type === 'video'
      ? `<video src="${item.url}" controls muted playsinline></video>`
      : `<img src="${item.url}" alt="${escapeHtml(item.name)}">`;
    return `<div class="attachment-thumb">${tag}<button type="button" class="remove-attachment" data-action="remove-attachment" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">×</button></div>`;
  }).join('');
  preview.classList.remove('hidden');
}

function handleFileSelected(event) {
  const picked = event.target.files;
  const files = [];
  for (let i = 0; i < (picked ? picked.length : 0); i++) files.push(picked[i]);
  event.target.value = '';
  if (!files.length) return;

  let large = false;
  let rejected = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      rejected++;
      continue;
    }
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      rejected++;
      continue;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      rejected++;
      continue;
    }
    if (file.size > 100 * 1024 * 1024) large = true;
    state.attachments.push({
      id: uuid(),
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      mime: file.type,
      size: file.size,
      type: file.type.startsWith('video/') ? 'video' : 'image',
    });
  }
  if (rejected) {
    toast(`${rejected} file${rejected === 1 ? '' : 's'} skipped. Use images/videos under ${formatBytes(MAX_MEDIA_BYTES)} (max ${MAX_ATTACHMENTS}).`, 'error');
  }
  if (large) {
    toast('Large files selected — sending may take a few minutes. Keep this tab open.', 'info');
  }
  renderAttachmentPreview();
}

async function cleanupFailedSend(items, uploaded) {
  for (const item of items) {
    try { await db.del('media', item.id); } catch (ignored) { /* nothing stored */ }
  }
  for (const attachment of uploaded) {
    try { await cloud.cloudDeleteMedia(attachment); } catch (ignored) { /* best effort */ }
  }
}

async function handleSend(event) {
  event.preventDefault();
  if (!state.selectedChatId) return;
  const text = el('message-input').value.trim();
  const files = state.attachments.slice();
  if (!text && !files.length) return;

  const button = el('btn-send');
  button.disabled = true;
  const uploaded = [];
  try {
    const chat = state.chats.find((c) => c.id === state.selectedChatId);
    if (!chat) throw new Error('Chat not found.');

    const now = Date.now();
    const expiresAt = now + RETENTION_MS;
    const attachments = files.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      mime: item.mime,
      size: item.size,
      path: null,
      chunks: 0,
    }));
    const first = attachments[0] || null;
    const message = {
      id: uuid(),
      chatId: chat.id,
      senderId: identity(),
      recipientId: peerOf(chat),
      type: first ? first.type : 'text',
      text,
      attachments,
      mediaId: first ? first.id : null,
      mediaPath: null,
      mediaName: first ? first.name : null,
      mediaMime: first ? first.mime : null,
      mediaSize: first ? first.size : null,
      mediaChunks: 0,
      senderName: state.currentUser ? state.currentUser.username : '',
      createdAt: now,
      expiresAt,
      remote: false,
    };

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      await db.put('media', {
        id: item.id,
        blob: item.file,
        name: item.name,
        mime: item.mime,
        size: item.size,
        createdAt: now,
        expiresAt,
      });
    }

    if (cloud.cloudEnabled() && attachments.length) {
      const progress = el('upload-progress');
      if (progress) progress.classList.remove('hidden');
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        const attachment = attachments[i];
        try {
          attachment.path = await cloud.cloudUploadMedia(
            attachment.id,
            item.file,
            item.name,
            item.mime,
            message.recipientId,
            (part, total) => {
              if (!el('upload-bar')) return;
              const filePercent = part / total;
              const percent = Math.round(((i + filePercent) / files.length) * 100);
              el('upload-bar').style.width = `${percent}%`;
              el('upload-label').textContent = `Uploading ${i + 1}/${files.length}: ${item.name} — ${Math.round(filePercent * 100)}%`;
            }
          );
          const parts = attachment.path.split(':');
          attachment.chunks = Number(parts[parts.length - 1]) || 1;
          uploaded.push(attachment);
          if (i === 0) {
            message.mediaPath = attachment.path;
            message.mediaChunks = attachment.chunks;
          }
        } catch (error) {
          throw new Error(`Upload failed for ${item.name}: ${error.message}`);
        }
      }
    }

    if (cloud.cloudEnabled()) {
      await cloud.cloudInsertMessage(message);
      message.remote = true;
    }
    await db.put('messages', message);
    await db.put('chats', Object.assign({}, chat, { updatedAt: now }));

    el('message-input').value = '';
    clearAttachments();
    await loadData();
    renderAll();
    renderStorageInfo();
  } catch (error) {
    await cleanupFailedSend(files, uploaded);
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
          await cloud.cloudDeleteMessage(message);
        } catch (ignored) { /* relay row may already be gone */ }
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
    const [rows, serverChats] = await Promise.all([
      cloud.cloudFetchMessages(me),
      cloud.cloudFetchChats(me),
    ]);
    let changed = false;

    for (const server of serverChats) {
      const local = await db.get('chats', server.id);
      const peerId = server.participants.find((id) => id !== me) || '';
      if (local && local.updatedAt >= server.updatedAt && !isPlaceholderName(local.peerName, peerId)) continue;
      let peerName = server.peerName || '';
      if (isPlaceholderName(peerName, peerId)) peerName = await resolvePeerName(peerId);
      const merged = Object.assign({}, server, { peerName });
      if (!local || !local.peerName || isPlaceholderName(local.peerName, peerId)) {
        merged.peerName = peerName;
      } else {
        merged.peerName = local.peerName;
      }
      await db.put('chats', merged);
      changed = true;
    }

    for (const row of rows) {
      if (row.__deleted) {
        const local = await db.get('messages', row.id);
        if (local) {
          for (const attachment of messageMedia(local)) {
            const remaining = await db.getByIndex('chunks', 'by-media', attachment.id);
            for (const chunk of remaining) await db.del('chunks', chunk.id);
            await db.del('media', attachment.id);
          }
          await db.del('messages', local.id);
          changed = true;
        }
        continue;
      }

      const peerId = row.sender_id === me ? row.recipient_id : row.sender_id;
      let chat = await db.get('chats', row.chat_id);
      const incomingName = peerId === row.sender_id ? row.sender_name : null;
      let peerName = incomingName || (chat && !isPlaceholderName(chat.peerName, peerId) ? chat.peerName : '');
      if (isPlaceholderName(peerName, peerId)) peerName = await resolvePeerName(peerId);
      if (!chat) {
        chat = {
          id: row.chat_id,
          participants: [me, peerId],
          peerName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.put('chats', chat);
        changed = true;
      } else if (rememberPeerName(chat, peerName)) {
        await db.put('chats', chat);
        changed = true;
      }

      if (await db.get('messages', row.id)) continue;

      let rawAttachments = row.attachments;
      if (typeof rawAttachments === 'string') {
        try { rawAttachments = JSON.parse(rawAttachments); } catch (ignored) { rawAttachments = []; }
      }
      const attachments = Array.isArray(rawAttachments)
        ? rawAttachments.map((item) => normalizeAttachment(item, row)).filter(Boolean)
        : [];
      const first = attachments[0] || null;
      const message = {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
        type: row.kind || 'text',
        text: row.body || '',
        attachments,
        mediaId: row.media_id || (first ? first.id : null),
        mediaPath: row.media_path || (first ? first.path : null),
        mediaChunks: row.media_chunks || (first ? first.chunks : 0),
        mediaName: row.media_name || (first ? first.name : null),
        mediaMime: row.media_mime || (first ? first.mime : null),
        mediaSize: row.media_size || (first ? first.size : null),
        senderName: row.sender_name || '',
        createdAt: Date.parse(row.created_at) || Date.now(),
        expiresAt: Date.parse(row.expires_at) || Date.now() + RETENTION_MS,
        remote: true,
      };
      await db.put('messages', message);
      changed = true;
    }

    // Chunks can arrive after the message; retry assembly every poll.
    const locals = await db.getAll('messages');
    for (const message of locals) {
      for (const attachment of messageMedia(message)) {
        if (!(await db.get('media', attachment.id))) {
          await fetchCloudMedia(message, attachment);
        }
      }
    }

    if (changed) {
      forceMessageRender();
      await loadData();
      renderAll();
    }
  } catch (error) {
    console.warn('Server sync failed', error);
  } finally {
    state.polling = false;
  }
}

async function fetchCloudMedia(message, attachment) {
  try {
    const done = await cloud.cloudFetchMedia(attachment || messageMedia(message)[0] || message);
    if (done) {
      forceMessageRender();
      renderChat();
    }
  } catch (error) {
    console.warn('Could not assemble media', error);
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

async function downloadMessage(id, mediaId) {
  const message = state.messages.find((m) => m.id === id);
  if (!message) return;
  const attachments = messageMedia(message);
  if (attachments.length) {
    const chosen = mediaId ? attachments.find((a) => a.id === mediaId) : attachments[0];
    if (!chosen) return;
    let media = await db.get('media', chosen.id);
    if (!media && chosen.path && cloud.cloudEnabled()) {
      await fetchCloudMedia(message, chosen);
      media = await db.get('media', chosen.id);
    }
    if (media) return downloadBlob(media.blob, media.name || chosen.name || 'media');
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
    const totalMedia = messages.reduce((sum, message) =>
      sum + messageMedia(message).reduce((partSum, attachment) => partSum + (attachment.size || 0), 0), 0);
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
        peer: displayPeerName(chat),
        createdAt: new Date(chat.createdAt).toISOString(),
      })),
      messages: [],
    };

    for (const message of messages) {
      const chat = chats.find((c) => c.id === message.chatId);
      const entry = {
        id: message.id,
        chatId: message.chatId,
        from: message.senderId === identity()
          ? 'me'
          : (chat ? displayPeerName(chat) : (message.senderName || message.senderId)),
        type: message.type,
        text: message.text,
        createdAt: new Date(message.createdAt).toISOString(),
        expiresAt: new Date(message.expiresAt).toISOString(),
        attachments: [],
        mediaName: message.mediaName || null,
      };
      for (const attachment of messageMedia(message)) {
        const item = {
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
        };
        if (embedMedia) {
          const media = await db.get('media', attachment.id);
          if (media) {
            item.data = await blobToDataUrl(media.blob);
          } else {
            item.note = 'Media no longer available locally.';
          }
        }
        entry.attachments.push(item);
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
  exportData([state.selectedChatId], chat ? displayPeerName(chat) : 'chat');
}

/* ---------------- Settings modal ---------------- */

function openSettings() {
  const user = state.currentUser;
  const cfg = getCloudConfig();
  const brokerOptions = BROKERS.map((broker) =>
    `<option value="${escapeHtml(broker.url)}" ${broker.url === cfg.broker ? 'selected' : ''}>${escapeHtml(broker.label)}</option>`
  ).join('');
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
      <h4>Server database</h4>
      <p>Status: <strong>${escapeHtml(relayLabel())}</strong>. With Supabase configured, accounts, chats, messages and media are stored on the server and sync to every device. Leave blank to use the public relay fallback.</p>
      <label class="field"><span>Supabase project URL</span>
        <input id="supabase-url" type="url" spellcheck="false" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.supabaseUrl)}">
      </label>
      <label class="field"><span>Anon/public key</span>
        <input id="supabase-key" type="text" spellcheck="false" placeholder="eyJ..." value="${escapeHtml(cfg.supabaseKey)}">
      </label>
      <p class="warn">For all devices to use the same database, put these values in <code>config.js</code> before publishing. Values saved here only affect this browser.</p>
      <div class="modal-actions">
        <button class="btn small primary" data-action="save-cloud">Save connection</button>
      </div>
    </div>

    <div class="modal-section">
      <h4>Relay fallback</h4>
      <p>No account or API key is needed — messages travel through a public MQTT relay and expire there after 24 hours. Avoid sharing sensitive information.</p>
      <label class="field"><span>Broker</span>
        <select id="cloud-broker" class="field-select">${brokerOptions}</select>
      </label>
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
  const currentInput = el('current-password');
  const nextInput = el('new-password');
  const current = currentInput ? currentInput.value : '';
  const next = nextInput ? nextInput.value : '';
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
    downloadMessage(download.dataset.download, download.dataset.mediaId);
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
    const index = Number(actionNode.dataset.index);
    const item = state.attachments[index];
    if (item && item.url) URL.revokeObjectURL(item.url);
    state.attachments.splice(index, 1);
    renderAttachmentPreview();
  } else if (action === 'new-chat-submit') {
    const newChatInput = el('new-chat-username');
    startChatWith(newChatInput ? newChatInput.value : '');
  } else if (action === 'save-cloud') {
    setCloudConfig({
      broker: el('cloud-broker').value,
      supabaseUrl: el('supabase-url').value,
      supabaseKey: el('supabase-key').value,
    });
    cloud.refreshCloudConfig();
    renderModePill();
    renderHeader();
    toast('Connection saved. Reloading…', 'success');
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
  // The inline script in index.html owns both auth controls so a slow or
  // blocked module can never cause a native form reload. It calls back here.
  window.vanishChatAuthTabChanged = (tab) => {
    state.authTab = tab;
  };
  state.authTab = window.__vanishAuthTab === 'register' ? 'register' : 'login';
  window.vanishChatAuthSubmit = handleAuthSubmit;
  if (typeof window.vanishChatFlushAuth === 'function') window.vanishChatFlushAuth();
  el('btn-new-chat').addEventListener('click', openNewChatModal);
  el('btn-settings').addEventListener('click', openSettings);
  el('btn-chat-settings').addEventListener('click', openSettings);
  el('btn-logout').addEventListener('click', logout);
  el('btn-back').addEventListener('click', goBackFromChat);
  el('btn-export').addEventListener('click', exportCurrentChat);
  el('btn-attach').addEventListener('click', () => el('file-input').click());
  el('file-input').addEventListener('change', handleFileSelected);
  el('composer').addEventListener('submit', handleSend);
  el('message-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    // On phones/tablets the iOS Return key should add a newline, not send.
    // The dedicated Send button is the reliable touch target.
    if (mobileLayout()) return;
    event.preventDefault();
    el('composer').requestSubmit();
  });
  el('chat-search').addEventListener('input', (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderChatList();
  });
  el('chat-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-chat-id]');
    if (!item) return;
    selectChat(item.dataset.chatId);
    renderAll();
  });
  window.addEventListener('popstate', (event) => {
    const eventState = event.state;
    const id = eventState ? eventState.vanishChat : null;
    state.selectedChatId = state.chats.some((chat) => chat.id === id) ? id : null;
    renderAll();
  });
  window.addEventListener('resize', syncViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

async function init() {
  cloud.refreshCloudConfig();

  // Bind UI handlers first. If IndexedDB is blocked (iOS private browsing,
  // low storage, failed upgrade), buttons must still respond so the user can
  // switch tabs and see a clear error instead of a frozen screen.
  bindEvents();
  setAuthTab(window.__vanishAuthTab === 'register' ? 'register' : 'login');
  syncViewportHeight();
  renderModePill();
  cloud.setOnChange(() => {
    renderModePill();
    if (state.currentUser) renderHeader();
  });

  try {
    await db.openDB();
    await db.purgeExpired();
    const restored = await restoreSession();
    if (restored) await enterApp();
    else el('auth-screen').classList.remove('hidden');
  } catch (error) {
    console.error(error);
    toast(`Local storage unavailable: ${error.message}`, 'error');
    el('auth-screen').classList.remove('hidden');
  }

  setInterval(updateCountdowns, 1000);
  setInterval(purgeExpiredNow, 60000);
  setInterval(pollCloud, 5000);
}

init().catch((error) => {
  console.error(error);
  toast(`Failed to start: ${error.message}`, 'error');
});
