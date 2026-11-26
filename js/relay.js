/**
 * Zero-setup messaging relay: a minimal MQTT 5 (with MQTT 3.1.1 fallback)
 * client over WebSocket using a public anonymous broker.
 *
 * Messages are retained per-message topics with a 24-hour Message Expiry
 * Interval, so offline delivery works and the broker drops old data itself.
 * Large files are published as base64 chunks and reassembled by the recipient.
 */

import * as db from './db.js?v=2';
import { fromBase64 } from './crypto.js?v=2';
import { getCloudConfig } from '../config.js?v=2';

const ROOT = 'vanish-chat/v2';
const KEEPALIVE = 60;
const EXPIRY_SECONDS = 24 * 60 * 60;
const CHUNK_SIZE = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let socket = null;
let connected = false;
let protocolVersion = 5;
let currentUserId = '';
let nextPacketId = 1;
let pending = new Map();
let queue = [];
let profiles = new Map();
let inbound = new Uint8Array(0);
let reconnectTimer = null;
let pingTimer = null;
let subscribedFor = '';
let brokerUrl = getCloudConfig().broker;
const listeners = new Set();

/* ---------------- binary helpers ---------------- */

function concat(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function encodeString(value) {
  const bytes = encoder.encode(String(value));
  return concat(new Uint8Array([(bytes.length >> 8) & 0xff, bytes.length & 0xff]), bytes);
}

function encodeVarint(value) {
  const bytes = [];
  let number = value;
  do {
    let digit = number % 128;
    number = Math.floor(number / 128);
    if (number > 0) digit |= 0x80;
    bytes.push(digit);
  } while (number > 0);
  return new Uint8Array(bytes);
}

function decodeVarint(bytes, offset) {
  let value = 0;
  let multiplier = 1;
  let position = offset;
  let digit;
  do {
    if (position >= bytes.length) throw new Error('Incomplete MQTT packet');
    digit = bytes[position++];
    value += (digit & 127) * multiplier;
    multiplier *= 128;
  } while ((digit & 128) !== 0);
  return { value, length: position - offset };
}

function u16(value) {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function packetId() {
  nextPacketId = nextPacketId === 65535 ? 1 : nextPacketId + 1;
  return nextPacketId;
}

function sendPacket(firstByte, body) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(concat(new Uint8Array([firstByte]), encodeVarint(body.length), body));
}

function notify() {
  for (const listener of listeners) listener();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ---------------- connection ---------------- */

export function cloudEnabled() {
  return true;
}

export function getStatus() {
  return connected ? 'connected' : (socket ? 'connecting' : 'offline');
}

export function refreshCloudConfig() {
  const next = getCloudConfig().broker;
  if (next !== brokerUrl) {
    brokerUrl = next;
    disconnect();
    connect();
  }
}

export function setOnChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCloudUser(userId) {
  if (!userId || userId === currentUserId) return;
  currentUserId = userId;
  subscribedFor = '';
  if (connected) subscribe();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (connected) sendPacket(0xc0, new Uint8Array(0));
  }, 45000);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(brokerUrl, 'mqtt');
  } catch {
    scheduleReconnect();
    return;
  }
  socket.binaryType = 'arraybuffer';
  socket.onopen = sendConnect;
  socket.onmessage = (event) => ingest(new Uint8Array(event.data));
  socket.onclose = () => {
    connected = false;
    subscribedFor = '';
    for (const { reject } of pending.values()) reject(new Error('Relay disconnected'));
    pending = new Map();
    clearInterval(pingTimer);
    notify();
    scheduleReconnect();
  };
  socket.onerror = () => { /* onclose handles retry */ };
  notify();
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
  connected = false;
  subscribedFor = '';
  notify();
}

function sendConnect() {
  const clientId = `vc_${Math.random().toString(36).slice(2, 12)}`;
  const flags = 0x02; // clean start
  let variable = concat(encodeString('MQTT'), new Uint8Array([protocolVersion, flags]), u16(KEEPALIVE));
  if (protocolVersion === 5) variable = concat(variable, encodeVarint(0));
  sendPacket(0x10, concat(variable, encodeString(clientId)));
}

