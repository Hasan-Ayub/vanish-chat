/**
 * Optional cloud connection (Supabase).
 *
 * Leave these blank to run in LOCAL DEMO MODE: accounts, chats and media live
 * only in this browser. To message people on other devices, paste your
 * Supabase project URL and anon key below, or use the in-app Settings panel.
 * See supabase/schema.sql and README.md for setup.
 */
export const DEFAULT_CLOUD_CONFIG = {
  url: '',      // e.g. https://abcdefghijklmno.supabase.co
  anonKey: '',  // Supabase "anon / public" key
};

const STORAGE_KEY = 'vanish-chat.cloud';

export function getCloudConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  return {
    url: String(saved.url || DEFAULT_CLOUD_CONFIG.url || '').replace(/\/+$/, ''),
    anonKey: String(saved.anonKey || DEFAULT_CLOUD_CONFIG.anonKey || '').trim(),
  };
}

export function setCloudConfig({ url, anonKey }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    url: String(url || '').trim().replace(/\/+$/, ''),
    anonKey: String(anonKey || '').trim(),
  }));
}

export function clearCloudConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isCloudConfigured() {
  const cfg = getCloudConfig();
  return Boolean(cfg.url && cfg.anonKey);
}
