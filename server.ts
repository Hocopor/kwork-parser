import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { KworkProject, KworkCategory, LogEntry, ParserStatus } from './src/types.js';

// Load environmental variables
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Setup directories and local database persistence
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface LocalDatabase {
  categories: KworkCategory[];
  scrapedProjects: KworkProject[];
  sentCount: number;
  logs: LogEntry[];
  settings: {
    vkToken: string;
    vkConfirmCode: string;
    vkGroupChatId: string;
    adminIds: string[];
    isParsingActive: boolean;
    intervalMinutes: number;
  };
}

const defaultDb: LocalDatabase = {
  categories: [
    {
      id: '1',
      url: 'https://kwork.ru/projects?c=11',
      name: 'Разработка и IT',
      addedAt: new Date().toISOString()
    }
  ],
  scrapedProjects: [],
  sentCount: 0,
  logs: [],
  settings: {
    vkToken: process.env.VK_TOKEN || '',
    vkConfirmCode: process.env.VK_CONFIRM_TOKEN || '',
    vkGroupChatId: process.env.VK_GROUP_CHAT_ID || '',
    adminIds: process.env.VK_ADMIN_IDS ? process.env.VK_ADMIN_IDS.split(',').map(x => x.trim()) : [],
    isParsingActive: true,
    intervalMinutes: 2 // check every 2 minutes
  }
};

function loadDB(): LocalDatabase {
  if (!fs.existsSync(DB_FILE)) {
    saveDB(defaultDb);
    return defaultDb;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const db = JSON.parse(raw);
    
    // Ensure all critical properties are present
    return {
      categories: db.categories || defaultDb.categories,
      scrapedProjects: db.scrapedProjects || defaultDb.scrapedProjects,
      sentCount: db.sentCount !== undefined ? db.sentCount : defaultDb.sentCount,
      logs: db.logs || defaultDb.logs,
      settings: { ...defaultDb.settings, ...(db.settings || {}) }
    };
  } catch (error) {
    console.error('Failed to load database. Restoring defaults.', error);
    return defaultDb;
  }
}

function saveDB(db: LocalDatabase) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save database file:', error);
  }
}

// Global state loaded from local database
let db = loadDB();

// Helper to hash string into numeric ID
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