function subscribe() {
  if (!connected || !currentUserId || subscribedFor === currentUserId) return;
  const topics = [
    `${ROOT}/inbox/${currentUserId}/#`,
    `${ROOT}/profile/#`,
  ];
  const parts = [u16(packetId()), encodeVarint(0)];
  for (const topic of topics) parts.push(encodeString(topic), new Uint8Array([1]));
  sendPacket(0x82, concat(...parts));
  subscribedFor = currentUserId;
}

/* ---------------- packet handling ---------------- */

function ingest(chunk) {
  inbound = concat(inbound, chunk);
  while (inbound.length >= 2) {
    let headerLength;
    let remaining;
    try {
      const decoded = decodeVarint(inbound, 1);
      remaining = decoded.value;
      headerLength = 1 + decoded.length;
    } catch {
      return;
    }
    const total = headerLength + remaining;
    if (inbound.length < total) return;
    const packet = inbound.slice(0, total);
    inbound = inbound.slice(total);
    handlePacket(packet, headerLength);
  }
}

function handlePacket(packet, headerLength) {
  const type = packet[0] & 0xf0;
  const body = packet.slice(headerLength);

  if (type === 0x20) {
    const reasonCode = body[1];
    if (reasonCode === 0) {
      connected = true;
      subscribedFor = '';
      subscribe();
      startPing();
      notify();
    } else if (reasonCode === 1 && protocolVersion === 5) {
      protocolVersion = 4;
      disconnect();
      connect();
    }
    return;
  }

  if (type === 0x40) {
    const id = (body[0] << 8) | body[1];
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve();
    }
    return;
  }

  if (type === 0x30) {
    let offset = 0;
    const topicLength = (body[offset] << 8) | body[offset + 1];
    offset += 2;
    const topic = decoder.decode(body.slice(offset, offset + topicLength));
    offset += topicLength;
    const qos = (packet[0] >> 1) & 0x03;
    let id = 0;
    if (qos > 0) {
      id = (body[offset] << 8) | body[offset + 1];
      offset += 2;
      if (qos === 1) sendPacket(0x40, u16(id));
    }
    if (protocolVersion === 5) {
      const props = decodeVarint(body, offset);
      offset += props.length + props.value;
    }
    handlePublish(topic, body.slice(offset));
  }
}

async function handlePublish(topic, payload) {
  if (topic.startsWith(`${ROOT}/profile/`)) {
    try {
      profiles.set(topic.split('/').pop(), JSON.parse(decoder.decode(payload)));
      notify();
    } catch { /* ignore malformed profile */ }
    return;
  }

  if (!topic.startsWith(`${ROOT}/inbox/`)) return;

  const parts = topic.slice(`${ROOT}/inbox/`.length).split('/');
  if (parts[1] === 'chunk' && parts.length >= 4) {
    const mediaId = parts[2];
    const part = Number(parts[3]);
    if (payload.length === 0) {
      await db.del('chunks', `${mediaId}:${part}`);
      notify();
      return;
    }
    try {
      const data = JSON.parse(decoder.decode(payload));
      await db.put('chunks', {
        id: `${mediaId}:${part}`,
        mediaId,
        part,
        total: data.total || 1,
        data: data.data || '',
        expiresAt: Date.now() + EXPIRY_SECONDS * 1000,
      });
      notify();
    } catch { /* ignore malformed chunk */ }
    return;
  }

  if (parts[1] === 'msg' && parts[2]) {
    if (payload.length === 0) {
      queue.push({ id: parts[2], __deleted: true });
      notify();
      return;
    }
    try {
      const row = JSON.parse(decoder.decode(payload));
      if (row && row.id) {
        queue.push(row);
        notify();
      }
    } catch { /* ignore malformed message */ }
  }
}

function publish(topic, payload, { retain = true, expiry = EXPIRY_SECONDS } = {}) {
  return new Promise((resolve, reject) => {
    if (!connected) {
      reject(new Error('Relay is offline — check your connection and try again.'));
      return;
    }
    const id = packetId();
    pending.set(id, { resolve, reject });
    const parts = [encodeString(topic), u16(id)];
    if (protocolVersion === 5) {
      parts.push(concat(encodeVarint(5), new Uint8Array([0x02]), u32(expiry)));
    }
    sendPacket(0x33, concat(...parts, payload));
  });
}

/* ---------------- public adapter API ---------------- */

