import React, { createContext, useContext, useEffect, useState } from 'react';
import { TelegramClient, Api } from 'telegram';
import { getTelegramClient, getSession, saveSession, clearSession, getBotToken, saveBotToken, clearBotToken, getStoredTelegramAccounts, saveStoredTelegramAccount, getActiveTelegramAccountId, setActiveTelegramAccountId, removeStoredTelegramAccount, setActiveTelegramClient, type StoredTelegramAccount } from '../lib/telegram';

export interface SessionNotice {
  accountId: string;
  accountName?: string;
  reason: 'expired' | 'revoked' | 'terminated';
  message: string;
}

interface TelegramContextType {
  client: TelegramClient | null;
  botClient: TelegramClient | null;
  botId: any | null;
  botUsername: string | null;
  isAuthenticated: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  retryConnection: () => void;
  accounts: StoredTelegramAccount[];
  activeAccountId: string | null;
  login: (client: TelegramClient) => Promise<void>;
  switchAccount: (id: string) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  terminateAccount: (id: string) => Promise<void>;
  handleSessionRevoked: (id?: string) => Promise<void>;
  logout: () => Promise<void>;
  setupBot: (token: string) => Promise<void>;
  removeBot: () => void;
  sessionNotice: SessionNotice | null;
  clearSessionNotice: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

/* ============================================================================
 * CONTEXT: TelegramProvider
 * Telegram multi-account auth lifecycle, bot routing, and session state.
 * ============================================================================ */
export const TelegramProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [client, setClient] = useState<TelegramClient | null>(null);
  const [botClient, setBotClient] = useState<TelegramClient | null>(null);
  const [botId, setBotId] = useState<any | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [accounts, setAccounts] = useState<StoredTelegramAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<SessionNotice | null>(null);

