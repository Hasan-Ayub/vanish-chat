/**
 * Optional Supabase adapter. Everything is plain fetch so the site stays a
 * zero-build static app on GitHub Pages. When no config is present the app
 * simply runs in local-only mode and none of these calls are made.
 */

import { getCloudConfig } from '../config.js';

let config = getCloudConfig();
let currentUserId = '';

export function refreshCloudConfig() {
  config = getCloudConfig();
}

export function setCloudUser(userId) {
  currentUserId = userId || '';
}

export function cloudEnabled() {
  return Boolean(config.url && config.anonKey);
}

function headers(extra = {}) {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    'x-vanish-user': currentUserId,
    ...extra,
  };
}

async function request(path, options = {}) {
  if (!cloudEnabled()) throw new Error('Cloud is not configured');
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = (data && (data.message || data.error || data.hint)) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function cloudCreateProfile({ id, username, salt, hash }) {
  const rows = await request('/rest/v1/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ id, username, salt, password_hash: hash }),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function cloudGetProfile(username) {
  const rows = await request(
    `/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=*&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

export async function cloudGetProfileById(id) {
  const rows = await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

export async function cloudUpdateProfileHash(id, salt, hash) {
  return request(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, password_hash: hash }),
  });
}

export async function cloudFetchMessages(userId, since) {
  const filter = `or=(sender_id.eq.${userId},recipient_id.eq.${userId})`;
  let path = `/rest/v1/messages?${encodeURIComponent(filter).replace('%28', '(').replace('%29', ')')}`;
  path += '&select=*&order=created_at.asc&limit=500';
  if (since) path += `&created_at=gt.${encodeURIComponent(since)}`;
  const rows = await request(path);
  return Array.isArray(rows) ? rows : [];
}

export async function cloudInsertMessage(message) {
  const rows = await request('/rest/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      id: message.id,
      chat_id: message.chatId,
      sender_id: message.senderId,
      recipient_id: message.recipientId,
      kind: message.type,
      body: message.text || null,
      media_path: message.mediaPath || null,
      media_name: message.mediaName || null,
      media_mime: message.mediaMime || null,
      media_size: message.mediaSize || null,
      created_at: new Date(message.createdAt).toISOString(),
      expires_at: new Date(message.expiresAt).toISOString(),
    }),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function cloudDeleteMessage(id) {
  return request(`/rest/v1/messages?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function cloudUploadMedia(id, blob, name, mime) {
  const path = `${currentUserId}/${id}`;
  await request(`/storage/v1/object/media/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': mime || blob.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: blob,
  });
  return path;
}

export async function cloudDeleteMedia(path) {
  if (!path) return;
  try {
    await request(`/storage/v1/object/media/${path}`, { method: 'DELETE' });
  } catch {
    // Object may already be gone; ignore.
  }
}

export function cloudMediaUrl(path) {
  if (!cloudEnabled() || !path) return '';
  return `${config.url}/storage/v1/object/public/media/${path}`;
}