export async function userIdForUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
  return `u-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function cloudCreateProfile({ username, salt, hash }) {
  const id = await userIdForUsername(username);
  setCloudUser(id);
  await publish(
    `${ROOT}/profile/${id}`,
    encoder.encode(JSON.stringify({
      id,
      username,
      salt,
      password_hash: hash,
      created_at: new Date().toISOString(),
    })),
    { expiry: 0 }
  );
  return { id, username };
}

async function waitForProfile(id, timeout = 2500) {
  if (profiles.has(id)) return profiles.get(id);
  return new Promise((resolve) => {
    const unsubscribe = setOnChange(() => {
      if (profiles.has(id)) {
        unsubscribe();
        clearTimeout(timer);
        resolve(profiles.get(id));
      }
    });
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(profiles.get(id) || null);
    }, timeout);
  });
}

export async function cloudGetProfile(username) {
  const id = await userIdForUsername(username);
  const profile = await waitForProfile(id);
  return profile || { id, username, salt: null, password_hash: null };
}

export async function cloudGetProfileById(id) {
  return profiles.get(id) || { id, username: `User ${id.slice(0, 6)}`, salt: null, password_hash: null };
}

export async function cloudUpdateProfileHash(id, salt, hash) {
  const current = profiles.get(id) || {};
  const updated = { ...current, id, salt, password_hash: hash };
  profiles.set(id, updated);
  await publish(`${ROOT}/profile/${id}`, encoder.encode(JSON.stringify(updated)), { expiry: 0 });
}

export function cloudFetchMessages() {
  const items = queue;
  queue = [];
  return items;
}

export async function cloudInsertMessage(message) {
  const recipientId = message.recipientId;
  if (!recipientId) throw new Error('Recipient is unknown.');
  await publish(
    `${ROOT}/inbox/${recipientId}/msg/${message.id}`,
    encoder.encode(JSON.stringify({
      id: message.id,
      chat_id: message.chatId,
      sender_id: message.senderId,
      recipient_id: recipientId,
      kind: message.type,
      body: message.text || '',
      media_id: message.mediaId || null,
      media_path: message.mediaPath || null,
      media_chunks: message.mediaChunks || 0,
      media_name: message.mediaName || null,
      media_mime: message.mediaMime || null,
      media_size: message.mediaSize || null,
      created_at: new Date(message.createdAt).toISOString(),
      expires_at: new Date(message.expiresAt).toISOString(),
    }))
  );
  return message;
}

export async function cloudUploadMedia(id, blob, name, mime, recipientId, onProgress) {
  if (!recipientId) throw new Error('Recipient is unknown.');
  const total = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
  for (let part = 0; part < total; part++) {
    const slice = blob.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE);
    const data = await blobToBase64(slice);
    await publish(
      `${ROOT}/inbox/${recipientId}/chunk/${id}/${part}`,
      encoder.encode(JSON.stringify({ mediaId: id, part, total, data }))
    );
    if (onProgress) onProgress(part + 1, total);
  }
  return `relay:${id}:${total}`;
}

export async function cloudFetchMedia(message) {
  const mediaId = message.mediaId;
  if (!mediaId) return false;
  const chunks = await db.getByIndex('chunks', 'by-media', mediaId);
  if (!chunks.length) return false;
  const total = message.mediaChunks || chunks.length;
  if (chunks.length < total) return false;
  chunks.sort((a, b) => a.part - b.part);
  const blob = new Blob(chunks.map((chunk) => fromBase64(chunk.data)), {
    type: message.mediaMime || 'application/octet-stream',
  });
  await db.put('media', {
    id: mediaId,
    blob,
    name: message.mediaName || 'media',
    mime: message.mediaMime || blob.type,
    size: blob.size,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  });
  for (const chunk of chunks) await db.del('chunks', chunk.id);
  notify();
  return true;
}

export async function cloudDeleteMessage(message) {
  if (!message || !message.recipientId) return;
  const base = `${ROOT}/inbox/${message.recipientId}`;
  const empty = new Uint8Array(0);
  try {
    await publish(`${base}/msg/${message.id}`, empty);
  } catch { /* best effort */ }
  if (message.mediaChunks) {
    for (let part = 0; part < message.mediaChunks; part++) {
      try {
        await publish(`${base}/chunk/${message.mediaId}/${part}`, empty);
      } catch { /* best effort */ }
    }
  }
}

export async function cloudDeleteMedia() {
  // Chunk tombstones are published with the message deletion.
}

export function cloudMediaUrl() {
  return '';
}

connect();
