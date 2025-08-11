require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
    LOGIN,
    PASSWORD,
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID
} = process.env;

const LOGIN_URL = 'https://megawatt.charging123.com/admin/login';
const LIST_URL = 'https://megawatt.charging123.com/admin/charge-boxes';
const SENT_FILE = path.join(__dirname, 'sent_stations.json');
const INTERVAL_MS = 5 * 60 * 1000; // 5 минут

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// --- Работа с файлом ---
function loadSentStations() {
    try {
        const raw = fs.readFileSync(SENT_FILE, 'utf8');
        // нормализуем (trim) сразу при загрузке
        return JSON.parse(raw).map(s => s.trim());
    } catch {
        return [];
    }
}

function saveSentStations(arr) {
    // сохраняем чистый массив строк
    fs.writeFileSync(SENT_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// --- Telegram ---
async function sendTelegram(text) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error('❌ Telegram:', e.message);
    }
}

// --- Основная проверка ---
async function authAndCheck() {
    const sentStations = loadSentStations();
    console.log('🔍 Загружено из JSON:', sentStations.length, 'станций');

    const isHeadless = process.env.HEADLESS !== 'false'; // по умолчанию true на сервере

    const browser = await puppeteer.launch({
        headless: isHeadless,
        slowMo: 10,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114 Safari/537.36'
    );

    // логинимся
    console.log('🌐 Открываем логин...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="username"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="username"]', LOGIN, { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await page.type('input[type="password"]', PASSWORD, { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('✅ Залогинились');

    // переходим на список
    await page.goto(LIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    let pageNum = 1;
    while (true) {
        console.log(`📄 Страница ${pageNum}...`);
        await page.waitForSelector('table tbody tr', { timeout: 20000 });

        // собираем все строки со статусами
        const rows = await page.$$eval('table tbody tr', trs =>
            trs.map(tr => {
                const cols = tr.querySelectorAll('td');
                return {
                    name: cols[1]?.innerText.trim(),
                    partner: cols[2]?.innerText.trim(),
                    status: cols[3]?.innerText.trim().toLowerCase(),
                    time: cols[7]?.innerText.trim()
                };
            })
        );

        // --- 1) ONLINE → если была в sentStations → уведомляем зелёным + удаляем ---
        for (const st of rows.filter(r => r.status === 'online' || r.status === 'active')) {
            const name = st.name.trim();
            const idx = sentStations.indexOf(name);
            if (idx !== -1) {
                const msg =
                    '🟢 *Станция вернулась ONLINE* 🟢\n\n' +
                    `*Название:* ${name}\n` +
                    `*Партнёр:* ${st.partner}\n` +
                    `*Текущее время:* ${st.time}`;
                await sendTelegram(msg);
                sentStations.splice(idx, 1);
                console.log('🟢 Удалили из JSON:', name);
                await sleep(500);
            }
        }

        // --- 2) OFFLINE → если нет в sentStations → уведомляем красным + добавляем ---
        for (const st of rows.filter(r => r.status === 'offline')) {
            const name = st.name.trim();
            if (!sentStations.includes(name)) {
                const msg =
                    '⚠️ *СТАНЦИЯ ВЫШЛА OFFLINE* ⚠️\n\n' +
                    `*Название:* ${name}\n` +
                    `*Партнёр:* ${st.partner}\n` +
                    `*Время вылета:* ${st.time}`;
                await sendTelegram(msg);
                sentStations.push(name);
                console.log('⚠️ Добавили в JSON:', name);
                await sleep(500);
            }
        }

        // пагинация
        const nextBtn = await page.$('ul.pagination li:last-child:not(.disabled) a');
        if (!nextBtn) break;
        await nextBtn.click();
        await page.waitForTimeout(2000);
        pageNum++;
    }

    // сохраняем изменения
    saveSentStations(sentStations);
    console.log('✅ Проверка завершена. В JSON сейчас:', sentStations.length, 'станций');

    await browser.close();
}

// --- Запуск по расписанию ---
(async () => {
    while (true) {
        console.log(`🕐 Старт: ${new Date().toLocaleString()}`);
        await authAndCheck();
        console.log(`⏳ Ждём ${INTERVAL_MS / 60000} мин...`);
        await sleep(INTERVAL_MS);
    }
})();
