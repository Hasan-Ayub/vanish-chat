/**
 * Zero-setup relay configuration.
 *
 * The app uses a public MQTT-over-WebSocket broker to deliver messages between
 * accounts. No credentials or accounts are needed. You can switch brokers in
 * Settings if one is unavailable.
 */

export const BROKERS = [
  { label: 'HiveMQ (default)', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { label: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { label: 'Mosquitto test', url: 'wss://test.mosquitto.org:8081/mqtt' },
];

const STORAGE_KEY = 'vanish-chat.broker';

export function getCloudConfig() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const match = BROKERS.find((broker) => broker.url === saved);
  return { broker: match ? match.url : BROKERS[0].url };
}

export function setCloudConfig({ broker }) {
  const match = BROKERS.find((item) => item.url === broker);
  if (match) localStorage.setItem(STORAGE_KEY, match.url);
}

export function clearCloudConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isCloudConfigured() {
  return true;
}