// Add system log
function addLog(type: LogEntry['type'], message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${type.toUpperCase()}] ${timestamp}: ${message}`);
  
  const newLog: LogEntry = {
    id: Math.random().toString(36).substring(2, 9),
    timestamp,
    type,
    message
  };

  db.logs.unshift(newLog);
  // Keep last 400 logs to optimize memory and disk limits
  if (db.logs.length > 400) {
    db.logs = db.logs.slice(0, 400);
  }
  saveDB(db);
}

addLog('info', 'Парсер запущен и готов к работе!');

// VK Integration: Send Message API Client
async function sendVkMessage(peerId: string, messageText: string, keyboardObj?: any): Promise<boolean> {
  const token = db.settings.vkToken || process.env.VK_TOKEN;
  if (!token) {
    addLog('warning', 'Не удалось отправить ВК: Отсутствует токен группы (VK_TOKEN).');
    return false;
  }

  const peer = peerId || db.settings.vkGroupChatId;
  if (!peer) {
    addLog('warning', 'Не удалось отправить ВК: Отсутствует получатель (Peer ID).');
    return false;
  }

  const payload: Record<string, string> = {
    peer_id: peer,
    message: messageText,
    random_id: String(Math.floor(Math.random() * 1000000000)),
    access_token: token,
    v: '5.131'
  };

  if (keyboardObj) {
    payload.keyboard = JSON.stringify(keyboardObj);
  }

  try {
    const response = await fetch('https://api.vk.com/method/messages.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload)
    });

    const data = await response.json();
    if (data.error) {
      addLog('error', `Ошибка отправки API ВК: ${data.error.error_msg} (код ${data.error.error_code})`);
      return false;
    }
    
    db.sentCount++;
    saveDB(db);
    return true;
  } catch (error: any) {
    addLog('error', `Исключение при отправке в ВК: ${error.message}`);
    return false;
  }
}

// Construct VK Keyboard for group navigation
function getVkKeyboard() {
  return {
    one_time: false,
    buttons: [
      [
        {
          action: {
            type: 'text',
            payload: '{"command": "status"}',
            label: '📊 Статус'
          },
          color: 'primary'
        },
        {
          action: {
            type: 'text',
            payload: '{"command": "list"}',
            label: '🔗 Категории'
          },
          color: 'secondary'
        }
      ],
      [
        {
          action: {
            type: 'text',
            payload: '{"command": "start"}',
            label: '▶ Запустить'
          },
          color: 'positive'
        },
        {
          action: {
            type: 'text',
            payload: '{"command": "stop"}',
            label: '⏸ Остановить'
          },
          color: 'negative'
        }
      ],
      [
        {
          action: {
            type: 'text',
            payload: '{"command": "clear"}',
            label: '🧹 Очистить базу'
          },
          color: 'secondary'
        }
      ]
    ],
    inline: false
  };
}

// ----------------------------------------------------------------------------
// KWORK HTTP SESSION (стабильный отпечаток браузера + хранилище cookie)
// ----------------------------------------------------------------------------
// Ротация User-Agent на каждый запрос — это само по себе признак бота (один и
// тот же cookie-сеанс с разными UA выглядит подозрительно). Поэтому фиксируем
// ОДИН реалистичный отпечаток Chrome на весь процесс и сохраняем cookie между
// запросами — так трафик неотличим от обычного вернувшегося пользователя.
const SESSION_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const cookieJar = new Map<string, string>();
let sessionWarmed = false;

function buildCookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res: Response) {
  // Node 18+ предоставляет getSetCookie(); подстраховываемся одиночным заголовком.
  let rawCookies: string[] = [];
  const anyHeaders = res.headers as any;
  if (typeof anyHeaders.getSetCookie === 'function') {
    rawCookies = anyHeaders.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) rawCookies = [single];
  }
  for (const c of rawCookies) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

// Единая точка HTTP-запросов к Kwork с человекоподобными заголовками.
async function kworkFetch(url: string, referer = 'https://kwork.ru/projects'): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': SESSION_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': referer
  };
  const cookie = buildCookieHeader();
  if (cookie) headers['Cookie'] = cookie;

  const response = await fetch(url, { headers, redirect: 'follow' });
  storeCookies(response);
  return response;
}

// «Прогрев» сессии: один заход на главную, чтобы получить cookie как настоящий
// браузер, прежде чем дёргать страницы категорий.
async function warmUpSession() {
  if (sessionWarmed) return;
  try {
    const res = await kworkFetch('https://kwork.ru/', 'https://www.google.com/');
    if (res.ok) {
      sessionWarmed = true;
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
    }
  } catch {
    // тихо игнорируем — основной запрос всё равно попробует
  }
}

// Извлекаем JSON из `window.stateData = {...}` балансировкой скобок.
function extractStateData(html: string): any | null {
  const marker = 'window.stateData=';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;

  let i = markerIdx + marker.length;
  while (i < html.length && html[i] !== '{') i++;
  const objStart = i;

  let depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(objStart, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Декодируем HTML-сущности и убираем теги — описания Kwork содержат &laquo; и т.п.
function cleanText(raw: string): string {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Преобразуем «want» (заказ Kwork) в нашу модель проекта.
function mapWantToProject(want: any, categoryUrl: string): KworkProject {
  const id = String(want.id);
  const title = cleanText(want.name);
  const description = cleanText(want.description);

  // Бюджет. priceLimit — нижняя планка, possiblePriceLimit — верхняя (если выше).
  let budget = 'Цена договорная';
  const price = parseFloat(want.priceLimit);
  if (!isNaN(price) && price > 0) {
    const low = Math.round(price).toLocaleString('ru-RU');
    const higher = parseFloat(want.possiblePriceLimit);
    if (!isNaN(higher) && higher > price) {
      budget = `${low} – ${Math.round(higher).toLocaleString('ru-RU')} ₽`;
    } else {
      budget = `до ${low} ₽`;
    }
  }

  const offersCount = parseInt(want.kwork_count, 10) || 0;
  const createdAtText = want.timeLeft
    ? `осталось ${want.timeLeft}`
    : (want.wantDates?.dateCreate || 'Недавно');

  return {
    id,
    categoryUrl,
    title,
    budget,
    description,
    offersCount,
    createdAtText,
    link: `https://kwork.ru/projects/${id}/view`,
    scrapedAt: new Date().toISOString()
  };
}

