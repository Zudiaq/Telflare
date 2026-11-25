import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { noteFlood } from './tgGate';
import { applyWebCryptoPatch } from './webCryptoPatch';
import { applyProxiedWebSocketsPatch, ProxiedPromisedWebSockets } from './proxiedSocket';
import { installDcSenderPool } from './dcSenderPool';

applyWebCryptoPatch();
applyProxiedWebSocketsPatch();

const apiId = 4218382;
const apiHash = '2a4204685600e58d8cd9c04194ac005e';
let activeTelegramClient: TelegramClient | null = null;

/* ============================================================================
 * CLIENT-SIDE TELEGRAM MTPROTO CLIENT FACTORY
 * ============================================================================ */
export const getTelegramClient = (sessionString: string = '') => {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: true,
    networkSocket: ProxiedPromisedWebSockets,
  });

  installDcSenderPool(client);

  const log: any = (client as any)._log;
  if (log && typeof log.log === 'function') {
    const originalLog = log.log.bind(log);
    log.log = (level: any, message: string, color: string) => {
      const match = /Sleeping for (\d+)s on flood wait/.exec(String(message));
      if (match) noteFlood(Number(match[1]));
      return originalLog(level, message, color);
    };
  }
  return client;
};

export const setActiveTelegramClient = (client: TelegramClient | null) => {
  activeTelegramClient = client;
};

export const getActiveTelegramClient = () => activeTelegramClient;

/* ============================================================================
 * LOCAL BROWSER SESSION & MULTI-ACCOUNT STORAGE
 * ============================================================================ */
export const saveSession = (session: string) => {
  localStorage.setItem('tg_session', session);
};

export const getSession = () => {
  return localStorage.getItem('tg_session') || '';
};

export const clearSession = () => {
  localStorage.removeItem('tg_session');
};

export type StoredTelegramAccount = {
  id: string;
  username: string;
  displayName: string;
  session: string;
  updatedAt: number;
};

const ACCOUNTS_KEY = 'tg_accounts_v1';
const ACTIVE_ACCOUNT_KEY = 'tg_active_account';

export const getStoredTelegramAccounts = (): StoredTelegramAccount[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(account =>
      account && typeof account.id === 'string' && typeof account.session === 'string'
    ) : [];
  } catch {
    return [];
  }
};

export const saveStoredTelegramAccount = (account: StoredTelegramAccount) => {
  const accounts = getStoredTelegramAccounts().filter(item => item.id !== account.id);
  accounts.push(account);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts.slice(-3)));
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  saveSession(account.session);
};

export const getActiveTelegramAccountId = () => localStorage.getItem(ACTIVE_ACCOUNT_KEY);

export const setActiveTelegramAccountId = (id: string) => {
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  const account = getStoredTelegramAccounts().find(item => item.id === id);
  if (account) saveSession(account.session);
};

export const removeStoredTelegramAccount = (id: string) => {
  const accounts = getStoredTelegramAccounts().filter(item => item.id !== id);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  if (getActiveTelegramAccountId() === id) {
    const next = accounts[0];
    if (next) setActiveTelegramAccountId(next.id);
    else {
      localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
      clearSession();
    }
  }
};

export const saveBotToken = (token: string) => {
  localStorage.setItem('tg_bot_token', token);
};

export const getBotToken = () => {
  return localStorage.getItem('tg_bot_token') || '';
};

export const clearBotToken = () => {
  localStorage.removeItem('tg_bot_token');
};