  const clearSessionNotice = () => setSessionNotice(null);
  const retryConnection = () => {
    setConnectionError(null);
    setIsConnecting(true);
    setRetryNonce((n) => n + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const initClient = async () => {
      setIsConnecting(true);
      setConnectionError(null);
      const stored = getStoredTelegramAccounts();
      setAccounts(stored);
      const activeId = getActiveTelegramAccountId();
      const activeAccount = stored.find((account) => account.id === activeId) || stored[0];
      const sessionString = getSession() || (activeAccount ? activeAccount.session : '');
      if (activeAccount && !getSession()) {
        saveSession(activeAccount.session);
        setActiveTelegramAccountId(activeAccount.id);
      }
      setActiveAccountId(getActiveTelegramAccountId());

      if (sessionString) {
        let restored = false;
        let lastErr: any = null;
        for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
          let tgClient: TelegramClient | null = null;
          try {
            tgClient = getTelegramClient(sessionString);
            await tgClient.connect();
            if (cancelled) {
              try { await tgClient.disconnect(); } catch {}
              return;
            }
            if (await tgClient.checkAuthorization()) {
              setClient(tgClient);
              setActiveTelegramClient(tgClient);
              setIsAuthenticated(true);
              restored = true;
              const me: any = await tgClient.getMe();
              const existing = stored.find(account => account.id === String(me.id));
              if (!existing) {
                const account: StoredTelegramAccount = {
                  id: String(me.id),
                  username: String(me.username || ''),
                  displayName: [me.firstName, me.lastName].filter(Boolean).join(' ') || `Telegram ${me.id}`,
                  session: tgClient.session.save() as unknown as string,
                  updatedAt: Date.now()
                };
                saveStoredTelegramAccount(account);
                setAccounts(getStoredTelegramAccounts());
                setActiveAccountId(account.id);
              } else {
                setActiveTelegramAccountId(existing.id);
                setActiveAccountId(existing.id);
              }
              break;
            } else {
              const currentActId = getActiveTelegramAccountId();
              const badAccount = stored.find(a => a.id === currentActId);
              if (currentActId) {
                removeStoredTelegramAccount(currentActId);
                localStorage.removeItem(`zud_available_channels_${currentActId}`);
                setSessionNotice({
                  accountId: currentActId,
                  accountName: badAccount?.displayName || badAccount?.username || currentActId,
                  reason: 'expired',
                  message: `The Telegram session for "${badAccount?.displayName || currentActId}" has expired or was terminated on another device. It has been removed from saved accounts.`
                });
              }
              const remaining = getStoredTelegramAccounts();
              setAccounts(remaining);
              if (remaining.length > 0) {
                setActiveTelegramAccountId(remaining[0].id);
                setActiveAccountId(remaining[0].id);
                try {
                  const altClient = getTelegramClient(remaining[0].session);
                  await altClient.connect();
                  if (await altClient.checkAuthorization()) {
                    setClient(altClient);
                    setActiveTelegramClient(altClient);
                    setIsAuthenticated(true);
                    restored = true;
                  }
                } catch {}
              } else {
                clearSession();
              }
              break;
            }
          } catch (error: any) {
            lastErr = error;
            console.error(`Failed to restore session (attempt ${attempt}/3):`, error);
            if (tgClient) {
              try { await tgClient.disconnect(); } catch {}
            }
            const errMsg = String(error?.message || error);
            if (errMsg.includes('AUTH_KEY_UNREGISTERED') || errMsg.includes('SESSION_REVOKED') || errMsg.includes('401')) {
              const currentActId = getActiveTelegramAccountId();
              const badAccount = stored.find(a => a.id === currentActId);
              if (currentActId) {
                removeStoredTelegramAccount(currentActId);
                localStorage.removeItem(`zud_available_channels_${currentActId}`);
                setSessionNotice({
                  accountId: currentActId,
                  accountName: badAccount?.displayName || badAccount?.username || currentActId,
                  reason: 'revoked',
                  message: `The Telegram session for "${badAccount?.displayName || currentActId}" was terminated or revoked on another device. It has been safely removed.`
                });
              }
              setAccounts(getStoredTelegramAccounts());
              clearSession();
              break;
            }
            // Transient cold-start / Cloudflare edge jitter: wait briefly and retry automatically
            if (attempt < 3 && !cancelled) {
              await new Promise((r) => setTimeout(r, 700 * attempt));
            }
          }
        }
        if (!restored && !cancelled && getSession()) {
          setConnectionError(String(lastErr?.message || 'Unable to connect to Telegram via Cloudflare Edge.'));
        }
      }
      const botTokenStr = getBotToken();
      if (botTokenStr && !cancelled) {
        try {
          const bClient = getTelegramClient('');
          await bClient.start({ botAuthToken: botTokenStr });
          const me = await bClient.getMe();
          if (!cancelled) {
            setBotClient(bClient);
            setBotId(me.id);
            setBotUsername(me.username as string || null);
          }
        } catch (e: any) {
          console.error("Failed to restore bot session", e);
          const em = String(e?.message || e || '');
          if (/ACCESS_TOKEN_INVALID|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|401/i.test(em)) {
            clearBotToken();
          }
        }
      }

      if (!cancelled) setIsConnecting(false);
    };

    void initClient();
    return () => { cancelled = true; };
  }, [retryNonce]);

  const setupBot = async (token: string) => {
    try {
      const bClient = getTelegramClient('');
      await bClient.start({ botAuthToken: token });
      const me = await bClient.getMe();
      saveBotToken(token);
      setBotClient(bClient);
      setBotId(me.id);
      setBotUsername(me.username as string || null);
    } catch (e) {
      console.error("Failed to setup bot:", e);
      throw e;
    }
  };

  const removeBot = () => {
    clearBotToken();
    if (botClient) {
      botClient.disconnect();
    }
    setBotClient(null);
    setBotId(null);
    setBotUsername(null);
  };

  const login = async (newClient: TelegramClient) => {
    if (client && client !== newClient) {
      try { await client.disconnect(); } catch {}
    }
    const sessionString = newClient.session.save() as unknown as string;
    const me: any = await newClient.getMe();
    const account: StoredTelegramAccount = {
      id: String(me.id),
      username: String(me.username || ''),
      displayName: [me.firstName, me.lastName].filter(Boolean).join(' ') || `Telegram ${me.id}`,
      session: sessionString,
      updatedAt: Date.now()
    };
    saveStoredTelegramAccount(account);
    setActiveTelegramAccountId(account.id);
    setAccounts(getStoredTelegramAccounts());
    setActiveAccountId(account.id);
    setClient(newClient);
    setActiveTelegramClient(newClient);
    setIsAuthenticated(true);
  };

  const switchAccount = async (id: string) => {
    if (id === activeAccountId) return;
    const account = getStoredTelegramAccounts().find(item => item.id === id);
    if (!account) throw new Error('Telegram account session was not found.');
    if (client) {
      try { await client.disconnect(); } catch {}
    }
    const nextClient = getTelegramClient(account.session);
    try {
      await nextClient.connect();
      const isAuth = await nextClient.checkAuthorization();
      if (!isAuth) throw new Error('AUTH_KEY_UNREGISTERED');
    } catch (e: any) {
      const errMsg = String(e?.message || e);
      if (errMsg.includes('AUTH_KEY_UNREGISTERED') || errMsg.includes('SESSION_REVOKED') || errMsg.includes('401')) {
        removeStoredTelegramAccount(id);
        localStorage.removeItem(`zud_available_channels_${id}`);
        setAccounts(getStoredTelegramAccounts());
        setSessionNotice({
          accountId: id,
          accountName: account.displayName || account.username || id,
          reason: 'revoked',
          message: `The Telegram session for "${account.displayName || account.username || id}" has expired or was revoked from another device. It has been removed from saved accounts.`
        });
        throw new Error(`The session for "${account.displayName || account.username || id}" was terminated or revoked on Telegram.`);
      }
      throw e;
    }
    setActiveTelegramAccountId(id);
    setActiveAccountId(id);
    setClient(nextClient);
    setActiveTelegramClient(nextClient);
    setIsAuthenticated(true);
  };

  const removeAccount = async (id: string) => {
    if (id === activeAccountId) {
      const next = accounts.find(account => account.id !== id);
      if (next) await switchAccount(next.id);
      else await logout();
    }
    removeStoredTelegramAccount(id);
    localStorage.removeItem(`zud_available_channels_${id}`);
    localStorage.removeItem(`zud_channel_about_cache_${id}`);
    localStorage.removeItem(`drive_root_channel_id_${id}`);
    setAccounts(getStoredTelegramAccounts());
  };

  const terminateAccount = async (id: string) => {
    const account = getStoredTelegramAccounts().find(item => item.id === id);
    if (!account) return;

    if (id === activeAccountId && client) {
      try {
        await client.invoke(new Api.auth.LogOut());
      } catch (e) {
        console.warn('Telegram LogOut RPC failed or session already terminated:', e);
      }
      try {
        await client.disconnect();
      } catch {}
    } else {
      try {
        const tempClient = getTelegramClient(account.session);
        await tempClient.connect();
        await tempClient.invoke(new Api.auth.LogOut());
        await tempClient.disconnect();
      } catch (e) {
        console.warn('Failed to terminate remote Telegram session:', e);
      }
    }

    localStorage.removeItem(`zud_available_channels_${id}`);
    localStorage.removeItem(`zud_channel_about_cache_${id}`);
    localStorage.removeItem(`drive_root_channel_id_${id}`);
    localStorage.removeItem(`zud_music_player_${id}`);

    removeStoredTelegramAccount(id);
    const remaining = getStoredTelegramAccounts();
    setAccounts(remaining);

    if (id === activeAccountId) {
      if (remaining.length > 0) {
        await switchAccount(remaining[0].id);
      } else {
        await logout();
      }
    }
  };

  const handleSessionRevoked = async (revokedId?: string) => {
    const targetId = revokedId || activeAccountId;
    if (!targetId) return;

    console.warn(`Session ${targetId} was revoked or unregistered.`);
    const currentAccounts = getStoredTelegramAccounts();
    const targetAccount = currentAccounts.find(a => a.id === targetId);

    setSessionNotice({
      accountId: targetId,
      accountName: targetAccount?.displayName || targetAccount?.username || targetId,
      reason: 'revoked',
      message: `Your Telegram session for "${targetAccount?.displayName || targetId}" was terminated or revoked from another device. It has been safely removed.`
    });

    localStorage.removeItem(`zud_available_channels_${targetId}`);
    localStorage.removeItem(`zud_channel_about_cache_${targetId}`);
    localStorage.removeItem(`drive_root_channel_id_${targetId}`);
    removeStoredTelegramAccount(targetId);

    const remaining = getStoredTelegramAccounts();
    setAccounts(remaining);

    if (targetId === activeAccountId) {
      if (client) {
        try { await client.disconnect(); } catch {}
      }
      if (remaining.length > 0) {
        try {
          await switchAccount(remaining[0].id);
        } catch {
          await logout();
        }
      } else {
        await logout();
      }
    }
  };

  const logout = async () => {
    if (client) {
      await client.disconnect();
    }
    clearSession();
    setClient(null);
    setActiveTelegramClient(null);
    setIsAuthenticated(false);
  };

  return (
    <TelegramContext.Provider value={{ client, botClient, botId, botUsername, isAuthenticated, isConnecting, connectionError, retryConnection, accounts, activeAccountId, login, switchAccount, removeAccount, terminateAccount, handleSessionRevoked, logout, setupBot, removeBot, sessionNotice, clearSessionNotice }}>
      {children}
    </TelegramContext.Provider>
  );
};

export const useTelegram = () => {
  const context = useContext(TelegramContext);
  if (context === undefined) {
    throw new Error('useTelegram must be used within a TelegramProvider');
  }
  return context;
};
