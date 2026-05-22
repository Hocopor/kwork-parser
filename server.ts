import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { KworkProject, KworkCategory, LogEntry, ParserStatus } from './src/types.js';

// Load environmental variables
dotenv.config();

const app = express();
const PORT = 3000;

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

// Kwork HTML parser helper
async function parseKworkPage(url: string): Promise<KworkProject[]> {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  // Set randomized headers to completely prevent user block or captchas
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://kwork.ru/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Kwork ответил с ошибкой: ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  const projects: KworkProject[] = [];

  // Match the core items. Inside Kwork freelance page, items are labeled '.wants-card' or '.want-card'
  const cardElements = $('.wants-card, .want-card, .want-block, .want-inner, [class*="want-card"]');
  
  if (cardElements.length === 0) {
    // Adaptive fallback. Traverse any links pointing to /projects/
    $('a[href*="/projects/"]').each((i, el) => {
      const link = $(el).attr('href') || '';
      
      let parent = $(el).parent();
      for (let depth = 0; depth < 5; depth++) {
        if (parent.text().length > 150 && parent.find('a[href*="/projects/"]').length < 3) {
          break;
        }
        parent = parent.parent();
      }
      
      const title = $(el).text().trim();
      if (!title || projects.some(p => p.link.includes(link))) return;

      const fullLink = link.startsWith('http') ? link : `https://kwork.ru${link}`;
      const description = parent.text().replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 300) + '...';
      const budgetMatch = parent.text().match(/(?:бюджет|цена|до|желаемый|допустимый)\s*[:\-]?\s*[\d\s\xa0]+(?:₽|руб|рублей|\$|USD)/i);
      const budget = budgetMatch ? budgetMatch[0].trim() : 'Цена не указана';
      
      const projId = link.split('/').pop()?.split('-')?.[0] || String(Math.abs(hashString(fullLink)));

      projects.push({
        id: projId,
        categoryUrl: url,
        title,
        budget,
        description,
        offersCount: 0,
        createdAtText: 'Недавно',
        link: fullLink,
        scrapedAt: new Date().toISOString()
      });
    });
  } else {
    cardElements.each((index, element) => {
      const card = $(element);
      
      const titleAnchor = card.find('a[href*="/projects/"]').first();
      const title = titleAnchor.text().trim();
      const relativeLink = titleAnchor.attr('href') || '';
      if (!title || !relativeLink) return;

      const fullLink = relativeLink.startsWith('http') ? relativeLink : `https://kwork.ru${relativeLink}`;

      // Extract description
      let description = card.find('.wants-card__description, .wants-card__text, [class*="description"], [class*="text"]').text().trim();
      if (!description) {
        description = card.find('p, span').text().trim().substring(0, 300);
      }
      if (!description) {
        description = card.text().replace(title, '').substring(0, 300).trim();
      }
      // Formatting description: clean multiple spaces
      description = description.replace(/\s+/g, ' ');

      // Extract budget
      let budget = card.find('.wants-card__price, .price, [class*="price"], [class*="budget"]').text().trim();
      if (!budget) {
        const matches = card.text().match(/(?:Цена до|Желаемый бюджет|Допустимый бюджет|Бюджет|Цена)\s*[:\-]?\s*[\d\s\xa0]+(?:₽|руб|рублей|\$|USD)/i);
        budget = matches ? matches[0].trim() : '';
      }
      if (!budget) {
        const anyPrice = card.text().match(/[\d\s\xa0]+(?:₽|руб|USD|\$)/i);
        budget = anyPrice ? anyPrice[0].trim() : 'Цена не указана';
      }

      // Extract offers count
      const rawOffersText = card.find('.wants-card__offers, [class*="offers"], [class*="offer"]').text().trim();
      let offersCount = 0;
      const offersMatch = (rawOffersText || card.text()).match(/(\d+)\s*(?:предложен|отклик|заяв)/i);
      if (offersMatch) {
        offersCount = parseInt(offersMatch[1], 10);
      }

      // Extract creation time
      let createdAtText = card.find('.wants-card__header-time, [class*="time"], [class*="date"]').text().trim();
      if (!createdAtText) {
        const timeMatch = card.text().match(/(?:создано|опубликовано)\s*[:\-]?\s*(\d+\s*(?:минут|час|день|сек|мин)\s*назад)/i);
        createdAtText = timeMatch ? timeMatch[1] : 'Только что';
      }

      const projId = relativeLink.split('/').pop()?.split('-')?.[0] || String(Math.abs(hashString(fullLink)));

      projects.push({
        id: projId,
        categoryUrl: url,
        title,
        budget,
        description,
        offersCount,
        createdAtText,
        link: fullLink,
        scrapedAt: new Date().toISOString()
      });
    });
  }

  return projects;
}

// Global counters & statuses
let isCurrentlyParsing = false;
let lastPulseTimestamp = new Date().toISOString();
let errorCount = 0;
let uptimeTimer = 0;
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

        // Random delay (1000ms - 5000ms) inside loop to mimic human reading and avoid Kwork blocks
        const randomWait = 1000 + Math.random() * 4000;
        await new Promise(resolve => setTimeout(resolve, randomWait));

      } catch (catError: any) {
        errorCount++;
        addLog('error', `Не удалось спарсить данные с URL "${category.url}": ${catError.message}`);
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
    const delay = Math.max(15000, baseMs + jitter); // Min 15 seconds
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
