import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  RefreshCw,
  Terminal,
  Link2,
  Plus,
  Trash2,
  Shield,
  Send,
  Sliders,
  BookOpen,
  Clock,
  AlertTriangle,
  CheckCircle,
  Radio,
  Bell,
  Cpu,
  FileText,
  UserCheck,
  ChevronRight,
  Info
} from 'lucide-react';
import { KworkProject, KworkCategory, LogEntry, ParserStatus } from './types';

export default function App() {
  // Parser and Settings state
  const [status, setStatus] = useState<ParserStatus>({
    isParsingActive: false,
    activeCategoriesCount: 0,
    totalParsedProjectsCount: 0,
    totalSentAlertsCount: 0,
    uptimeSeconds: 0,
    lastRunTimestamp: null,
    errorCount: 0
  });

  const [settings, setSettings] = useState({
    vkToken: '',
    vkConfirmCode: '',
    vkGroupChatId: '',
    adminIds: [] as string[],
    isParsingActive: false,
    intervalMinutes: 2
  });

  // Data feeds
  const [categories, setCategories] = useState<KworkCategory[]>([]);
  const [projects, setProjects] = useState<KworkProject[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  
  // Terminal log filter
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'success' | 'warning' | 'error'>('all');

  // Interactive inputs
  const [newUrl, setNewUrl] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [adminIdsInput, setAdminIdsInput] = useState('');
  
  // Loading and Notification States
  const [isSubmitLoading, setIsSubmitLoading] = useState(false);
  const [isTestLoading, setIsTestLoading] = useState(false);
  const [messageToast, setMessageToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Auto-scrolling terminal ref
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);

  // Poll state from server APIs
  const fetchStatusAndSettings = async () => {
    try {
      const response = await fetch('/api/status');
      if (response.ok) {
        const data = await response.json();
        setStatus(data.status);
        setSettings(data.settings);
        setAdminIdsInput(data.settings.adminIds.join(', '));
      }
    } catch (e) {
      console.error('Failed to resolve parser status API', e);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await fetch('/api/categories');
      if (response.ok) {
        const data = await response.json();
        setCategories(data);
      }
    } catch (e) {
      console.error('Failed to resolve categories list API', e);
    }
  };

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (e) {
      console.error('Failed to resolve projects log API', e);
    }
  };

  const fetchLogs = async () => {
    try {
      const response = await fetch('/api/logs');
      if (response.ok) {
        const data = await response.json();
        setLogs(data);
      }
    } catch (e) {
      console.error('Failed to resolve engineering logs API', e);
    }
  };

  // Run initial state loading and setup periodic fast pollers
  useEffect(() => {
    fetchStatusAndSettings();
    fetchCategories();
    fetchProjects();
    fetchLogs();

    const fastInterval = setInterval(() => {
      fetchStatusAndSettings();
      fetchLogs();
    }, 4000);

    const normalInterval = setInterval(() => {
      fetchCategories();
      fetchProjects();
    }, 10000);

    return () => {
      clearInterval(fastInterval);
      clearInterval(normalInterval);
    };
  }, []);

  // Auto scroll logs console to bottom
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [logs, logFilter]);

  // Show status feedback banners helper
  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setMessageToast({ text, type });
    setTimeout(() => setMessageToast(null), 4000);
  };

  // Core controller actions
  const toggleParser = async () => {
    try {
      const response = await fetch('/api/control/toggle', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setStatus(prev => ({ ...prev, isParsingActive: data.isParsingActive }));
        showToast(
          data.isParsingActive 
            ? 'Парсинг успешно ЗАПУЩЕН! Начат регулярный опрос категорий.' 
            : 'Парсинг ОСТАНОВЛЕН вручную. Кэш проектов в базе данных сброшен!',
          data.isParsingActive ? 'success' : 'error'
        );
        // refresh data states
        fetchStatusAndSettings();
        fetchProjects();
        fetchLogs();
      }
    } catch (e) {
      showToast('Не удалось переключить режим работы парсера.', 'error');
    }
  };

  // Clear stored projects manually
  const clearDatabase = async () => {
    if (!window.confirm('Вы действительно хотите полностью очистить накопленный кэш проектов? Все новые заявки придется собирать заново.')) {
      return;
    }
    try {
      const response = await fetch('/api/control/clear-db', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        showToast(`Успешно очищено ${data.clearedCount} записей из базы проектов.`);
        fetchStatusAndSettings();
        fetchProjects();
        fetchLogs();
      }
    } catch (e) {
      showToast('Ошибка очистки базы.', 'error');
    }
  };

  // Simulate weekly DB swap
  const forceWeeklyReset = async () => {
    try {
      const response = await fetch('/api/control/weekly-reset', { method: 'POST' });
      if (response.ok) {
        showToast('Еженедельный сброс имитирован успешно. Проекты очищены.');
        fetchStatusAndSettings();
        fetchProjects();
      }
    } catch (e) {
      showToast('Ошибка симуляции сброса.', 'error');
    }
  };

  // Send a test message via VK Channel API
  const testVkConnection = async () => {
    setIsTestLoading(true);
    try {
      const response = await fetch('/api/control/test-vk', { method: 'POST' });
      const data = await response.json();
      if (response.ok) {
        showToast('Тестовое сообщение успешно отправлено на ваши VK ID!');
      } else {
        showToast(data.error || 'Ошибка проверки ВК-оповещения', 'error');
      }
    } catch (e) {
      showToast('Ошибка связи с сервером VK.', 'error');
    } finally {
      setIsTestLoading(false);
    }
  };

  // Save Settings Changes (Tokens, admin ids, delays)
  const saveConfiguration = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitLoading(true);
    try {
      const payload = {
        vkToken: settings.vkToken,
        vkConfirmCode: settings.vkConfirmCode,
        vkGroupChatId: settings.vkGroupChatId,
        adminIds: adminIdsInput.split(',').map(x => x.trim()).filter(Boolean),
        intervalMinutes: settings.intervalMinutes
      };

      const response = await fetch('/api/control/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        showToast('Настройки бота успешно синхронизированы!');
        fetchStatusAndSettings();
      } else {
        showToast('Не удалось сохранить настройки на сервере.', 'error');
      }
    } catch (e) {
      showToast('Ошибка отправки конфигурации.', 'error');
    } finally {
      setIsSubmitLoading(false);
    }
  };

  // Add Category URL
  const addNewCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl || !newUrl.startsWith('https://kwork.ru/')) {
      showToast('Ссылка должна быть корректной и вести на домен https://kwork.ru/', 'error');
      return;
    }

    try {
      const response = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl,
          name: newCatName.trim() || undefined
        })
      });

      const data = await response.json();
      if (response.ok) {
        showToast(`Ссылка добавлена: "${data.name}"`);
        setNewUrl('');
        setNewCatName('');
        fetchCategories();
        fetchProjects();
        fetchStatusAndSettings();
      } else {
        showToast(data.error || 'Ошибка добавления ссылки', 'error');
      }
    } catch (e) {
      showToast('Не удалось установить новую категорию.', 'error');
    }
  };

  // Delete Category URL
  const deleteCategory = async (id: string, name: string) => {
    if (!window.confirm(`Вы уверены, что хотите удалить ссылку "${name}"? Все спарсенные заказы по этой ссылке будут стёрты из базы!`)) {
      return;
    }

    try {
      const response = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      if (response.ok) {
        const data = await response.json();
        showToast(`Категория удалена. Стерто связанных проектов: ${data.erasedCount}`);
        fetchCategories();
        fetchProjects();
        fetchStatusAndSettings();
      } else {
        showToast('Ошибка при удалении ссылки.', 'error');
      }
    } catch (e) {
      showToast('Связь с сервером прервана.', 'error');
    }
  };

  // Filter logs logic
  const filteredLogs = logs.filter(log => {
    if (logFilter === 'all') return true;
    return log.type === logFilter;
  });

  // Calculate beautiful relative duration string
  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    
    const parts = [];
    if (d > 0) parts.push(`${d}д`);
    if (h > 0 || d > 0) parts.push(`${h}ч`);
    if (m > 0 || h > 0 || d > 0) parts.push(`${m}м`);
    parts.push(`${s}с`);
    return parts.join(' ');
  };

  return (
    <div id="kwork_parser_root" className="min-h-screen bg-[#f8fafc] text-slate-800 font-sans">
      {/* Visual background gradient accents */}
      <div className="absolute top-0 left-0 right-0 h-64 bg-slate-900 z-0"></div>

      {/* Main Container Area */}
      <div className="relative max-w-7xl mx-auto px-4 py-8 z-10">
        
        {/* Responsive Layout Toast Banner notifications */}
        {messageToast && (
          <div
            id="toast_banner"
            className={`fixed top-6 right-6 px-5 py-3.5 rounded-xl shadow-2xl z-50 text-white font-medium flex items-center gap-3 animate-bounce max-w-md ${
              messageToast.type === 'success' ? 'bg-[#22c55e]' : 'bg-[#ef4444]'
            }`}
          >
            {messageToast.type === 'success' ? (
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            )}
            <span>{messageToast.text}</span>
          </div>
        )}

        {/* Console Header */}
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-1.5">
              <Cpu className="w-4 h-4 text-indigo-400" />
              <span>Фриланс Мониторинг консоль</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight leading-none">
              Кворк.ру Парсер & ВК Бот
            </h1>
            <p className="text-slate-400 text-sm mt-1.5 max-w-xl">
              Парсит выбранные категории Kwork.ru по прямым ссылкам на предмет новых заявок и мгновенно пересылает в чат сообщества VK.
            </p>
          </div>

          {/* Quick status box */}
          <div className="bg-slate-800/80 border border-slate-700/80 backdrop-blur-md rounded-2xl p-4 flex items-center gap-4 text-white">
            <div className="relative flex items-center justify-center">
              <span className={`absolute flex h-3.5 w-3.5 rounded-full ${status.isParsingActive ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}`}></span>
              <span className={`relative rounded-full h-3.5 w-3.5 ${status.isParsingActive ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Статус парсинга</div>
              <div className="text-sm font-bold tracking-wide">
                {status.isParsingActive ? 'АКТИВЕН И РАБОТАЕТ' : 'ОСТАНОВЛЕН'}
              </div>
            </div>
            <button
              id="header_toggle_btn"
              onClick={toggleParser}
              className={`ml-2 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                status.isParsingActive
                  ? 'bg-rose-500 hover:bg-rose-600 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-600 text-white'
              }`}
            >
              {status.isParsingActive ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>Стоп</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Старт</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Dashboard Grid Cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div id="stat_card_uptime" className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" /> Аптайм
            </span>
            <div className="text-xl font-bold mt-1 text-slate-800 font-mono">
              {formatUptime(status.uptimeSeconds)}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Непрерывная работа веб-сервера</div>
          </div>

          <div id="stat_card_links" className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase flex items-center gap-1">
              <Link2 className="w-3.5 h-3.5 text-indigo-500" /> Ссылок в работе
            </span>
            <div className="text-2xl font-bold mt-1 text-indigo-600">
              {status.activeCategoriesCount} <span className="text-sm font-normal text-slate-400">из 10 max</span>
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Количество сканируемых страниц</div>
          </div>

          <div id="stat_card_db" className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase flex items-center gap-1">
              <FileText className="w-3.5 h-3.5 text-emerald-500" /> Проектов в базе
            </span>
            <div className="text-2xl font-bold mt-1 text-emerald-600">
              {status.totalParsedProjectsCount}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Всего известных боту заказов</div>
          </div>

          <div id="stat_card_alerts" className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-sm">
            <span className="text-slate-400 text-xs font-semibold uppercase flex items-center gap-1">
              <Bell className="w-3.5 h-3.5 text-amber-500" /> Отправлено в ВК
            </span>
            <div className="text-2xl font-bold mt-1 text-amber-600">
              {status.totalSentAlertsCount}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Оповещено администраторов</div>
          </div>
        </section>

        {/* Content Layout Body Split */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* LEFT SIDEBAR CONTROLS COLUMN (7 SPACES) */}
          <div className="lg:col-span-7 flex flex-col gap-8">
            
            {/* LINK MANAGER FOR SCANNED KWORK CATEGORIES */}
            <div id="category_list_box" className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <Link2 className="w-5 h-5 text-indigo-500" /> Ссылки для мониторинга проектов
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Категории Kwork, которые будут циклически опрашиваться на предмет новых заказов.
                  </p>
                </div>
                <span className="bg-indigo-50 text-indigo-600 font-bold px-2.5 py-1 text-xs rounded-full">
                  {categories.length} активных
                </span>
              </div>

              <div className="p-5 bg-slate-50 border-b border-slate-100">
                {/* Add Category Form */}
                <form onSubmit={addNewCategory} className="flex flex-col md:flex-row gap-3">
                  <div className="flex-1">
                    <input
                      type="text"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-slate-400"
                      placeholder="Напр., https://kwork.ru/projects?c=11"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="w-full md:w-48">
                    <input
                      type="text"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-slate-400"
                      placeholder="Метка (Разработка, Дизайн)"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm px-5 py-2.5 rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-1.5 flex-shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Добавить</span>
                  </button>
                </form>
                <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                  <span>После добавления ссылки бот сразу произведет первичный фоновый сбор проектов, чтобы не спамить вас старыми заказами.</span>
                </div>
              </div>

              {/* Added Categories List View */}
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {categories.length === 0 ? (
                  <div className="p-8 text-center text-slate-400">
                    <AlertTriangle className="w-10 h-10 mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium">Нет настроенных ссылок</p>
                    <p className="text-xs mt-1 max-w-sm mx-auto">Добавьте kwork.ru проекты по ссылке во встроенной форме выше, чтобы бот начал отслеживание!</p>
                  </div>
                ) : (
                  categories.map((c, i) => (
                    <div key={c.id} className="p-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">
                      <div className="min-w-0 pr-4 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 text-xs font-semibold font-mono">#{i + 1}</span>
                          <span className="text-sm font-bold text-slate-800 truncate">{c.name}</span>
                          <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-md font-mono flex-shrink-0">
                            {new Date(c.addedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 truncate mt-1 hover:text-indigo-600">
                          <a href={c.url} target="_blank" rel="noreferrer" className="underline whitespace-normal break-all select-all font-mono">
                            {c.url}
                          </a>
                        </div>
                      </div>
                      <button
                        onClick={() => deleteCategory(c.id, c.name)}
                        className="text-rose-400 hover:text-rose-600 hover:bg-rose-50 p-2 rounded-xl transition-all cursor-pointer"
                        title="Удалить ссылку из мониторинга"
                      >
                        <Trash2 className="w-4.5 h-4.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* INTEGRATION SETTINGS PANEL (VK GROUP APIS) */}
            <div id="vk_settings_box" className="bg-white border border-slate-200 rounded-2xl shadow-sm">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <Sliders className="w-5 h-5 text-indigo-500" /> Настройки интеграции VK и Парсинга
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Управляйте токенами авторизации и правами доступа ваших друзей к боту.
                  </p>
                </div>
                <span className="text-indigo-600 text-xs bg-indigo-50 px-2.5 py-1 rounded-full font-bold flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5" /> Безопасно
                </span>
              </div>

              <form onSubmit={saveConfiguration} className="p-5 flex flex-col gap-5">
                
                {/* VK Access Group Token Column */}
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                    Ключ доступа группы (VK_TOKEN) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="password"
                    className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono placeholder:text-slate-400"
                    placeholder="Токен (vk1.a.xxxxxxxxx...)"
                    value={settings.vkToken}
                    onChange={(e) => setSettings(prev => ({ ...prev, vkToken: e.target.value }))}
                    required
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    Строка токена, генерируемая в Настройках вашего Сообщества ВК (Работа с API &rarr; Ключи доступа).
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Callback confirmations */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                      Строка подтверждения Callback API
                    </label>
                    <input
                      type="text"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                      placeholder="Код (напр., a82bc3cb)"
                      value={settings.vkConfirmCode}
                      onChange={(e) => setSettings(prev => ({ ...prev, vkConfirmCode: e.target.value }))}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Строка, которую возвращает бот при проверке ВК-сервером Callback API.
                    </p>
                  </div>

                  {/* Group Chat ID/Target User ID */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                      ID Чат группы / Получателя ВК
                    </label>
                    <input
                      type="text"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                      placeholder="Peer ID получетеля (напр., 2000000001)"
                      value={settings.vkGroupChatId}
                      onChange={(e) => setSettings(prev => ({ ...prev, vkGroupChatId: e.target.value }))}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Если вы хотите высылать alert-ы в групповую беседу, укажите её Peer ID здесь. Если пустой, отсылает админам.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Commma Sep Authorized ID-s */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                      Разрешенные VK ID (Администраторы)
                    </label>
                    <input
                      type="text"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                      placeholder="12345, 67890"
                      value={adminIdsInput}
                      onChange={(e) => setAdminIdsInput(e.target.value)}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Список через запятую ID пользователей, которым бот будет доверять команды управления.
                    </p>
                  </div>

                  {/* Interval in minutes */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1.5">
                      Интервал проверок Kwork (в минутах)
                    </label>
                    <input
                      type="number"
                      min="1"
                      className="w-full text-sm bg-white border border-slate-300 rounded-xl px-4 py-2.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                      value={settings.intervalMinutes}
                      onChange={(e) => setSettings(prev => ({ ...prev, intervalMinutes: parseInt(e.target.value, 10) }))}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">
                      Оптимально 2-3 минуты. Рандомизированный джиттер (+/- 10 сек) применяется автоматически.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-100">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={testVkConnection}
                      disabled={isTestLoading}
                      className="bg-sky-500 hover:bg-sky-600 text-white font-bold text-xs px-4 py-2 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      {isTestLoading ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Проверить ВК</span>
                    </button>
                    
                    <button
                      type="button"
                      onClick={clearDatabase}
                      className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs px-4 py-2 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5"
                      title="Очистить только спарсенные заказы"
                    >
                      <span>Очистить базу</span>
                    </button>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitLoading}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-5 py-2.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 ml-auto"
                  >
                    {isSubmitLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    <span>Сохранить настройки</span>
                  </button>
                </div>
              </form>
            </div>
            
            {/* LINUX UBUNTU 24 DEPLOYMENT INSTRUCTION CARD */}
            <div id="ubuntu_guide_box" className="bg-white border border-slate-200 rounded-2xl shadow-sm text-slate-600">
              <div className="p-5 border-b border-slate-100 bg-[#fafafa]">
                <h3 className="font-bold text-slate-900 flex items-center gap-2">
                  <BookOpen className="w-5 h-5 text-indigo-500" /> Руководство по развертыванию на Ubuntu 24 & Caddy
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Инструкция запуска веб-панели под домен kworkpas.mak-o.ru с Cloudflare DNS-проксированием.
                </p>
              </div>
              
              <div className="p-5 text-sm flex flex-col gap-4">
                
                {/* Checklist steps */}
                <div className="space-y-3">
                  <div className="flex gap-3 items-start">
                    <span className="bg-indigo-100 text-indigo-700 font-mono text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0 mt-0.5">1</span>
                    <div>
                      <p className="font-bold text-slate-800 text-xs">Установка Node.js на Ubuntu</p>
                      <pre className="bg-slate-900 text-slate-300 font-mono text-[10px] p-2 rounded-lg mt-1 overflow-x-auto select-all">
{`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs`}
                      </pre>
                    </div>
                  </div>

                  <div className="flex gap-3 items-start">
                    <span className="bg-indigo-100 text-indigo-700 font-mono text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0 mt-0.5">2</span>
                    <div>
                      <p className="font-bold text-slate-800 text-xs">Установка и настройка веб-сервера Caddy</p>
                      <p className="text-xs text-slate-500">Установите Caddy на Ubuntu для автоматического SSL:</p>
                      <pre className="bg-slate-900 text-slate-300 font-mono text-[10px] p-2 rounded-lg mt-1 overflow-x-auto select-all">
{`sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy`}
                      </pre>
                      <p className="text-xs text-slate-500 mt-2">Запишите конфигурацию в <code>/etc/caddy/Caddyfile</code>:</p>
                      <pre className="bg-slate-900 text-amber-400 font-mono text-[10px] p-2 rounded-lg mt-1 overflow-x-auto select-all">
{`kworkpas.mak-o.ru {
    # Проксирование с пробросом оригинального IP от Cloudflare
    reverse_proxy localhost:3000 {
        header_up X-Real-IP {header.CF-Connecting-IP}
        header_up X-Forwarded-For {header.CF-Connecting-IP}
    }
}`}
                      </pre>
                      <p className="text-xs text-slate-400 mt-1">Перезапустите Caddy: <code>sudo systemctl restart caddy</code></p>
                    </div>
                  </div>

                  <div className="flex gap-3 items-start">
                    <span className="bg-indigo-100 text-indigo-700 font-mono text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0 mt-0.5">3</span>
                    <div>
                      <p className="font-bold text-slate-800 text-xs">Создание службы службы systemd для Node.js</p>
                      <p className="text-xs text-slate-500">Создайте файл автозапуска <code>/etc/systemd/system/kwork-parser.service</code>:</p>
                      <pre className="bg-slate-900 text-emerald-400 font-mono text-[10px] p-2 rounded-lg mt-1 max-h-40 overflow-y-auto select-all">
{`[Unit]
Description=Kwork Scraper & VK Notification Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/kwork-parser-app
ExecStart=/usr/bin/npm run start
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target`}
                      </pre>
                      <p className="text-xs text-slate-500 mt-1">Запустите службу бота:</p>
                      <pre className="bg-slate-900 text-slate-300 font-mono text-[10px] p-2 rounded-lg mt-1 overflow-x-auto select-all">
{`sudo systemctl daemon-reload
sudo systemctl enable kwork-parser.service
sudo systemctl start kwork-parser.service`}
                      </pre>
                    </div>
                  </div>

                  <div className="flex gap-3 items-start">
                    <span className="bg-indigo-100 text-indigo-700 font-mono text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0 mt-0.5">4</span>
                    <div>
                      <p className="font-bold text-slate-800 text-xs">Настройка VK Callback Webhook</p>
                      <p className="text-xs text-slate-500">В настройках Кабинета группы ВК (Работа с API &rarr; Callback API) добавьте вебхук со следующим URL-адресом:</p>
                      <div className="bg-indigo-50 border border-indigo-100 p-2 text-indigo-850 font-mono text-xs rounded-lg mt-1.5 flex justify-between select-all">
                        <span>https://kworkpas.mak-o.ru/api/vk-callback</span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">Обязательно включите события "Входящие сообщения" в типах запросов Callback API ВК.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>


          {/* RIGHT SIDEBAR LOGS CONSOLE AND RECENT DISCOVERED PROJECTS FEEDS (5 SPACES) */}
          <div className="lg:col-span-5 flex flex-col gap-8">
            
            {/* LIVE CONSOLE TERMINAL (REAL-TIME SCROLLING EXECUTIONS) */}
            <div id="terminal_box" className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-[34rem]">
              <div className="p-4 border-b border-slate-800/80 flex items-center justify-between text-white bg-slate-900/50">
                <div className="flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-indigo-400 animate-pulse" />
                  <div>
                    <h3 className="text-sm font-bold tracking-tight">Логи движения парсера</h3>
                    <div className="text-[10px] text-indigo-300 flex items-center gap-1 mt-0.5 font-mono">
                      <span>Live stream active</span>
                      <span className="h-1.5 w-1.5 bg-emerald-400 rounded-full inline-block animate-ping"></span>
                    </div>
                  </div>
                </div>
                
                {/* Log filters */}
                <div className="flex items-center gap-1.5 bg-slate-850 p-1 rounded-lg">
                  <select
                    className="bg-slate-800 text-[10px] text-slate-300 min-w-16 outline-none focus:outline-none border-0 py-1 px-1.5 rounded"
                    value={logFilter}
                    onChange={(e: any) => setLogFilter(e.target.value)}
                  >
                    <option value="all">Все</option>
                    <option value="info">Инфо</option>
                    <option value="success">Ок</option>
                    <option value="warning">Важно</option>
                    <option value="error">Ошибки</option>
                  </select>
                </div>
              </div>

              {/* Console log box body */}
              <div ref={terminalContainerRef} className="flex-1 bg-slate-950 p-4 font-mono text-xs overflow-y-auto space-y-2 select-text custom-scrollbar">
                {filteredLogs.length === 0 ? (
                  <div className="text-slate-500 italic text-center pt-8">
                    Никаких записей логов пока не зарегистрировано.
                  </div>
                ) : (
                  [...filteredLogs].reverse().map((log) => {
                    let color = 'text-slate-300';
                    let label = 'INFO';
                    if (log.type === 'success') {
                      color = 'text-emerald-400';
                      label = 'SUCCESS';
                    } else if (log.type === 'warning') {
                      color = 'text-amber-400';
                      label = 'WARN';
                    } else if (log.type === 'error') {
                      color = 'text-rose-400 font-bold';
                      label = 'FAIL';
                    }

                    return (
                      <div key={log.id} className="leading-5 break-words">
                        <span className="text-slate-500 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                        <span className={`${color} font-bold mr-1`}>{label}:</span>{' '}
                        <span className={log.type === 'error' ? 'text-rose-100' : 'text-slate-300'}>{log.message}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* HARVESTED NEW KWORK PROJECTS PREVIEW ROLL */}
            <div id="captured_projects_box" className="bg-white border border-slate-200 rounded-2xl shadow-sm flex flex-col max-h-[35rem] overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <Bell className="w-4 h-4 text-emerald-500 animate-swing" /> Недавно обнаруженные проекты ({projects.length})
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Последние спарсенные заказы, присланные в ВК.
                  </p>
                </div>
                
                {projects.length > 0 && (
                  <button
                    onClick={forceWeeklyReset}
                    className="text-[10px] text-rose-500 hover:text-white hover:bg-rose-500 px-2 py-1 rounded border border-rose-500/20 font-bold transition-colors cursor-pointer"
                    title="Сбросить накопленную базу проектов"
                  >
                    Wipe
                  </button>
                )}
              </div>

              {/* Harvest projects cards scrolling container */}
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 bg-slate-50/30">
                {projects.length === 0 ? (
                  <div className="p-8 text-center text-slate-400">
                    <Radio className="w-10 h-10 mx-auto text-slate-300 mb-2 animate-pulse" />
                    <p className="text-xs font-semibold text-slate-400">Ожидание первых проектов...</p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Запустите парсер и убедитесь, что отслеживаемые ссылки добавлены!
                    </p>
                  </div>
                ) : (
                  projects.map((p) => (
                    <div key={p.id} className="p-4 bg-white hover:bg-slate-50/50 transition-all flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <h4 className="text-xs font-bold text-slate-800 line-clamp-2 hover:text-indigo-600">
                          <a href={p.link} target="_blank" rel="noreferrer" className="underline font-sans cursor-pointer">
                            {p.title}
                          </a>
                        </h4>
                        <span className="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 font-mono leading-none flex items-center">
                          {p.budget}
                        </span>
                      </div>
                      
                      <p className="text-[11px] text-slate-500 line-clamp-3">
                        {p.description}
                      </p>

                      <div className="flex flex-wrap items-center justify-between text-[10px] mt-1 text-slate-400 border-t border-slate-50 pt-2 font-mono">
                        <span className="flex items-center gap-1">
                          <ChevronRight className="w-3 h-3 text-slate-300" />
                          <span>Предложений: <strong className="text-indigo-600 font-bold">{p.offersCount}</strong></span>
                        </span>
                        
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-300" />
                          <span>{p.createdAtText}</span>
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
