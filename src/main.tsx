import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { TelegramProvider } from './context/TelegramContext.tsx'

import { Buffer as NodeBuffer } from 'buffer';

document.documentElement.classList.add('dark');

if (typeof navigator !== 'undefined' && /SamsungBrowser/i.test(navigator.userAgent)) {
  document.documentElement.classList.add('samsung-browser');
}

if (typeof NodeBuffer !== 'undefined') {
  Object.defineProperty(NodeBuffer, Symbol.hasInstance, {
    value: function (instance: any) {
      return instance != null && 
        (instance._isBuffer || 
         instance.constructor === NodeBuffer || 
         instance instanceof Uint8Array);
    }
  });
}

if ('serviceWorker' in navigator) {
  const registerSw = async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        if (
          reg.active?.scriptURL.includes('v=') ||
          reg.waiting?.scriptURL.includes('v=') ||
          reg.installing?.scriptURL.includes('v=')
        ) {
          console.log('[SW] Unregistering legacy versioned worker:', reg.scope);
          await reg.unregister();
        }
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('✅ SW registered:', registration.scope);
    } catch (err) {
      console.warn('SW initial registration failed, attempting cleanup & retry:', err);
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        const retry = await navigator.serviceWorker.register('/sw.js');
        console.log('✅ SW registered after cleanup:', retry.scope);
      } catch (retryErr) {
        console.error('SW fatal registration error:', retryErr);
      }
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void registerSw(); }, { once: true });
  } else {
    void registerSw();
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TelegramProvider>
      <App />
    </TelegramProvider>
  </React.StrictMode>,
)
