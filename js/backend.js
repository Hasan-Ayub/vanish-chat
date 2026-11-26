/**
 * Backend switch.
 *
 * With Supabase configured, accounts/chats/messages/media are stored on the
 * server. Otherwise the app falls back to the zero-setup MQTT relay so the
 * existing public demo keeps working.
 */

import * as relay from './relay.js?v=8';
import * as supabase from './cloud.js?v=8';
import { isCloudConfigured } from '../config.js?v=8';

const useDatabase = () => isCloudConfigured();
const active = () => (useDatabase() ? supabase : relay);

export function refreshCloudConfig() {
  relay.refreshCloudConfig();
  supabase.refreshCloudConfig();
}

export function setCloudUser(userId) {
  relay.setCloudUser(userId);
  supabase.setCloudUser(userId);
}

export function cloudEnabled() {
  return useDatabase() ? supabase.cloudEnabled() : relay.cloudEnabled();
}

export function getStatus() {
  return useDatabase() ? supabase.getStatus() : relay.getStatus();
}

export function backendName() {
  return useDatabase() ? 'database' : 'relay';
}

export function setOnChange(listener) {
  const offRelay = relay.setOnChange(listener);
  const offDatabase = supabase.setOnChange(listener);
  return () => {
    offRelay();
    offDatabase();
  };
}

export const cloudCreateProfile = (...args) => active().cloudCreateProfile(...args);
export const cloudGetProfile = (...args) => active().cloudGetProfile(...args);
export const cloudGetProfileById = (...args) => active().cloudGetProfileById(...args);
export const cloudUpdateProfileHash = (...args) => active().cloudUpdateProfileHash(...args);
export const cloudUpsertChat = (...args) => active().cloudUpsertChat(...args);
export const cloudFetchChats = (...args) => active().cloudFetchChats(...args);
export const cloudFetchMessages = (...args) => active().cloudFetchMessages(...args);
export const cloudInsertMessage = (...args) => active().cloudInsertMessage(...args);
export const cloudDeleteMessage = (...args) => active().cloudDeleteMessage(...args);
export const cloudUploadMedia = (...args) => active().cloudUploadMedia(...args);
export const cloudFetchMedia = (...args) => active().cloudFetchMedia(...args);
export const cloudDeleteMedia = (...args) => active().cloudDeleteMedia(...args);
export const cloudMediaUrl = (...args) => active().cloudMediaUrl(...args);
export const userIdForUsername = (...args) => active().userIdForUsername(...args);
