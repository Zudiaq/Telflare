import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(() => {
    return (window as any).__deferredPrompt || null;
  });
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isFirefox, setIsFirefox] = useState(false);
  const [isSamsung, setIsSamsung] = useState(false);
  const [isChrome, setIsChrome] = useState(false);
  const [isSafari, setIsSafari] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);

  useEffect(() => {
    const checkStandalone = () => {
      const isStandaloneMode = 
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true ||
        document.referrer.includes('android-app://');
      setIsStandalone(isStandaloneMode);
    };

    checkStandalone();

    const ua = window.navigator.userAgent.toLowerCase();
    const isIOSDevice =
      /iphone|ipad|ipod/.test(ua) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const isAndroidDevice = /android/.test(ua);
    const isMobileDevice = isIOSDevice || isAndroidDevice;

    const detectedFirefox = /firefox|fxios/i.test(ua);
    const detectedSamsung = /samsungbrowser/i.test(ua);
    const detectedChrome = /chrome|crios/i.test(ua) && !detectedSamsung;
    const detectedSafari = /safari/i.test(ua) && !/chrome|crios|firefox|fxios|samsungbrowser/i.test(ua);

    setIsIOS(isIOSDevice);
    setIsAndroid(isAndroidDevice);
    setIsMobile(isMobileDevice);
    setIsFirefox(detectedFirefox);
    setIsSamsung(detectedSamsung);
    setIsChrome(detectedChrome);
    setIsSafari(detectedSafari);

    if ((window as any).__deferredPrompt) {
      setDeferredPrompt((window as any).__deferredPrompt);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      (window as any).__deferredPrompt = e;
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      (window as any).__deferredPrompt = null;
      setIsStandalone(true);
      setIsInstallModalOpen(false);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const promptNativeInstall = async () => {
    const prompt = deferredPrompt || (window as any).__deferredPrompt;
    if (prompt) {
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === 'accepted') {
          setDeferredPrompt(null);
          (window as any).__deferredPrompt = null;
          setIsInstallModalOpen(false);
        }
      } catch (err) {
        console.warn('Install prompt error:', err);
      }
    }
  };

  const triggerInstall = async () => {
    const prompt = deferredPrompt || (window as any).__deferredPrompt;
    if (prompt) {
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === 'accepted') {
          setDeferredPrompt(null);
          (window as any).__deferredPrompt = null;
          setIsInstallModalOpen(false);
          return;
        }
      } catch (err) {
        console.warn('Install prompt error:', err);
      }
    }
    setIsInstallModalOpen(true);
  };

  return {
    canInstall: !isStandalone && isMobile,
    isStandalone,
    isIOS,
    isAndroid,
    isMobile,
    isFirefox,
    isSamsung,
    isChrome,
    isSafari,
    hasNativePrompt: !!(deferredPrompt || (typeof window !== 'undefined' && (window as any).__deferredPrompt)),
    showIOSGuide,
    setShowIOSGuide,
    isInstallModalOpen,
    setIsInstallModalOpen,
    triggerInstall,
    promptNativeInstall,
  };
}
