import React from 'react';
import { X, Smartphone, Download, Share2, PlusSquare, CheckCircle2, ShieldCheck, Zap, Compass, MoreVertical, Globe, Check } from 'lucide-react';

interface PWAInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  isIOS: boolean;
  isAndroid: boolean;
  isFirefox?: boolean;
  isSamsung?: boolean;
  isChrome?: boolean;
  isSafari?: boolean;
  hasNativePrompt?: boolean;
  onInstall: () => void;
}

export const PWAInstallModal: React.FC<PWAInstallModalProps> = ({
  isOpen,
  onClose,
  isIOS,
  isAndroid,
  isFirefox,
  isSamsung,
  isChrome,
  isSafari,
  hasNativePrompt,
  onInstall,
}) => {
  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div 
        className="relative w-full max-w-md rounded-2xl bg-[#1e1e20] border border-zinc-800 p-6 shadow-2xl text-zinc-100 flex flex-col gap-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 shadow-inner">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-lg text-white">Install ZUD Cloud App</h3>
              <p className="text-xs text-zinc-400">Progressive Web App for Mobile</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* App Showcase Card */}
        <div className="flex items-center gap-3.5 p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 shadow-sm">
          <img 
            src="/icons/icon-192.png" 
            alt="ZUD Cloud" 
            className="w-12 h-12 rounded-xl shadow-md border border-zinc-700/50 object-cover" 
          />
          <div className="min-w-0 flex-1">
            <h4 className="font-bold text-sm text-white">ZUD Cloud Mobile</h4>
            <p className="text-xs text-zinc-400">Standalone Virtual Cloud & Ultra-Fast Media Player</p>
          </div>
        </div>

        {/* Benefits list */}
        <div className="grid grid-cols-2 gap-2 text-xs text-zinc-300">
          <div className="flex items-center gap-2 p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
            <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>Fast Native Speed</span>
          </div>
          <div className="flex items-center gap-2 p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Unfiltered Proxy</span>
          </div>
          <div className="flex items-center gap-2 p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
            <CheckCircle2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Full-screen Video</span>
          </div>
          <div className="flex items-center gap-2 p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
            <CheckCircle2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Background Playback</span>
          </div>
        </div>

        {/* Platform & Browser Specific Instructions */}
        {hasNativePrompt ? (
          <div className="flex flex-col gap-2.5 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-200">
            <h5 className="font-semibold text-white flex items-center gap-1.5 text-sm">
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Native App Installer Ready</span>
            </h5>
            <p className="text-zinc-300 leading-relaxed">
              Click <strong className="text-white">Install Now</strong> below to trigger your browser's native installation prompt and add ZUD Cloud to your home screen.
            </p>
          </div>
        ) : isIOS || isSafari ? (
          <div className="flex flex-col gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-200">
            <h5 className="font-semibold text-white flex items-center gap-1.5 text-sm">
              <Compass className="w-4 h-4 text-blue-400" />
              <span>Safari / iOS Instructions:</span>
            </h5>
            <ol className="flex flex-col gap-2.5 list-none p-0 m-0 text-zinc-300">
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">1</span>
                <span>Tap the <strong className="text-white">Share</strong> button <Share2 className="w-3.5 h-3.5 text-blue-400 inline mx-1" /> on your browser toolbar.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">2</span>
                <span>Scroll down and tap <strong className="text-white">Add to Home Screen</strong> <PlusSquare className="w-3.5 h-3.5 text-emerald-400 inline mx-1" />.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">3</span>
                <span>Tap <strong className="text-white">Add</strong> in the top-right corner to launch directly from your home screen.</span>
              </li>
            </ol>
          </div>
        ) : isFirefox ? (
          <div className="flex flex-col gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200">
            <h5 className="font-semibold text-white flex items-center gap-1.5 text-sm">
              <Globe className="w-4 h-4 text-amber-400" />
              <span>Firefox Android Instructions:</span>
            </h5>
            <ol className="flex flex-col gap-2.5 list-none p-0 m-0 text-zinc-300">
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">1</span>
                <span>Look for the <strong className="text-white">Install</strong> icon in the address bar, or tap the <strong className="text-white">Menu (⋮)</strong> button.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">2</span>
                <span>Tap <strong className="text-white">Install</strong> or <strong className="text-white">Add to Home screen</strong>.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">3</span>
                <span>Confirm installation to launch ZUD Cloud as a standalone mobile app.</span>
              </li>
            </ol>
          </div>
        ) : isSamsung ? (
          <div className="flex flex-col gap-3 p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-200">
            <h5 className="font-semibold text-white flex items-center gap-1.5 text-sm">
              <Globe className="w-4 h-4 text-purple-400" />
              <span>Samsung Internet Instructions:</span>
            </h5>
            <ol className="flex flex-col gap-2.5 list-none p-0 m-0 text-zinc-300">
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">1</span>
                <span>Look for the <strong className="text-white">Download (↓)</strong> icon in the address bar, or tap the <strong className="text-white">Menu (≡)</strong> at the bottom right.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">2</span>
                <span>Tap <strong className="text-white">+ Add page to</strong> and choose <strong className="text-white">App screen</strong> or <strong className="text-white">Home screen</strong>.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">3</span>
                <span>Tap <strong className="text-white">Install</strong> to complete.</span>
              </li>
            </ol>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-900/70 border border-zinc-800/80 text-xs text-zinc-300">
            <h5 className="font-semibold text-white flex items-center gap-1.5 text-sm">
              <MoreVertical className="w-4 h-4 text-red-400" />
              <span>{isChrome ? 'Chrome Android Instructions:' : isAndroid ? 'Android Browser Instructions:' : 'Mobile Browser Instructions:'}</span>
            </h5>
            <ol className="flex flex-col gap-2 list-none p-0 m-0 text-zinc-300">
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-red-500/20 text-red-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">1</span>
                <span>Tap your browser's <strong className="text-white">Menu (three dots ⋮)</strong> in the top or bottom corner.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-red-500/20 text-red-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">2</span>
                <span>Select <strong className="text-white">Install app</strong> or <strong className="text-white">Add to Home screen</strong>.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-red-500/20 text-red-300 font-bold flex items-center justify-center shrink-0 text-[11px] mt-0.5">3</span>
                <span>Confirm to enjoy a seamless full-screen standalone experience.</span>
              </li>
            </ol>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2.5 border-t border-zinc-800/80 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
          >
            Close
          </button>
          
          {hasNativePrompt ? (
            <button
              type="button"
              onClick={onInstall}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/25 transition-all flex items-center gap-1.5 active:scale-95"
            >
              <Download className="w-4 h-4" />
              <span>Install Now</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/25 transition-all flex items-center gap-1.5 active:scale-95"
            >
              <Check className="w-4 h-4" />
              <span>Got it, Close</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
