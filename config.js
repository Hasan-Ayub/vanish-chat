/**
 * Backend configuration.
 *
 * GitHub Pages is static, so it cannot host a database. Paste your Supabase
 * Project URL and anon/public key below to store accounts, chats, messages and
 * media on the server. Leave them empty to use the no-setup MQTT relay.
 *
 * Put the values here (not only in Settings) so every device uses the same DB.
 */

// Example: https://abcdefgh.supabase.co
const SUPABASE_URL = '';

// The public anon key from Supabase Settings → API. Rows are protected by RLS.
const SUPABASE_ANON_KEY = '';

export const BROKERS = [
  { label: 'HiveMQ (default)', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { label: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { label: 'Mosquitto test', url: 'wss://test.mosquitto.org:8081/mqtt' },
];

const BROKER_KEY = 'vanish-chat.broker';
const DATABASE_KEY = 'vanish-chat.database';

function readDatabaseOverride() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DATABASE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (ignored) {
    return {};
  }
}

export function getCloudConfig() {
  const savedBroker = localStorage.getItem(BROKER_KEY);
  const brokerMatch = BROKERS.find((broker) => broker.url === savedBroker);
  const dbOverride = readDatabaseOverride();
  return {
    broker: brokerMatch ? brokerMatch.url : BROKERS[0].url,
    supabaseUrl: String(dbOverride.supabaseUrl || SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseKey: String(dbOverride.supabaseKey || SUPABASE_ANON_KEY || '').trim(),
  };
}

export function setCloudConfig({ broker, supabaseUrl, supabaseKey } = {}) {
  if (broker && BROKERS.some((item) => item.url === broker)) {
    localStorage.setItem(BROKER_KEY, broker);
  }

  const next = readDatabaseOverride();
  if (supabaseUrl !== undefined) next.supabaseUrl = String(supabaseUrl || '').trim().replace(/\/+$/, '');
  if (supabaseKey !== undefined) next.supabaseKey = String(supabaseKey || '').trim();
  localStorage.setItem(DATABASE_KEY, JSON.stringify(next));
}

export function clearCloudConfig() {
  localStorage.removeItem(BROKER_KEY);
  localStorage.removeItem(DATABASE_KEY);
}

export function isCloudConfigured() {
  const config = getCloudConfig();
  return Boolean(config.supabaseUrl && config.supabaseKey);
}