// Резервный парсер через cheerio — на случай, если Kwork изменит формат stateData.
function legacyCheerioParse(html: string, url: string): KworkProject[] {
  const $ = cheerio.load(html);
  const projects: KworkProject[] = [];

  $('a[href*="/projects/"]').each((i, el) => {
    const link = $(el).attr('href') || '';
    const title = $(el).text().trim();
    if (!title || projects.some(p => p.link.includes(link))) return;

    const fullLink = link.startsWith('http') ? link : `https://kwork.ru${link}`;
    let parent = $(el).parent();
    for (let depth = 0; depth < 5; depth++) {
      if (parent.text().length > 150) break;
      parent = parent.parent();
    }
    const description = parent.text().replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const budgetMatch = parent.text().match(/[\d\s\xa0]+(?:₽|руб|рублей)/i);
    const projId = link.split('/').filter(Boolean).pop()?.split('-')[0] || String(Math.abs(hashString(fullLink)));

    projects.push({
      id: projId,
      categoryUrl: url,
      title,
      budget: budgetMatch ? budgetMatch[0].trim() : 'Цена не указана',
      description,
      offersCount: 0,
      createdAtText: 'Недавно',
      link: fullLink,
      scrapedAt: new Date().toISOString()
    });
  });

  return projects;
}

// Признак блокировки/капчи: Kwork отдаёт 403/429/503 либо страницу-челлендж
// без полноценного stateData. Бросаем особую ошибку для адаптивного бэкоффа.
class KworkBlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'KworkBlockedError'; }
}

// Главный парсер страницы категории Kwork.
async function parseKworkPage(url: string): Promise<KworkProject[]> {
  await warmUpSession();

  const response = await kworkFetch(url);

  if (response.status === 403 || response.status === 429 || response.status === 503) {
    sessionWarmed = false; // принудительный повторный «прогрев» в следующий раз
    throw new KworkBlockedError(`Kwork вернул ${response.status} — вероятно, временное ограничение/капча.`);
  }
  if (!response.ok) {
    throw new Error(`Kwork ответил статусом ${response.status}`);
  }

  const html = await response.text();
  const state = extractStateData(html);

  // Основной путь: данные заказов лежат в window.stateData.wants
  if (state && Array.isArray(state.wants)) {
    return state.wants
      .filter((w: any) => w && w.id && (w.status === 'active' || w.isWantActive))
      .map((w: any) => mapWantToProject(w, url));
  }

  // stateData не найден — возможно челлендж-страница. Пробуем резервный парсер.
  const fallback = legacyCheerioParse(html, url);
  if (fallback.length === 0) {
    sessionWarmed = false;
    throw new KworkBlockedError('Не удалось извлечь данные заказов (нет stateData) — возможна капча/блокировка.');
  }
  return fallback;
}

// Global counters & statuses
let isCurrentlyParsing = false;
let lastPulseTimestamp = new Date().toISOString();
let errorCount = 0;
let uptimeTimer = 0;
let backoffLevel = 0; // растёт при блокировках/капче, замедляет опрос
setInterval(() => { uptimeTimer++; }, 1000);

