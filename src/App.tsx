import { useState, useEffect, useRef } from 'react';
import { Play, FolderOpen, AlertCircle, CheckCircle, Settings, RefreshCw, XCircle, Search, Clock, Package, ChevronDown, X, Info, Loader2, Minimize, Sparkles } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import titlebarIcon from './assets/SSF.png';

interface Game {
  name: string;
  app_id: string;
  path: string;
  status: 'ready' | 'processing' | 'complete' | 'error';
  progress?: number;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ConfirmationModal {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface ShortcutFix {
  name: string;
  game_id: string;
  icon_url: string;
  location: string;
  success: boolean;
  error?: string;
}

// Games to filter out
const FILTERED_GAMES = [
  'Steamworks Common Redistributables',
  'Steam Linux Runtime',
  'Proton',
];

function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [filteredGames, setFilteredGames] = useState<Game[]>([]);
  const [steamappsPath, setSteamappsPath] = useState(localStorage.getItem('steamappsPath') || 'C:/Program Files (x86)/Steam/steamapps');
  const [selectedGames, setSelectedGames] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentProcessing, setCurrentProcessing] = useState<{ game: Game; step: string } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmationModal, setConfirmationModal] = useState<ConfirmationModal | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isQuickFixing, setIsQuickFixing] = useState(false);
  const [quickFixResults, setQuickFixResults] = useState<ShortcutFix[]>([]);
  const [showQuickFixResults, setShowQuickFixResults] = useState(false);
  const [toastCounter, setToastCounter] = useState(0);
  const hasInitialScanRun = useRef(false);

  const minimizeWindow = () => {
    getCurrentWindow().minimize();
  };

  const closeWindow = () => {
    getCurrentWindow().close();
  };

  const startDragging = async (e: any) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('button')) return;

    const win = await getCurrentWindow();
    await win.startDragging();
};

  useEffect(() => {
    loadGames();
  }, []);

  useEffect(() => {
    let filtered = games;
    
    // Filter out system games
    filtered = filtered.filter(g => 
      !FILTERED_GAMES.some(excluded => g.name.includes(excluded))
    );
    
    if (searchQuery) {
      filtered = filtered.filter(g => 
        g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        g.app_id.includes(searchQuery)
      );
    }
    
    if (filterStatus !== 'all') {
      filtered = filtered.filter(g => g.status === filterStatus);
    }
    
    setFilteredGames(filtered);
  }, [games, searchQuery, filterStatus]);

  useEffect(() => {
    localStorage.setItem('steamappsPath', steamappsPath);
  }, [steamappsPath]);

  const addToast = (message: string, type: Toast['type']) => {
    const id = Date.now() + toastCounter;
    setToastCounter(prev => prev + 1);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  
  const loadGames = async () => {
    try {
    setIsScanning(true);
    const scannedGames = await invoke<Game[]>('scan_games', { steamappsPath });
    const validGames = scannedGames.filter(g =>
        !FILTERED_GAMES.some(excluded => g.name.includes(excluded))
    );

    setGames(validGames.map(g => ({ ...g, status: 'ready', progress: 0 })));

    if (!hasInitialScanRun.current) {
        hasInitialScanRun.current = true;
    } else {
        addToast(`Found ${validGames.length} games across all libraries`, 'success');
    }
    } catch (err) {
    addToast(`Failed to scan games: ${err}`, 'error');
    } finally {
    setIsScanning(false);
    }
  };

  const selectSteamappsFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: steamappsPath,
      });
      
      if (selected && typeof selected === 'string') {
        setSteamappsPath(selected);
        addToast('Steam path updated', 'info');
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
    }
  };

  const toggleGame = (appId: string) => {
    const newSelected = new Set(selectedGames);
    if (newSelected.has(appId)) {
      newSelected.delete(appId);
    } else {
      newSelected.add(appId);
    }
    setSelectedGames(newSelected);
  };

  const selectAll = () => {
    if (selectedGames.size === filteredGames.length) {
      setSelectedGames(new Set());
    } else {
      setSelectedGames(new Set(filteredGames.map(g => g.app_id)));
    }
  };

  const updateGameStatus = (appId: string, status: Game['status'], progress?: number) => {
    setGames(prev => prev.map(g => 
      g.app_id === appId ? { ...g, status, progress: progress ?? g.progress } : g
    ));
  };

  const waitForConfirmation = (title: string, message: string): Promise<void> => {
    return new Promise((resolve) => {
      setConfirmationModal({
        title,
        message,
        onConfirm: () => {
          setConfirmationModal(null);
          resolve();
        }
      });
    });
  };

  const processGame = async (game: Game): Promise<boolean> => {
    try {
      updateGameStatus(game.app_id, 'processing', 0);

      // Step 1: Rename folder (20%)
      setCurrentProcessing({ game, step: 'Renaming game folder...' });
      updateGameStatus(game.app_id, 'processing', 20);
      const tempName = await invoke<string>('rename_game_folder', {
        steamappsPath,
        gamePath: game.path
      });

      // Step 2: Execute uninstall command (40%)
      setCurrentProcessing({ game, step: 'Opening Steam for uninstall...' });
      updateGameStatus(game.app_id, 'processing', 40);
      await invoke('open_steam_url', { url: `steam://uninstall/${game.app_id}` });
      
      // Step 3: Wait for user confirmation
      setCurrentProcessing({ game, step: 'Waiting for uninstall confirmation...' });
      await waitForConfirmation(
        `Uninstall ${game.name}`,
        'Please complete the uninstallation in Steam, then click Continue.'
      );

      // Step 4: Revert folder name (60%)
      setCurrentProcessing({ game, step: 'Restoring folder name...' });
      updateGameStatus(game.app_id, 'processing', 60);
      await invoke('revert_game_folder', { steamappsPath, tempName });

      // Step 5: Execute install command (80%)
      setCurrentProcessing({ game, step: 'Opening Steam for install...' });
      updateGameStatus(game.app_id, 'processing', 80);
      await invoke('open_steam_url', { url: `steam://install/${game.app_id}` });
      
      // Step 6: Wait for user confirmation
      setCurrentProcessing({ game, step: 'Waiting for install confirmation...' });
      await waitForConfirmation(
        `Install ${game.name}`,
        'Please start the installation in Steam, then click Continue.'
      );

      updateGameStatus(game.app_id, 'complete', 100);
      addToast(`✅ ${game.name} completed successfully`, 'success');
      return true;
    } catch (err) {
      updateGameStatus(game.app_id, 'error', 0);
      addToast(`❌ Failed to process ${game.name}: ${err}`, 'error');
      return false;
    }
  };

  const startProcess = async () => {
    if (selectedGames.size === 0) return;

    const gamesToProcess = games.filter(g => selectedGames.has(g.app_id));
    setIsProcessing(true);
    setShowConfirmModal(false);
    
    for (const game of gamesToProcess) {
      await processGame(game);
    }

    setIsProcessing(false);
    setCurrentProcessing(null);
    addToast('🎉 All games processed!', 'success');
  };

  const cleanupTempFolders = async () => {
    try {
      const cleaned = await invoke<string[]>('cleanup_temp_folders', { steamappsPath });
      
      if (cleaned.length > 0) {
        addToast(`Cleaned up ${cleaned.length} folder(s)`, 'success');
      } else {
        addToast('No temporary folders found', 'info');
      }
      
      await loadGames();
    } catch (err) {
      addToast(`Cleanup failed: ${err}`, 'error');
    }
  };

  const quickFixShortcuts = async () => {
    try {
      setIsQuickFixing(true);
      addToast('Scanning desktop shortcuts...', 'info');
      
      const results = await invoke<ShortcutFix[]>('quick_fix_shortcuts');
      
      setQuickFixResults(results);
      setShowQuickFixResults(true);
      
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      if (successCount > 0) {
        addToast(`✅ Fixed ${successCount} shortcut(s)!`, 'success');
      }
      if (failCount > 0) {
        addToast(`⚠️ ${failCount} shortcut(s) failed`, 'error');
      }
      if (results.length === 0) {
        addToast('No Steam shortcuts found on desktop', 'info');
      }
    } catch (err) {
      addToast(`Quick fix failed: ${err}`, 'error');
    } finally {
      setIsQuickFixing(false);
    }
  };

  const getStatusBadge = (status: Game['status']) => {
    const badges = {
      ready: { color: 'bg-gray-600', icon: Clock, text: 'Ready' },
      processing: { color: 'bg-blue-600', icon: Loader2, text: 'Processing' },
      complete: { color: 'bg-green-600', icon: CheckCircle, text: 'Complete' },
      error: { color: 'bg-red-600', icon: XCircle, text: 'Error' }
    };
    const badge = badges[status];
    const Icon = badge.icon;
    return (
      <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full ${badge.color} text-xs font-medium`}>
        <Icon className={`w-3.5 h-3.5 ${status === 'processing' ? 'animate-spin' : ''}`} />
        {badge.text}
      </div>
    );
  };

  const stats = {
    total: games.filter(g => !FILTERED_GAMES.some(excluded => g.name.includes(excluded))).length,
    selected: selectedGames.size,
    complete: games.filter(g => g.status === 'complete').length,
    processing: games.filter(g => g.status === 'processing').length,
    error: games.filter(g => g.status === 'error').length
  };

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden">
      <style>{`
        /* Custom Checkbox */
        input[type="checkbox"] {
          appearance: none;
          width: 1.25rem;
          height: 1.25rem;
          border: 2px solid #4b5563;
          border-radius: 0.375rem;
          background-color: #1f2937;
          cursor: pointer;
          position: relative;
          transition: all 0.2s;
        }
        
        input[type="checkbox"]:hover {
          border-color: #6b7280;
        }
        
        input[type="checkbox"]:checked {
          background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
          border-color: #3b82f6;
        }
        
        input[type="checkbox"]:checked::after {
          content: '';
          position: absolute;
          left: 6px;
          top: 2px;
          width: 5px;
          height: 10px;
          border: solid white;
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }

        /* Custom Scrollbar */
        .custom-scrollbar {
          padding-right: 4px;
        }
        
        .custom-scrollbar::-webkit-scrollbar {
          width: 10px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
          margin: 8px 0;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
          border-radius: 10px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
          background-clip: padding-box;
        }

        .custom-scrollbar-green::-webkit-scrollbar-thumb {
          background: linear-gradient(135deg, #22c55e 0%, #10b981 100%);
        }

        .custom-scrollbar-green::-webkit-scrollbar-thumb:hover {
         background: linear-gradient(135deg, #16a34a 0%, #059669 100%);
        }

      `}</style>

      {/* Custom Titlebar */}
      <div 
        onMouseDown={startDragging}
        className="flex items-center justify-between px-4 py-2 bg-slate-900/80 border-b border-gray-800 select-none cursor-move"
      >
        <div className="flex items-center gap-3 flex-1">
        <img
            src={titlebarIcon}
            alt="App icon"
            className="w-6 h-6"
            draggable={false}
        />
        <span className="text-sm font-semibold">Steam Shortcut Fixer</span>
        </div>
        <div className="flex items-center gap-1">
        <button
          data-tauri-drag-region="false"
          onClick={async () => minimizeWindow()}
          className="p-2 hover:bg-gray-700 rounded-lg">
            <Minimize className="w-4 h-4" />
          </button>
        <button
            data-tauri-drag-region="false"
            onClick={async () => closeWindow()}
            className="p-2 hover:bg-red-600 rounded-lg">
            <X className="w-4 h-4" />
        </button>
        </div>
      </div>

      {/* Toasts */}
      <div className="fixed top-16 right-4 z-50 space-y-2">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-xl backdrop-blur-sm animate-in slide-in-from-right ${
              toast.type === 'success' ? 'bg-green-500/90' :
              toast.type === 'error' ? 'bg-red-500/90' : 'bg-blue-500/90'
            }`}
          >
            <p className="text-sm font-medium">{toast.message}</p>
          </div>
        ))}
      </div>

      {/* Header Content */}
      <div className="flex-shrink-0 border-b border-gray-800 bg-slate-900/50 backdrop-blur-xl">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-gray-400">Repair broken shortcuts across all libraries</p>
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 transition-all hover:scale-105"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-5 gap-3">
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-lg p-3 border border-gray-700">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-gray-400">Total</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.total}</p>
            </div>
            <div className="bg-gradient-to-br from-blue-900/30 to-blue-800/20 rounded-lg p-3 border border-blue-700/50">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-gray-400">Selected</span>
              </div>
              <p className="text-2xl font-bold mt-1 text-blue-400">{stats.selected}</p>
            </div>
            <div className="bg-gradient-to-br from-green-900/30 to-green-800/20 rounded-lg p-3 border border-green-700/50">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-400" />
                <span className="text-xs text-gray-400">Complete</span>
              </div>
              <p className="text-2xl font-bold mt-1 text-green-400">{stats.complete}</p>
            </div>
            <div className="bg-gradient-to-br from-yellow-900/30 to-yellow-800/20 rounded-lg p-3 border border-yellow-700/50">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-yellow-400" />
                <span className="text-xs text-gray-400">Processing</span>
              </div>
              <p className="text-2xl font-bold mt-1 text-yellow-400">{stats.processing}</p>
            </div>
            <div className="bg-gradient-to-br from-red-900/30 to-red-800/20 rounded-lg p-3 border border-red-700/50">
              <div className="flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-400" />
                <span className="text-xs text-gray-400">Errors</span>
              </div>
              <p className="text-2xl font-bold mt-1 text-red-400">{stats.error}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area - Scrollable */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="px-6 py-4">
          {/* Settings Panel */}
          {showSettings && (
            <div className="mb-4 p-6 rounded-2xl bg-gradient-to-br from-gray-800 to-gray-900 border border-gray-700 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Settings
                </h3>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-gray-700 rounded-lg">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Steam Steamapps Folder</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={steamappsPath}
                      onChange={(e) => setSteamappsPath(e.target.value)}
                      className="flex-1 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500 text-white"
                    />
                    <button 
                      onClick={selectSteamappsFolder}
                      className="px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                    >
                      <FolderOpen className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={loadGames}
                    disabled={isScanning}
                    className="px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-600 disabled:to-gray-700 rounded-lg transition-all text-sm font-medium flex items-center gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                    Rescan Libraries
                  </button>
                  <button
                    onClick={cleanupTempFolders}
                    className="px-4 py-2 bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-700 hover:to-orange-700 rounded-lg transition-all text-sm font-medium"
                  >
                    Cleanup Temp Folders
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Search & Filter Bar */}
          <div className="mb-4 flex gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Search games by name or App ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-gray-800 border border-gray-700 rounded-xl focus:outline-none focus:border-blue-500 text-white placeholder-gray-500"
              />
            </div>
            <div className="relative">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="appearance-none pl-4 pr-10 py-3 bg-gray-800 border border-gray-700 rounded-xl focus:outline-none focus:border-blue-500 text-white cursor-pointer"
              >
                <option value="all">All Games</option>
                <option value="ready">Ready</option>
                <option value="processing">Processing</option>
                <option value="complete">Complete</option>
                <option value="error">Error</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Action Bar */}
          <div className="mb-4 space-y-3">
            {/* Quick Fix Bar */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-green-900/30 to-emerald-900/30 border border-green-700/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-green-500/20">
                    <Sparkles className="w-5 h-5 text-green-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-green-300">Quick Fix</h3>
                    <p className="text-xs text-green-400/80">Fixes missing icons in Desktop, Start Menu & OneDrive!</p>
                  </div>
                </div>
                <button
                  onClick={quickFixShortcuts}
                  disabled={isQuickFixing || isProcessing}
                  className="px-6 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:from-gray-600 disabled:to-gray-600 rounded-lg transition-all flex items-center gap-2 font-medium disabled:cursor-not-allowed shadow-lg"
                >
                  {isQuickFixing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Fixing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Quick Fix Icons
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Deep Repair Bar */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-gray-800 to-gray-900 border border-gray-700 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  onClick={selectAll}
                  disabled={filteredGames.length === 0}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg transition-colors text-sm font-medium"
                >
                  {selectedGames.size === filteredGames.length ? 'Deselect All' : 'Select All'}
                </button>
                <div>
                  <span className="text-gray-400 text-sm">
                    {selectedGames.size} of {filteredGames.length} selected
                  </span>
                  <p className="text-xs text-gray-500">For missing shortcuts or broken paths</p>
                </div>
              </div>
              <button
                onClick={() => setShowConfirmModal(true)}
                disabled={selectedGames.size === 0 || isProcessing || isQuickFixing}
                className="px-6 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-600 disabled:to-gray-600 rounded-lg transition-all flex items-center gap-2 font-medium disabled:cursor-not-allowed shadow-lg"
              >
                <Play className="w-4 h-4" />
                Deep Repair
              </button>
            </div>
          </div>

          {/* Current Processing Status */}
          {currentProcessing && (
            <div className="mb-4 p-6 rounded-2xl bg-gradient-to-br from-blue-900/30 to-purple-900/30 border border-blue-700/50 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                  <div>
                    <h3 className="font-semibold text-lg">{currentProcessing.game.name}</h3>
                    <p className="text-sm text-gray-400">{currentProcessing.step}</p>
                  </div>
                </div>
                <span className="text-2xl font-bold text-blue-400">{currentProcessing.game.progress}%</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500"
                  style={{ width: `${currentProcessing.game.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Games List */}
          {filteredGames.length === 0 ? (
            <div className="text-center py-20">
              <Package className="w-16 h-16 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-500 text-lg">
                {games.length === 0 ? 'No games found. Check your Steam path in settings.' : 'No games match your filters.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3 pb-4">
              {filteredGames.map(game => (
                <div
                  key={game.app_id}
                  onClick={() => !isProcessing && toggleGame(game.app_id)}
                  className={`group p-5 rounded-xl border transition-all cursor-pointer ${
                    selectedGames.has(game.app_id)
                      ? 'bg-gradient-to-r from-blue-900/30 to-purple-900/30 border-blue-500/50'
                      : 'bg-gradient-to-br from-gray-800 to-gray-900 border-gray-700 hover:border-gray-600 hover:scale-[1.005]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <input
                        type="checkbox"
                        checked={selectedGames.has(game.app_id)}
                        onChange={() => {}}
                      />
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg group-hover:text-blue-400 transition-colors">{game.name}</h3>
                        <div className="flex items-center gap-4 mt-1">
                          <span className="text-sm text-gray-400">AppID: {game.app_id}</span>
                          <span className="text-sm text-gray-500">{game.path}</span>
                        </div>
                        {game.status === 'processing' && game.progress !== undefined && (
                          <div className="mt-2">
                            <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                              <div 
                                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                                style={{ width: `${game.progress}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    {getStatusBadge(game.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Info Footer - Fixed at bottom */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-slate-900/50">
        <div className="px-6 py-3">
          <div className="flex gap-3">
            <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-blue-200/80">
              <p className="font-medium mb-0.5 text-blue-300">💡 Quick Fix: Missing icons? Use this! | Deep Repair: Shortcuts don't exist at all? Use this!</p>
            </div>
          </div>
        </div>
      </div>

      {/* Start Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl border border-gray-700 p-6 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-xl bg-yellow-500/20">
                <AlertCircle className="w-6 h-6 text-yellow-400" />
              </div>
              <h3 className="text-xl font-bold">Confirm Deep Repair</h3>
            </div>
            <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
              <p className="text-sm text-blue-300">
                ⚡ <strong>Already tried Quick Fix?</strong> Deep Repair is for when shortcuts don't exist at all.
              </p>
            </div>
            <p className="text-gray-300 mb-6">
              You're about to deep repair <span className="font-bold text-blue-400">{selectedGames.size} game(s)</span>. This will:
            </p>
            <ol className="space-y-2 mb-6 text-sm text-gray-400">
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold">1.</span>
                <span>Temporarily rename each game folder</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold">2.</span>
                <span>Open Steam to uninstall (you'll need to confirm)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold">3.</span>
                <span>Restore original folder names</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-blue-400 font-bold">4.</span>
                <span>Open Steam to reinstall (you'll need to confirm)</span>
              </li>
            </ol>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={startProcess}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-lg transition-all font-medium shadow-lg"
              >
                Let's Go!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Confirmation Modal (during process) */}
      {confirmationModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl border border-blue-600 p-6 max-w-md w-full shadow-2xl animate-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-xl bg-blue-500/20">
                <AlertCircle className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold">{confirmationModal.title}</h3>
            </div>
            <p className="text-gray-300 mb-6 text-lg">
              {confirmationModal.message}
            </p>
            <button
              onClick={confirmationModal.onConfirm}
              className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-lg transition-all font-medium shadow-lg text-lg"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Quick Fix Results Modal */}
      {showQuickFixResults && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl border border-green-600 p-6 max-w-2xl w-full shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-green-500/20">
                  <Sparkles className="w-6 h-6 text-green-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold">Quick Fix Results</h3>
                  <p className="text-sm text-gray-400">
                    {quickFixResults.filter(r => r.success).length} fixed, {quickFixResults.filter(r => !r.success).length} failed
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowQuickFixResults(false)}
                className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar custom-scrollbar-green space-y-2">
              {quickFixResults.map((result, index) => (
                <div
                  key={index}
                  className={`p-4 rounded-lg border ${
                    result.success
                      ? 'bg-green-900/20 border-green-700/50'
                      : 'bg-red-900/20 border-red-700/50'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {result.success ? (
                          <CheckCircle className="w-4 h-4 text-green-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400" />
                        )}
                        <h4 className="font-semibold text-sm">{result.name}</h4>
                      </div>
                      {result.success ? (
                        <div className="space-y-0.5">
                          <p className="text-xs text-gray-400">Game ID: {result.game_id}</p>
                          <p className="text-xs text-gray-500">Location: {result.location}</p>
                        </div>
                      ) : (
                        <p className="text-xs text-red-400">{result.error}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => setShowQuickFixResults(false)}
              className="mt-4 w-full px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 rounded-lg transition-all font-medium shadow-lg"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;