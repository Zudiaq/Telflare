import { useTelegram } from './context/TelegramContext';
import { Login } from './components/Login';
import { DriveUI } from './components/DriveUI';
import { VoxelLogoLoader } from './components/VoxelLogoLoader';
import { MusicPlayerProvider } from './context/MusicPlayerContext';

/* ============================================================================
 * COMPONENT: App
 * Root application container: Telegram auth gating and music provider shell.
 * ============================================================================ */
function App() {
  const { isAuthenticated, isConnecting, connectionError, retryConnection } = useTelegram();

  if (isConnecting) {
    return (
      <div className="h-full h-[100dvh] w-full bg-drive-bg dark:bg-drive-darkbg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="app-loader">
            <VoxelLogoLoader />
            <div className="app-loader__bar" />
          </div>
          <p className="text-gray-500 dark:text-gray-400 font-medium">Restoring session...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated && connectionError) {
    return (
      <div className="h-full h-[100dvh] w-full bg-drive-bg dark:bg-drive-darkbg flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <VoxelLogoLoader />
          <h2 className="text-white text-lg font-semibold">Connection interrupted</h2>
          <p className="text-gray-400 text-xs leading-relaxed">
            Your saved session is safe, but the initial Cloudflare edge handshake timed out.
          </p>
          <button
            type="button"
            onClick={retryConnection}
            className="px-5 py-2.5 rounded-xl bg-[#9A2227] hover:bg-[#b52a30] active:scale-95 text-white text-sm font-medium transition-all shadow-lg"
          >
            Reconnect now
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <MusicPlayerProvider>
      <div className="relative h-full h-[100dvh] w-full overflow-hidden bg-drive-bg dark:bg-drive-darkbg flex flex-col text-drive-text dark:text-drive-darktext">
        <DriveUI />
      </div>
    </MusicPlayerProvider>
  );
}

export default App;