// Core Background Loop Scraper Execution
async function runScrakingCycle() {
  if (isCurrentlyParsing) return;
  if (!db.settings.isParsingActive) return;

  isCurrentlyParsing = true;
  lastPulseTimestamp = new Date().toISOString();

  addLog('info', `Запуск нового цикла проверки по ${db.categories.length} категориям...`);

  try {
    for (const category of db.categories) {
      if (!db.settings.isParsingActive) break;

      addLog('info', `Парсинг категории: "${category.name}" (${category.url})...`);
      
      try {
        // Fetch and parse the projects
        const fetched = await parseKworkPage(category.url);
        backoffLevel = Math.max(0, backoffLevel - 1); // успех — снижаем бэкофф
        addLog('info', `Спарсено ${fetched.length} проектов из категории "${category.name}".`);

        // Check which projects are brand new
        const newProjects: KworkProject[] = [];

        for (const proj of fetched) {
          const isKnown = db.scrapedProjects.some(existing => existing.id === proj.id);
          if (!isKnown) {
            newProjects.push(proj);
            db.scrapedProjects.push(proj);
          }
        }

        addLog('success', `Категория "${category.name}": ${newProjects.length} новых проектов обнаружено.`);

        // Notify in VK for each new project detected
        for (const newProj of newProjects) {
          const message = `🔔 НОВЫЙ ПРОЕКТ НА KWORK!\n\n` +
            `📌 ${newProj.title}\n` +
            `💰 Бюджет: ${newProj.budget}\n` +
            `🕒 Время публикации: ${newProj.createdAtText}\n` +
            `💬 Количество предложений: ${newProj.offersCount}\n\n` +
            `📄 Описание:\n${newProj.description.substring(0, 350)}${newProj.description.length > 350 ? '...' : ''}\n\n` +
            `🔗 Ссылка на проект: ${newProj.link}`;

          // Notify all admins configured
          const targetIds = db.settings.vkGroupChatId ? [db.settings.vkGroupChatId] : db.settings.adminIds;
          for (const uid of targetIds) {
            if (uid) {
              const success = await sendVkMessage(uid, message);
              if (success) {
                addLog('success', `Уведомление о проекте "${newProj.title}" отослано пользователю VK: ${uid}`);
              }
            }
          }
        }

        saveDB(db);

        // Random delay (2000ms - 6000ms) inside loop to mimic human reading and avoid Kwork blocks
        const randomWait = 2000 + Math.random() * 4000;
        await new Promise(resolve => setTimeout(resolve, randomWait));

      } catch (catError: any) {
        errorCount++;
        if (catError instanceof KworkBlockedError) {
          backoffLevel = Math.min(6, backoffLevel + 1);
          addLog('warning', `Похоже на ограничение Kwork по "${category.name}": ${catError.message} Замедляюсь (уровень бэкоффа ${backoffLevel}).`);
        } else {
          addLog('error', `Не удалось спарсить данные с URL "${category.url}": ${catError.message}`);
        }
      }
    }
  } catch (error: any) {
    errorCount++;
    addLog('error', `Критическая ошибка цикла парсинга: ${error.message}`);
  } finally {
    isCurrentlyParsing = false;
    addLog('info', `Цикл парсинга завершен.`);
  }
}

// Background scheduler
let scraperTimeout: NodeJS.Timeout | null = null;
function scheduleNextScrape() {
  if (scraperTimeout) {
    clearTimeout(scraperTimeout);
  }

  const loop = async () => {
    if (db.settings.isParsingActive) {
      await runScrakingCycle();
    }
    // Calculate randomized interval with tiny jitter +/- 10 seconds to bypass static automation detectors
    const baseMs = db.settings.intervalMinutes * 60 * 1000;
    const jitter = (Math.random() * 20000) - 10000; // -10s to +10s
    // При блокировках/капче добавляем по минуте за уровень бэкоффа (до +6 мин)
    const backoffMs = backoffLevel * 60 * 1000;
    const delay = Math.max(15000, baseMs + jitter + backoffMs); // Min 15 seconds
    scraperTimeout = setTimeout(loop, delay);
  };

  // Launch initial scheduling loop
  scraperTimeout = setTimeout(loop, 2000);
}

// Launch parser initially
scheduleNextScrape();

// Automatic Weekly database cleanup (automatically stop, purge scrapedProjects, restart)
// This strictly satisfies user requirement to clear ancient database products every 7 days
setInterval(() => {
  addLog('warning', 'ВНИМАНИЕ: Затиск еженедельной автоматической очистки неактуальных проектов...');
  
  const tempParsingActive = db.settings.isParsingActive;
  db.settings.isParsingActive = false;
  
  // Wipe database of scraped projects to save size and load fresh
  db.scrapedProjects = [];
  addLog('success', 'База старых проектов была очищена по еженедельному графику для оптимизации хранения.');
  
  db.settings.isParsingActive = tempParsingActive;
  saveDB(db);
  
  if (db.settings.isParsingActive) {
    addLog('info', 'Парсинг автоматически возобновлен с чистой базой.');
  }
}, 7 * 24 * 60 * 60 * 1000); // 7 days interval in milliseconds


// Express Server API Routing configuration
app.use(express.json());

// ----------------------------------------------------------------------------
// АВТОРИЗАЦИЯ ПАНЕЛИ (пароль задаётся как SHA-256 хэш в .env)
// ----------------------------------------------------------------------------
// В .env хранится DASHBOARD_PASSWORD_HASH — это sha256(пароль) в hex, а не сам
// пароль. Если переменная пуста, панель открыта (обратная совместимость).
// Сгенерировать хэш:
//   node -e "console.log(require('crypto').createHash('sha256').update('ВАШ_ПАРОЛЬ').digest('hex'))"
const PASSWORD_HASH = (process.env.DASHBOARD_PASSWORD_HASH || '').trim().toLowerCase();
const activeSessions = new Set<string>();

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function parseCookies(req: express.Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isAuthenticated(req: express.Request): boolean {
  if (!PASSWORD_HASH) return true; // пароль не настроен — доступ открыт
  const token = parseCookies(req).kwork_session;
  return !!token && activeSessions.has(token);
}

// Публичные эндпоинты, не требующие входа (логин, проверка, VK-вебхук).
const PUBLIC_API_PATHS = new Set(['/login', '/logout', '/auth/check', '/vk-callback']);

app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Требуется авторизация' });
});

