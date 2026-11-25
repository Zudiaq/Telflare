import React, { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTelegram } from '../context/TelegramContext';
import { getTelegramClient } from '../lib/telegram';
import { Api } from 'telegram';
import { ChevronDown, Eye, EyeOff, Key, Loader2, Search } from 'lucide-react';
import { PWAInstallModal } from './PWAInstallModal';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Smartphone } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { VoxelLogoLoader } from './VoxelLogoLoader';
import QRCode from 'qrcode';
import { getCountries, getCountryCallingCode, type CountryCode } from 'libphonenumber-js';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const flagForCountry = (country: string) =>
  country.replace(/./g, (letter) => String.fromCodePoint(letter.charCodeAt(0) + 127397));

/* ============================================================================
 * COMPONENT: Login
 * Telegram authentication (QR code, Phone SMS/Telegram code, 2FA password).
 * ============================================================================ */
export const Login: React.FC<{ onSuccess?: () => void }> = ({ onSuccess }) => {
  const { login } = useTelegram();
  const [loginMethod, setLoginMethod] = useState<'qr' | 'phone'>('qr');
  
  const [phoneNumber, setPhoneNumber] = useState('');
  const [countryCode, setCountryCode] = useState('+1');
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>('US');
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [countryMenuPosition, setCountryMenuPosition] = useState({ top: 0, left: 0, width: 0 });
  const [countrySearch, setCountrySearch] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(30);
  const [codeVerified, setCodeVerified] = useState(false);
  const [codeError, setCodeError] = useState(false);
  
  const [step, setStep] = useState<'phone' | 'code' | 'password' | 'qr'>('qr');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  
  const [tempClient, setTempClient] = useState<any>(null);
  const { isIOS, isAndroid, canInstall, hasNativePrompt, showIOSGuide, setShowIOSGuide, isInstallModalOpen, setIsInstallModalOpen, triggerInstall, promptNativeInstall } = usePWAInstall();
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const countryCodeInputRef = useRef<HTMLInputElement>(null);
  const countryButtonRef = useRef<HTMLButtonElement>(null);
  const codeInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const stageShellRef = useRef<HTMLDivElement>(null);
  const stageContentRef = useRef<HTMLDivElement>(null);
  const stageHeightRef = useRef<number | null>(null);
  const [stageHeight, setStageHeight] = useState<number | null>(null);

  const countries = useMemo(() => getCountries().map((country) => ({
    country,
    name: countryNames.of(country) || country,
    callingCode: getCountryCallingCode(country),
    flag: flagForCountry(country)
  })).sort((a, b) => a.name.localeCompare(b.name)), []);

  const filteredCountries = useMemo(() => {
    const query = countrySearch.trim().toLowerCase();
    return countries.filter(({ name, callingCode, country }) =>
      !query || name.toLowerCase().includes(query) || country.toLowerCase().includes(query) || callingCode.includes(query.replace('+', ''))
    );
  }, [countries, countrySearch]);

  const focusPhoneInput = () => {
    window.setTimeout(() => phoneInputRef.current?.focus(), 0);
  };

  const updateCountryMenuPosition = () => {
    const rect = countryButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, window.innerWidth - 16);
    setCountryMenuPosition({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width
    });
  };

  const toggleCountryMenu = () => {
    setCountryMenuOpen(open => {
      if (!open) window.requestAnimationFrame(updateCountryMenuPosition);
      return !open;
    });
  };

  useEffect(() => {
    if (!countryMenuOpen) return;
    const reposition = () => updateCountryMenuPosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    reposition();
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [countryMenuOpen]);

  const selectCountry = (country: CountryCode) => {
    const match = countries.find((item) => item.country === country);
    if (!match) return;
    setSelectedCountry(country);
    setCountryCode(`+${match.callingCode}`);
    setCountrySearch('');
    setCountryMenuOpen(false);
    focusPhoneInput();
  };

  const handleCountryCodeInput = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    setCountryCode(digits ? `+${digits}` : '');
    const match = countries
      .filter(item => item.callingCode === digits)
      .sort((a, b) => b.callingCode.length - a.callingCode.length)[0];
    if (match) setSelectedCountry(match.country);
  };

  useEffect(() => {
    if (loginMethod === 'qr') {
      startQrLogin();
    }
  }, [loginMethod]);

  useLayoutEffect(() => {
    const shell = stageShellRef.current;
    const content = stageContentRef.current;
    if (!shell || !content) return;

    const nextHeight = content.offsetHeight;
    const previousHeight = stageHeightRef.current;
    if (previousHeight === null) {
      stageHeightRef.current = nextHeight;
      setStageHeight(nextHeight);
      return;
    };

    if (previousHeight === nextHeight) return;

    shell.style.height = `${previousHeight}px`;
    shell.getBoundingClientRect();
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        stageHeightRef.current = nextHeight;
        shell.style.height = `${nextHeight}px`;
        setStageHeight(nextHeight);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [loginMethod, step, qrUrl, error]);

  useEffect(() => {
    if (step !== 'code') return;
    setResendSeconds(30);
    const timer = window.setInterval(() => {
      setResendSeconds(value => value > 0 ? value - 1 : 0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, phoneCodeHash]);

  const startQrLogin = async () => {
    try {
      const client = getTelegramClient('');
      setTempClient(client);
      await client.connect();

      await client.signInUserWithQrCode(
        { apiId: 4218382, apiHash: '2a4204685600e58d8cd9c04194ac005e' },
        {
          onError: (e) => {
            console.error("QR Error", e);
            setError(e.message);
          },
          qrCode: async (code) => {
            const base64Token = code.token.toString('base64');
            const base64urlToken = base64Token.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            const url = `tg://login?token=${base64urlToken}`;
            const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 256 });
            setQrUrl(qrDataUrl);
          }
        }
      );
      if (await client.checkAuthorization()) {
        await login(client);
        onSuccess?.();
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('Account has 2FA enabled')) {
        setStep('password');
      } else if (msg && msg !== 'Timeout') {
        setError(msg);
      }
    }
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedCountryCode = countryCode.replace(/\D/g, '');
    const normalizedLocalNumber = phoneNumber.replace(/\D/g, '');
    if (!normalizedCountryCode || normalizedLocalNumber.length < 4) {
      setError('Enter a valid country code and phone number.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = getTelegramClient('');
      setTempClient(client);
      await client.connect();
      
      const normalizedPhone = `+${normalizedCountryCode}${normalizedLocalNumber}`;
      const { phoneCodeHash } = await client.sendCode(
        { apiId: 4218382, apiHash: '2a4204685600e58d8cd9c04194ac005e' },
        normalizedPhone
      );
      setPhoneCodeHash(phoneCodeHash);
      setStep('code');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submitCode = async (submittedCode: string = code) => {
    if (loading || submittedCode.length !== 5) return;
    setLoading(true);
    setError('');
    setCodeVerified(false);
    setCodeError(false);
    try {
      await tempClient.invoke(new Api.auth.SignIn({
        phoneNumber: `+${countryCode.replace(/\D/g, '')}${phoneNumber.replace(/\D/g, '')}`,
        phoneCodeHash,
        phoneCode: submittedCode
      }));
      setCodeVerified(true);
      await new Promise(resolve => setTimeout(resolve, 500));
      await login(tempClient);
      onSuccess?.();
    } catch (err: any) {
      if (err.message.includes('SESSION_PASSWORD_NEEDED') || err.message.includes('Account has 2FA enabled')) {
        setStep('password');
      } else {
        setCodeError(true);
        setError('The code is incorrect or has expired. Please check Telegram and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCode();
  };

  const handleResendCode = async () => {
    if (resendSeconds > 0 || loading) return;
    setLoading(true);
    setError('');
    try {
      const normalizedPhone = `+${countryCode.replace(/\D/g, '')}${phoneNumber.replace(/\D/g, '')}`;
      const result = await tempClient.sendCode(
        { apiId: 4218382, apiHash: '2a4204685600e58d8cd9c04194ac005e' },
        normalizedPhone
      );
      setPhoneCodeHash(result.phoneCodeHash);
      setCode('');
      setCodeVerified(false);
      setCodeError(false);
      setResendSeconds(30);
      codeInputRefs.current[0]?.focus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await tempClient.signInWithPassword(
        { apiId: 4218382, apiHash: '2a4204685600e58d8cd9c04194ac005e' }, 
        { 
          password: async () => password, 
          onError: (err: any) => { throw err; } 
        }
      );
      await login(tempClient);
      onSuccess?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell h-[100dvh] overflow-hidden bg-drive-bg dark:bg-drive-darkbg flex items-center justify-center p-2 sm:p-4">
      <div className="login-card bg-white dark:bg-drive-darksurface rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1rem)] overflow-visible p-4 sm:p-8 border border-gray-100 dark:border-gray-800">
        <div className="text-center mb-4 sm:mb-8">
          <div className="w-20 h-20 sm:w-40 sm:h-40 mx-auto mb-2 sm:mb-5">
            <BrandLogo imageClassName="w-full h-full drop-shadow-2xl" />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-1 sm:mb-2">Connect to Telegram</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Securely login to access your Cloud Drive</p>
        </div>

        {error && (
          <div className={`mb-4 flex items-start gap-2 rounded-xl border p-3 text-sm shadow-sm animate-in fade-in slide-in-from-top-2 duration-300 ${
            codeError
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300'
              : 'border-red-200 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400'
          }`}>
            <span className="mt-0.5 text-base font-bold" aria-hidden="true">!</span>
            <span>{error}</span>
          </div>
        )}

        <div
          ref={stageShellRef}
          className="login-stage-shell"
          style={{ height: stageHeight === null ? 'auto' : `${stageHeight}px` }}
        >
        <div ref={stageContentRef} key={`${loginMethod}-${step}`} className="login-stage" data-login-stage={step}>
        {loginMethod === 'qr' && step === 'qr' ? (
          <div className="flex flex-col items-center">
            {qrUrl ? (
              <div className="bg-white p-4 rounded-xl shadow-sm mb-6 border">
                <img src={qrUrl} alt="QR Code" className="w-48 h-48" />
              </div>
            ) : (
              <div className="w-48 h-48 flex items-center justify-center mb-6">
                <div className="app-loader scale-90">
                  <VoxelLogoLoader />
                  <div className="app-loader__bar" />
                </div>
              </div>
            )}
            <p className="text-sm text-center text-gray-600 dark:text-gray-300 mb-6">
              1. Open Telegram on your phone<br/>
              2. Go to <b>Settings</b> {'>'} <b>Devices</b><br/>
              3. Tap <b>Link Desktop Device</b>
            </p>
            <button 
              onClick={() => { setLoginMethod('phone'); setStep('phone'); }}
              className="text-drive-primary dark:text-drive-darkprimary hover:underline text-sm font-medium"
            >
              Log in by phone number
            </button>
          </div>
        ) : (
          <div>
            {step === 'phone' && (
              <form onSubmit={handlePhoneSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone Number</label>
                  <div className="login-phone-fields flex items-center gap-3">
                    <div className="login-country-field flex h-12 w-[7rem] shrink-0 items-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50 text-gray-900 shadow-sm transition-colors focus-within:border-drive-primary focus-within:ring-2 focus-within:ring-drive-primary/20 dark:border-gray-700 dark:bg-[#131314] dark:text-white">
                      <button
                        type="button"
                        ref={countryButtonRef}
                        onClick={toggleCountryMenu}
                        className="flex h-full shrink-0 items-center gap-1.5 pl-3 text-gray-800 transition-colors hover:bg-gray-200/70 dark:text-gray-100 dark:hover:bg-gray-700/70"
                        aria-label="Choose country"
                      >
                        <span className="text-base leading-none">{flagForCountry(selectedCountry)}</span>
                      </button>
                      <input
                        ref={countryCodeInputRef}
                        type="tel"
                        inputMode="numeric"
                        value={countryCode}
                        onChange={e => handleCountryCodeInput(e.target.value)}
                        onFocus={() => countryCodeInputRef.current?.select()}
                        aria-label="Country calling code"
                        className="h-full min-w-0 flex-1 bg-transparent px-1 text-sm font-medium text-gray-900 outline-none placeholder:text-gray-400 dark:text-white"
                      />
                      <button
                        type="button"
                        onClick={toggleCountryMenu}
                        className="flex h-full items-center pr-2 text-gray-400"
                        aria-label="Open country menu"
                      >
                        <ChevronDown className={`h-4 w-4 transition-transform duration-300 ${countryMenuOpen ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                    <input
                      type="tel"
                      inputMode="tel"
                      ref={phoneInputRef}
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d\s()-]/g, ''))}
                      placeholder="Phone number"
                      aria-label="Phone number"
                      className="login-phone-input h-12 min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 text-gray-900 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-drive-primary focus:ring-2 focus:ring-drive-primary/20 dark:border-gray-700 dark:bg-[#131314] dark:text-white"
                      required
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">Tap the flag to choose a country or edit the calling code directly.</p>
                </div>
                <button
                  disabled={loading}
                  type="submit"
                  className="h-12 w-full rounded-xl bg-drive-primary text-white font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-md active:translate-y-0 disabled:hover:translate-y-0 flex justify-center items-center"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Next'}
                </button>
                <div className="text-center mt-4">
                  <button 
                    type="button"
                    onClick={() => { setLoginMethod('qr'); setStep('qr'); }}
                    className="text-drive-primary dark:text-drive-darkprimary hover:underline text-sm font-medium"
                  >
                    Log in by QR Code
                  </button>
                </div>
              </form>
            )}

            {step === 'code' && (
              <form onSubmit={handleCodeSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Login Code</label>
                  <div className="flex justify-center gap-2 sm:gap-3" dir="ltr">
                    {Array.from({ length: 5 }, (_, index) => (
                      <input
                        key={index}
                        ref={element => { codeInputRefs.current[index] = element; }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={code[index] || ''}
                        onChange={e => {
                          const digit = e.target.value.replace(/\D/g, '').slice(-1);
                          const next = code.split('');
                          next[index] = digit;
                          const nextCode = next.join('').slice(0, 5);
                          setCode(nextCode);
                          setCodeError(false);
                          if (digit && index < 4) codeInputRefs.current[index + 1]?.focus();
                          if (nextCode.length === 5) void submitCode(nextCode);
                        }}
                        onPaste={e => {
                          e.preventDefault();
                          const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 5);
                          setCode(pasted);
                          setCodeError(false);
                          codeInputRefs.current[Math.min(pasted.length, 4)]?.focus();
                          if (pasted.length === 5) void submitCode(pasted);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Backspace' && !code[index] && index > 0) codeInputRefs.current[index - 1]?.focus();
                        }}
                        className={`h-12 w-10 sm:h-14 sm:w-12 rounded-xl border-2 bg-gray-50 text-center text-xl font-bold outline-none transition-all dark:bg-[#131314] dark:text-white ${
                          codeError ? 'border-red-500 text-red-500 bg-red-50/70 dark:bg-red-950/30 animate-shake' :
                          codeVerified ? 'login-code-success border-emerald-400 text-emerald-400' :
                          code[index] ? 'border-drive-primary/80 shadow-[0_0_0_3px_rgba(59,130,246,0.12)]' :
                          'border-gray-200 dark:border-gray-700'
                        }`}
                        style={{ transitionDelay: codeVerified ? `${index * 70}ms` : '0ms' }}
                        aria-label={`Code digit ${index + 1}`}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">Enter the 5-digit code sent by Telegram.</p>
                </div>
                <button
                  disabled={loading || code.length !== 5}
                  type="submit"
                  className="w-full bg-drive-primary text-white py-2.5 rounded-xl font-medium hover:bg-blue-700 transition-colors flex justify-center items-center"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Verify'}
                </button>
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={loading || resendSeconds > 0}
                  className="w-full text-sm text-drive-primary dark:text-drive-darkprimary disabled:text-gray-400 disabled:no-underline hover:underline"
                >
                  {resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'}
                </button>
              </form>
            )}

            {step === 'password' && (
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Two-Step Verification</label>
                  <div className="relative">
                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="block min-w-0 w-full pl-10 pr-12 py-2.5 bg-gray-50 dark:bg-[#131314] border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-drive-primary focus:border-transparent dark:text-white outline-none transition-all"
                      required
                    />
                    <button type="button" onClick={() => setShowPassword(value => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:hover:text-white" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
                <button
                  disabled={loading}
                  type="submit"
                  className="w-full bg-drive-primary text-white py-2.5 rounded-xl font-medium hover:bg-blue-700 transition-colors flex justify-center items-center"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Submit'}
                </button>
              </form>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          
          {canInstall && (
            <button
              type="button"
              onClick={triggerInstall}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1 px-2.5 rounded-lg hover:bg-zinc-800/40"
            >
              <Smartphone className="w-3.5 h-3.5 text-red-400" />
              <span>Install App</span>
            </button>
          )}
        </div>
      </div>
      
      <PWAInstallModal
        isOpen={isInstallModalOpen || showIOSGuide}
        onClose={() => {
          setIsInstallModalOpen(false);
          setShowIOSGuide(false);
        }}
        isIOS={isIOS}
        isAndroid={isAndroid}
        hasNativePrompt={hasNativePrompt}
        onInstall={hasNativePrompt ? promptNativeInstall : triggerInstall}
      />
      </div>
      {countryMenuOpen && createPortal(
        <div
          className="country-menu-enter fixed z-[1000] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl shadow-slate-900/30 dark:border-gray-700 dark:bg-[#1c1c1e]"
          style={{ top: countryMenuPosition.top, left: countryMenuPosition.left, width: countryMenuPosition.width }}
        >
          <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <Search className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              autoFocus
              value={countrySearch}
              onChange={(e) => setCountrySearch(e.target.value)}
              placeholder="Search country or code"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none dark:text-white"
            />
          </div>
          <div className="max-h-[min(15rem,42dvh)] overflow-y-auto overscroll-contain p-1">
            {filteredCountries.map(({ country, name, callingCode, flag }) => (
              <button
                key={country}
                type="button"
                onClick={() => selectCountry(country)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <span className="w-6 text-lg">{flag}</span>
                <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{name}</span>
                <span className="text-gray-500 dark:text-gray-400">+{callingCode}</span>
              </button>
            ))}
            {filteredCountries.length === 0 && <p className="px-3 py-4 text-center text-sm text-gray-500">No country found</p>}
          </div>
        </div>,
        document.body
      )}
    </div>
    </div>
  );
};