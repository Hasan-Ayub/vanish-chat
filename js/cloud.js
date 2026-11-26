/**
 * Supabase adapter: accounts, chats, messages and media all live on the server.
 *
 * The site stays zero-build; every call is plain fetch. RLS policies in
 * supabase/schema.sql keep reads/writes scoped to the signed-in user id, which
 * the app sends as x-vanish-user on each request.
 *
 * Large files are stored as numbered objects in the public `media` bucket and
 * reassembled on the recipient's device, so the relay's 500 MB behaviour is
 * preserved while the bytes themselves live on the server.
 */

import * as db from './db.js?v=13';
import { uuid } from './crypto.js?v=13';
import { getCloudConfig } from '../config.js?v=13';

const CHUNK_SIZE = 1024 * 1024;

let config = getCloudConfig();
let currentUserId = '';
let status = config.supabaseUrl && config.supabaseKey ? 'connecting' : 'offline';
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  notify();
}

export function refreshCloudConfig() {
  config = getCloudConfig();
  setStatus(cloudEnabled() ? 'connected' : 'offline');
}

export function setCloudUser(userId) {
  currentUserId = userId || '';
}

export function cloudEnabled() {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

export function getStatus() {
  return cloudEnabled() ? status : 'offline';
}

export function backendName() {
  return 'database';
}

export function setOnChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function request(path, options = {}) {
  if (!cloudEnabled()) throw new Error('Database is not configured');

  let response;
  try {
    response = await fetch(`${config.supabaseUrl}${path}`, {
      ...options,
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        'x-vanish-user': currentUserId,
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    setStatus('offline');
    throw new Error(`Could not reach the database: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (ignored) { data = text; }

  if (!response.ok) {
    setStatus('offline');
    const message = (data && (data.message || data.error || data.hint)) || `Request failed (${response.status})`;
    throw new Error(message);
  }

  setStatus('connected');
  return data;
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const first = (rows) => (Array.isArray(rows) ? rows[0] : rows);

function messageMedia(message) {
  if (!message) return [];
  if (Array.isArray(message.attachments) && message.attachments.length) return message.attachments;
  if (!message.mediaId) return [];
  return [{
    id: message.mediaId,
    path: message.mediaPath,
    chunks: message.mediaChunks,
    name: message.mediaName,
    mime: message.mediaMime,
    size: message.mediaSize,
    expiresAt: message.expiresAt,
  }];
}

/* ---------------- accounts ---------------- */

export async function cloudCreateProfile({ username, salt, hash }) {
  const id = uuid();
  const row = first(await request('/rest/v1/profiles', {
    method: 'POST',
    headers: Object.assign({}, jsonHeaders, { Prefer: 'return=representation' }),
    body: JSON.stringify({ id, username, salt, password_hash: hash }),
  }));
  return row || { id, username };
}

export async function cloudGetProfile(username) {
  const rows = await request(
    `/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=*&limit=1`
  );
  return first(rows) || { username, salt: null, password_hash: null };
}

export async function cloudGetProfileById(id) {
  const rows = await request(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  return first(rows) || null;
}

export async function cloudUpdateProfileHash(id, salt, hash) {
  return request(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ salt, password_hash: hash }),
  });
}

/* ---------------- chats ---------------- */

export async function cloudUpsertChat(chat) {
  if (!chat || !Array.isArray(chat.participants) || chat.participants.length !== 2) return null;
  const [user_1, user_2] = chat.participants;
  const row = first(await request('/rest/v1/chats', {
    method: 'POST',
    headers: Object.assign({}, jsonHeaders, { Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({
      id: chat.id,
      user_1,
      user_2,
      peer_name: chat.peerName || null,
      created_at: new Date(chat.createdAt || Date.now()).toISOString(),
      updated_at: new Date(chat.updatedAt || Date.now()).toISOString(),
    }),
  }));
  return row || null;
}

export async function cloudFetchChats() {
  if (!currentUserId) return [];
  const filter = `or=(user_1.eq.${encodeURIComponent(currentUserId)},user_2.eq.${encodeURIComponent(currentUserId)})`;
  const rows = await request(`/rest/v1/chats?${filter}&select=*&limit=1000`);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id,
    participants: [row.user_1, row.user_2],
    peerName: row.peer_name || '',
    createdAt: Date.parse(row.created_at) || Date.now(),
    updatedAt: Date.parse(row.updated_at) || Date.now(),
  }));
}

/* ---------------- messages ---------------- */

export async function cloudFetchMessages() {
  if (!currentUserId) return [];
  const filter = `or=(sender_id.eq.${encodeURIComponent(currentUserId)},recipient_id.eq.${encodeURIComponent(currentUserId)})`;
  const rows = await request(`/rest/v1/messages?${filter}&select=*&order=created_at.asc&limit=1000`);
  return Array.isArray(rows) ? rows : [];
}

export async function cloudInsertMessage(message) {
  await cloudUpsertChat({
    id: message.chatId,
    participants: [message.senderId, message.recipientId],
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  });

  const row = first(await request('/rest/v1/messages', {
    method: 'POST',
    headers: Object.assign({}, jsonHeaders, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      id: message.id,
      chat_id: message.chatId,
      sender_id: message.senderId,
      recipient_id: message.recipientId,
      kind: message.type,
      body: message.text || null,
      media_id: message.mediaId || null,
      media_path: message.mediaPath || null,
      media_chunks: message.mediaChunks || 0,
      media_name: message.mediaName || null,
      media_mime: message.mediaMime || null,
      media_size: message.mediaSize || null,
      sender_name: message.senderName || null,
      attachments: JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
      created_at: new Date(message.createdAt).toISOString(),
      expires_at: new Date(message.expiresAt).toISOString(),
    }),
  }));
  return row || message;
}

export async function cloudDeleteMessage(message) {
  if (!message || !message.id) return;
  for (const attachment of messageMedia(message)) {
    if (attachment.path && String(attachment.path).indexOf('supabase:') === 0) {
      await cloudDeleteMedia(attachment);
    }
  }
  try {
    await request(`/rest/v1/messages?id=eq.${encodeURIComponent(message.id)}`, { method: 'DELETE' });
  } catch (ignored) {
    // Already removed by the 24h cleanup or another device.
  }
}

/* ---------------- media ---------------- */

function mediaParts(message) {
  const path = message ? (message.path || message.mediaPath) : '';
  const parts = String(path || '').split(':');
  if (parts[0] !== 'supabase' || parts.length < 4) return null;
  const total = Number(parts[parts.length - 1]);
  return { owner: parts[1], id: parts[2], total: Number.isFinite(total) && total > 0 ? total : 0 };
}

export async function cloudUploadMedia(id, blob, name, mime, recipientId, onProgress) {
  if (!cloudEnabled()) throw new Error('Database is not configured');
  const owner = currentUserId || recipientId;
  if (!owner) throw new Error('Sign in before uploading media.');

  const total = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
  for (let part = 0; part < total; part++) {
    const slice = blob.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE);
    await request(`/storage/v1/object/media/${owner}/${id}/${part}`, {
      method: 'POST',
      headers: {
        'Content-Type': mime || blob.type || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: slice,
    });
    if (onProgress) onProgress(part + 1, total);
  }
  return `supabase:${owner}:${id}:${total}`;
}

export async function cloudFetchMedia(attachment) {
  if (!cloudEnabled()) return false;
  const info = mediaParts(attachment);
  if (!info || !info.total) return false;
  const mediaId = attachment.id || attachment.mediaId;
  if (!mediaId) return false;

  const chunks = [];
  for (let part = 0; part < info.total; part++) {
    const url = `${config.supabaseUrl}/storage/v1/object/public/media/${info.owner}/${info.id}/${part}`;
    const response = await fetch(url);
    if (!response.ok) return false;
    chunks.push(await response.blob());
  }

  const mime = attachment.mime || attachment.mediaMime || 'application/octet-stream';
  const blob = new Blob(chunks, { type: mime });
  await db.put('media', {
    id: mediaId,
    blob,
    name: attachment.name || attachment.mediaName || 'media',
    mime,
    size: blob.size,
    createdAt: attachment.createdAt || Date.now(),
    expiresAt: attachment.expiresAt || Date.now() + 86400000,
  });
  notify();
  return true;
}

export async function cloudDeleteMedia(message) {
  const info = mediaParts(message);
  if (!info || !info.total || !cloudEnabled()) return;
  for (let part = 0; part < info.total; part++) {
    try {
      await request(`/storage/v1/object/media/${info.owner}/${info.id}/${part}`, { method: 'DELETE' });
    } catch (ignored) {
      // Object may already be gone; ignore.
    }
  }
}

export function cloudMediaUrl(path) {
  if (!cloudEnabled() || !path) return '';
  return `${config.supabaseUrl}/storage/v1/object/public/media/${path}`;
}

export async function userIdForUsername(username) {
  const profile = await cloudGetProfile(username);
  return profile.id || '';
}