// Сообщает фронтенду, нужен ли вход и авторизован ли пользователь.
app.get('/api/auth/check', (req, res) => {
  res.json({ authRequired: !!PASSWORD_HASH, authenticated: isAuthenticated(req) });
});

// Вход по паролю → выдаём httpOnly cookie-сессию.
app.post('/api/login', (req, res) => {
  if (!PASSWORD_HASH) return res.json({ success: true });

  const given = sha256Hex(String((req.body && req.body.password) || ''));
  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD_HASH);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    addLog('warning', 'Неудачная попытка входа в панель управления (неверный пароль).');
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.add(token);
  res.setHeader('Set-Cookie', `kwork_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
  addLog('success', 'Выполнен успешный вход в панель управления.');
  res.json({ success: true });
});

// Выход — удаляем сессию.
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).kwork_session;
  if (token) activeSessions.delete(token);
  res.setHeader('Set-Cookie', 'kwork_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ success: true });
});

// API Status
app.get('/api/status', (req, res) => {
  const status: ParserStatus = {
    isParsingActive: db.settings.isParsingActive,
    activeCategoriesCount: db.categories.length,
    totalParsedProjectsCount: db.scrapedProjects.length,
    totalSentAlertsCount: db.sentCount,
    uptimeSeconds: uptimeTimer,
    lastRunTimestamp: lastPulseTimestamp,
    errorCount: errorCount
  };
  res.json({ status, settings: db.settings });
});

// GET active Categories (URLs)
app.get('/api/categories', (req, res) => {
  res.json(db.categories);
});

// POST Add Category URL
app.post('/api/categories', async (req, res) => {
  const { url, name } = req.body;
  if (!url || !url.startsWith('https://kwork.ru/')) {
    return res.status(400).json({ error: 'Ссылка должна начинаться с https://kwork.ru/' });
  }

  // Check if already exist
  if (db.categories.some(c => c.url === url)) {
    return res.status(400).json({ error: 'Этот URL уже добавлен для мониторинга.' });
  }

  const cleanName = name || `Категория: ${url.replace('https://kwork.ru/projects', '').substring(0, 30)}`;
  const newCat: KworkCategory = {
    id: Math.random().toString(36).substring(2, 9),
    url,
    name: cleanName,
    addedAt: new Date().toISOString()
  };

  db.categories.push(newCat);
  addLog('success', `Добавлен новый URL для парсинга: "${cleanName}" (${url})`);
  saveDB(db);

  // Trigger quick parse instantly to pre-populate database for this, so that old orders aren't treated as "new"
  setTimeout(async () => {
    try {
      addLog('info', `Первоначальный фоновый сбор проектов для новой ссылки: "${cleanName}" во избежание спама...`);
      const fetched = await parseKworkPage(newCat.url);
      let count = 0;
      for (const p of fetched) {
        if (!db.scrapedProjects.some(x => x.id === p.id)) {
          db.scrapedProjects.push(p);
          count++;
        }
      }
      addLog('success', `Собрано ${count} существующих проектов. Они сохранены в базе как "ранее известные".`);
      saveDB(db);
    } catch (e: any) {
      addLog('error', `Не удалось выполнить первоначальный спарсинг при добавлении ссылки: ${e.message}`);
    }
  }, 100);

  res.json(newCat);
});

// DELETE Category
app.delete('/api/categories/:id', (req, res) => {
  const { id } = req.params;
  const index = db.categories.findIndex(c => c.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Категория не найдена.' });
  }

  const category = db.categories[index];
  db.categories.splice(index, 1);
  
  // Wipe associated projects from DB strictly satisfying the user constraint:
  // "При удалении из бота ссылки, удаляется из базы всё, что с ней было связано. Все проекты, которые спарсил бот по этой категории из ссылки."
  const initialLength = db.scrapedProjects.length;
  db.scrapedProjects = db.scrapedProjects.filter(p => p.categoryUrl !== category.url);
  const erasedCount = initialLength - db.scrapedProjects.length;

  addLog('warning', `Удалена ссылка: "${category.name}". Стерто ${erasedCount} связанных проектов из базы.`);
  saveDB(db);

  res.json({ success: true, erasedCount, remainingCategories: db.categories.length });
});

// GET parsed projects feed
app.get('/api/projects', (req, res) => {
  // Return sorted projects by date (newest first)
  const sorted = [...db.scrapedProjects].sort((a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime());
  res.json(sorted.slice(0, 150)); // cap at 150 projects
});

// GET runtime engine logs
app.get('/api/logs', (req, res) => {
  res.json(db.logs);
});

// POST Toggle active parsing loop
app.post('/api/control/toggle', (req, res) => {
  db.settings.isParsingActive = !db.settings.isParsingActive;
  
  if (!db.settings.isParsingActive) {
    // Satisfy requirement: 
    // "При остановке парсинга (если я вручную остановлю парсер) - остаются ссылки (категории), но база по ним очищается..."
    db.scrapedProjects = [];
    addLog('warning', 'Парсинг остановлен вручную. База данных ранее спарсенных проектов очищена!');
  } else {
    addLog('success', 'Парсинг запущен вручную. Проекты будут собираться заново.');
  }

  saveDB(db);
  res.json({ isParsingActive: db.settings.isParsingActive });
});

// POST Manually Clear Projects DB
app.post('/api/control/clear-db', (req, res) => {
  const count = db.scrapedProjects.length;
  db.scrapedProjects = [];
  addLog('warning', `База данных проектов была очищена вручную (удалено ${count} проектов).`);
  saveDB(db);
  res.json({ success: true, clearedCount: count });
});

// POST Change Settings (VK token, admin ids, intervals)
app.post('/api/control/settings', (req, res) => {
  const { vkToken, vkConfirmCode, vkGroupChatId, adminIds, intervalMinutes } = req.body;
  
  if (vkToken !== undefined) db.settings.vkToken = vkToken;
  if (vkConfirmCode !== undefined) db.settings.vkConfirmCode = vkConfirmCode;
  if (vkGroupChatId !== undefined) db.settings.vkGroupChatId = vkGroupChatId;
  if (intervalMinutes !== undefined) db.settings.intervalMinutes = Math.max(1, parseInt(intervalMinutes, 10));
  
  if (adminIds !== undefined) {
    db.settings.adminIds = Array.isArray(adminIds) 
      ? adminIds.map((x: any) => String(x).trim()) 
      : String(adminIds).split(',').map(x => x.trim()).filter(Boolean);
  }

  addLog('success', 'Настройки интеграции и задержек успешно сохранены.');
  saveDB(db);
  scheduleNextScrape(); // reschedule with new interval/settings

  res.json(db.settings);
});

// POST Simulate Weekly Purge
app.post('/api/control/weekly-reset', (req, res) => {
  addLog('warning', 'Запущен принудительный еженедельный сброс базы данных проектов...');
  db.scrapedProjects = [];
  addLog('success', 'Еженедельный сброс выполнен. База очищена. Очередная проверка соберет новые активные заявки.');
  saveDB(db);
  res.json({ success: true });
});

// POST Send mock VK alert to test integration
app.post('/api/control/test-vk', async (req, res) => {
  addLog('info', 'Отправка тестового оповещения в ВК для проверки интеграции...');
  
  const testMessage = `🧪 ТЕСТ ИНТЕГРАЦИИ ВК ХОРОШО!\n\n` +
    `🤖 Бот-парсер Kwork успешно подключен к вашему сообществу!\n` +
    `📊 Статус парсера: ${db.settings.isParsingActive ? 'Парсинг запущен' : 'Остановлен'}\n` +
    `🔗 Мониторится ссылок проекта: ${db.categories.length}\n` +
    `⚙ Интервал проверки: каждые ${db.settings.intervalMinutes} мин.`;

  const targetIds = db.settings.vkGroupChatId ? [db.settings.vkGroupChatId] : db.settings.adminIds;
  if (targetIds.length === 0 || !targetIds[0]) {
    return res.status(400).json({ error: 'Не настроены ID получателей/админов в настройках.' });
  }

  let sent = 0;
  for (const uid of targetIds) {
    if (uid) {
      const ok = await sendVkMessage(uid, testMessage, getVkKeyboard());
      if (ok) sent++;
    }
  }

  if (sent > 0) {
    res.json({ success: true, message: `Тест отправлен успешно в ${sent} чатов.` });
  } else {
    res.status(500).json({ error: 'Не удалось отправить сообщение. Проверьте ваш VK токен в конфигурации.' });
  }
});


// ----------------------------------------------------
// VK BOT WEBHOOK CALLBACK RECEIVER (ENDPOINT /api/vk)
// ----------------------------------------------------
app.post('/api/vk-callback', async (req, res) => {
  const { type, object, group_id, secret } = req.body;

  if (!type) {
    return res.status(400).send('bad request');
  }

  // Handle server confirmation from VK admin panel!
  if (type === 'confirmation') {
    const confirmationCode = db.settings.vkConfirmCode || process.env.VK_CONFIRM_TOKEN || 'test-confirmation';
    addLog('info', `VK прислал запрос подтверждения сервера. Возвращаем код: ${confirmationCode}`);
    return res.send(confirmationCode);
  }

  // Handle incoming commands inside VK Chat
  if (type === 'message_new') {
    // Safe extract message context
    const message = object?.message || object;
    const fromId = String(message?.from_id || '');
    const peerId = String(message?.peer_id || fromId);
    const text = (message?.text || '').trim();

    // Fast status check replies bypass auth for simple health,
    // but actual setup changes command check must strictly match User permissions!
    const isAdmin = db.settings.adminIds.length === 0 || db.settings.adminIds.includes(fromId);
    
    if (!isAdmin) {
      addLog('warning', `Посторонний ВК-пользователь (ID: ${fromId}) попытался дать боту команду: "${text}"`);
      await sendVkMessage(peerId, `❌ Доступ заблокирован. Вы (ID: ${fromId}) не внесены в список разрешенных пользователей.`);
      return res.send('ok');
    }

    addLog('info', `Получена команда из чата ВК (от ID ${fromId}): "${text}"`);

    const lowerText = text.toLowerCase();

    // BUTTON/MESSAGE ROUTER COMMANDS
    if (lowerText.includes('статус') || lowerText === '/status' || lowerText === 'status') {
      const statusMsg = `📊 ТЕКУЩИЙ СТАТУС БОТА-ПАРСЕРА:\n\n` +
        `🟢 Мониторинг: ${db.settings.isParsingActive ? 'АКТИВЕН' : 'ОСТАНОВЛЕН'}\n` +
        `🔗 Отслеживается ссылок (категорий): ${db.categories.length}\n` +
        `📦 Проектов в базе: ${db.scrapedProjects.length}\n` +
        `📨 Отправлено уведомлений: ${db.sentCount}\n` +
        `⚠️ Ошибок сбора: ${errorCount}\n` +
        `⏱ Время работы бота: ${Math.floor(uptimeTimer / 3600)}ч ${Math.floor((uptimeTimer % 3600) / 60)}м\n` +
        `🔄 Интервал: каждые ${db.settings.intervalMinutes} мин.`;

      await sendVkMessage(peerId, statusMsg, getVkKeyboard());

    } else if (lowerText.includes('категори') || lowerText.includes('ссылк') || lowerText === '/list' || lowerText === 'list') {
      let msg = `🔗 АКТИВНЫЕ ССЫЛКИ ДЛЯ МОНИТОРИНГА (${db.categories.length}):\n\n`;
      db.categories.forEach((c, idx) => {
        msg += `${idx + 1}. ${c.name}\n📍 URL: ${c.url}\n\n`;
      });
      msg += `💡 Чтобы добавить новую ссылку, пришлите её в ответном сообщении. Ссылка должна начинаться с https://kwork.ru/projects`;
      
      await sendVkMessage(peerId, msg, getVkKeyboard());

    } else if (lowerText === 'запустить' || lowerText === '/start' || lowerText === 'start') {
      db.settings.isParsingActive = true;
      saveDB(db);
      addLog('success', 'Парсинг запущен по команде из ВК.');
      await sendVkMessage(peerId, `🟢 Парсинг Kwork успешно запущен! Проверяю категории каждые ${db.settings.intervalMinutes} мин.`, getVkKeyboard());

    } else if (lowerText === 'остановить' || lowerText === '/stop' || lowerText === 'stop') {
      db.settings.isParsingActive = false;
      db.scrapedProjects = []; // satisfying: база по ним очищается
      saveDB(db);
      addLog('warning', 'Парсинг остановлен по команде из ВК. База данных проектов сброшена.');
      await sendVkMessage(peerId, `⏸ Парсер Kwork приостановлен! Ссылки остались в памяти, но база данных проектов очищена. Нажмите 'Запустить' для старта заново.`, getVkKeyboard());

    } else if (lowerText.includes('очистить баз') || lowerText === '/clear' || lowerText === 'clear') {
      const removed = db.scrapedProjects.length;
      db.scrapedProjects = [];
      saveDB(db);
      addLog('warning', 'База данных проектов очищена по команде из ВК.');
      await sendVkMessage(peerId, `🧹 База сохраненных проектов успешно очищена (удалено записей: ${removed}). Очередной цикл заполнит её актуальными задачами заново.`, getVkKeyboard());

    } else if (text.startsWith('https://kwork.ru/')) {
      // Add a link dynamically from the VK messenger!
      if (db.categories.some(c => c.url === text)) {
        await sendVkMessage(peerId, `⚠️ Эта ссылка уже отслеживается! Она введена в базу.`, getVkKeyboard());
      } else {
        const newCat: KworkCategory = {
          id: Math.random().toString(36).substring(2, 9),
          url: text,
          name: `Быстрая ссылка из ВК`,
          addedAt: new Date().toISOString()
        };
        db.categories.push(newCat);
        addLog('success', `Добавлена ссылка из ВК: ${text}`);
        saveDB(db);
        
        await sendVkMessage(peerId, `✅ Настройка принята! Добавлена новая ссылка для мониторинга: ${text}\nВыполняю фоновый первичный сбор заказов...`, getVkKeyboard());
        
        // Background scrap
        setTimeout(async () => {
          try {
            const fetched = await parseKworkPage(newCat.url);
            for (const p of fetched) {
              if (!db.scrapedProjects.some(x => x.id === p.id)) {
                db.scrapedProjects.push(p);
              }
            }
            saveDB(db);
            addLog('success', `Фоновый первичный сбор успешно завершен для добавленной из ВК категории.`);
          } catch (e: any) {
            addLog('error', `Не удалось сделать фоновый запуск: ${e.message}`);
          }
        }, 100);
      }

    } else if (lowerText.startsWith('/del_') || lowerText.startsWith('удалить ')) {
      // Handle deletion e.g. "удалить 1" or "/del_5"
      const arg = text.replace(/удалить|удалить ссылка|\/del_/gi, '').trim();
      const num = parseInt(arg, 10);
      
      if (!isNaN(num) && num > 0 && num <= db.categories.length) {
        const deletedCat = db.categories[num - 1];
        db.categories.splice(num - 1, 1);
        
        // Remove associated projects
        db.scrapedProjects = db.scrapedProjects.filter(p => p.categoryUrl !== deletedCat.url);
        saveDB(db);
        addLog('warning', `Удалена ссылка по команде из ВК: ${deletedCat.url}`);
        
        await sendVkMessage(peerId, `🗑️ Ссылка "${deletedCat.name}" удалена! Связанные с ней проекты стёрты из базы данных.`, getVkKeyboard());
      } else {
        await sendVkMessage(peerId, `❌ Неверный номер ссылки. Напишите, например, "удалить 1" (где 1 - номер ссылки в списке по кнопке 'Категории').`, getVkKeyboard());
      }

    } else {
      // Default help message
      const helpText = `🤖 БОТ-ПАРСЕР KWORK К ВАШИМ УСЛУГАМ!\n\n` +
        `Ниже предоставлено меню интерактивного управления парсером. Вы можете нажимать кнопки или посылать текстовые команды.\n\n` +
        `📌 Доступные действия:\n` +
        `➡ Наберите "Статус" — проверка работоспособности\n` +
        `➡ Наберите "Категории" — увидеть все отслеживаемые разделы\n` +
        `➡ Наберите "Запустить" — запустить мониторинг заново\n` +
        `➡ Наберите "Остановить" — приостановить парсинг и очистить буфер\n` +
        `➡ Наберите "Очистить базу" — сбросить сохраненный кэш проектов\n` +
        `➡ Пришлите ссылку "https://kwork.ru/projects?..." чтобы добавить её\n` +
        `➡ Наберите "удалить Х" чтобы убрать ссылку под номером Х из списка`;

      await sendVkMessage(peerId, helpText, getVkKeyboard());
    }
  }

  // Confirm to VK that webhook is active
  res.send('ok');
});


// -----------------------------------------------------------
// SPA REACT ROUTING AND COMPLIANT DEVELOPMENT SETUP WITH VITE
// -----------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started. Monitoring active port: ${PORT}`);
  });
}

startServer();
