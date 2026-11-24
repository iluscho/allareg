# allareg — сайт regressional.ru и Telegram-бот

Репозиторий содержит статический сайт программы «Интегративная регрессионная гипнотерапия»
и код бота, который:

- **управляет расписанием** — добавление, изменение, удаление и порядок мероприятий;
- **принимает заявки** с формы на сайте («Заявка на гипнотерапию») и присылает их в Telegram.

```
┌──────────────────────────┐        GET /api/schedule        ┌───────────────────────────┐
│  GitHub Pages            │ ──────────────────────────────► │  Бот + API                │
│  index.html + config.js  │                                 │  • Node.js на сервере     │
│                          │        POST /api/requests       │    или                    │
│  форма заявки            │ ──────────────────────────────► │  • Cloudflare Worker      │
└──────────────────────────┘                                 └─────────────┬─────────────┘
                                                                           │ Telegram
                                                                           ▼
                                                                     ┌───────────┐
                                                                     │  админ    │
                                                                     └───────────┘
```

Есть два варианта запуска. Код один и тот же, отличается только транспорт и хранилище:

| | **Cloudflare Workers** | **Node.js на сервере** |
|---|---|---|
| Стоимость | бесплатно, без карты | VPS от ~2–5 $/мес |
| Работа 24/7 | да (Telegram сам шлёт вебхук) | да, процесс должен жить |
| Что нужно | аккаунт Cloudflare | сервер + HTTPS-домен |
| Логика бота | та же | та же |
| Данные | D1 (SQLite в облаке) | `data/*.json` |

**Если нужен бесплатный вариант — берите Cloudflare Workers**, инструкция ниже первая.

## Как добавить проект в репозиторий

Если вы получили проект архивом — распакуйте его в папку с клоном репозитория (там, где лежат
`index.html` и `schedule.json`), затем закоммитьте:

```bash
git add -A
git commit -m "Telegram-бот: расписание и заявки с сайта"
git push
```

`node_modules/`, `data/`, `.env`, `.dev.vars` и `.wrangler/` в git не попадают — они в `.gitignore`.

---

## Что умеет бот

**Мероприятия** (отдельно «Очно · Оренбург» и «Онлайн»):

- ➕ добавить — пошагово: формат → даты → название → номер;
- ✏️ изменить даты, название или номер;
- ⬆️⬇️ поменять порядок;
- 🗑 удалить с подтверждением;
- 🔢 перенумеровать список по порядку (01, 02, 03 …).

**Заявки:**

- каждая заявка с сайта приходит отдельным сообщением: имя, контакт, тема, удобное время, текст;
- кнопки «✅ Обработана», «🗑 Удалить», список заявок с постраничной выдачей.

**Доступ** — только для Telegram ID из `ADMIN_IDS`. Остальные видят сообщение, что бот служебный.
Команда `/id` показывает ваш ID — она доступна всем, чтобы можно было настроить доступ.

---

## Вариант 1. Cloudflare Workers — бесплатно

### Почему это работает

- Telegram присылает обновления **вебхуком** на адрес воркера — постоянный процесс не нужен,
  поэтому бесплатный тариф подходит.
- Бесплатный план Workers: **100 000 запросов в сутки**, D1 — **5 ГБ**, 5 млн чтений и
  100 000 записей в сутки. У бота на несколько человек это сотни запросов в день,
  то есть запас в сотни раз ([тарифы Workers](https://developers.cloudflare.com/workers/platform/pricing/)).
- Адрес `https://allareg-bot.<аккаунт>.workers.dev` сразу с HTTPS, домен покупать не нужно.

Почему не Render Free: бесплатный сервис засыпает через 15 минут и просыпается около минуты —
Telegram не будет столько ждать ответа, бот будет «отваливаться»
([документация Render](https://render.com/docs/free)).

### Что понадобится

- аккаунт Cloudflare (бесплатный, карта не нужна);
- Node.js 20+ на компьютере — только чтобы выполнить команды деплоя;
- токен бота от [@BotFather](https://t.me/BotFather).

### Пошагово

```bash
git clone https://github.com/iluscho/allareg.git
cd allareg
npm install
npx wrangler login          # откроется браузер, войдите в Cloudflare
```

**1. Создать базу D1** и вставить её `database_id` в `wrangler.toml`:

```bash
npx wrangler d1 create allareg
```

В выводе будет строка вида `database_id = "xxxxxxxx-...."` — замените заглушку
`00000000-0000-0000-0000-000000000000` в `wrangler.toml`.

**2. Применить схему** (таблицы для расписания, заявок и незавершённого ввода):

```bash
npx wrangler d1 execute allareg --remote --file=worker/schema.sql
```

**3. Задать секреты.** Токен и ID администратора:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_IDS
```

`ADMIN_IDS` можно оставить пустым на первом деплое — потом добавите, узнав ID через `/id`.
Третий секрет — случайная строка не короче 16 символов, она защищает вебхук:

```bash
npx wrangler secret put WEBHOOK_SECRET
```

Сгенерировать строку можно так: `openssl rand -hex 24`
(Windows PowerShell: `-join ((48..57)+(97..102) | Get-Random -Count 48 | % {[char]$_})`).

**4. Опубликовать воркер:**

```bash
npx wrangler deploy
```

В выводе будет адрес вида `https://allareg-bot.ваш-аккаунт.workers.dev` — сохраните его.

**5. Связать Telegram с воркером.** Заполните в `.env` три переменные:

```env
BOT_TOKEN=123456789:AA...
WEBHOOK_URL=https://allareg-bot.ваш-аккаунт.workers.dev
WEBHOOK_SECRET=та-же-строка-что-в-секрете
```

и выполните:

```bash
npm run cf:webhook
```

Скрипт вызовет `setWebhook` и покажет состояние. Теперь напишите боту `/start`, затем `/id`
и добавьте свой ID:

```bash
npx wrangler secret put ADMIN_IDS
```

Секрет применяется сразу, повторный `deploy` не нужен. Снова `/start` — появится панель.

**6. Подключить сайт.** В `config.js`:

```js
window.SITE_CONFIG = {
  apiBase: 'https://allareg-bot.ваш-аккаунт.workers.dev',
  telegram: 'https://t.me/ваш-аккаунт', // необязательно
};
```

Закоммитить и запушить — GitHub Pages обновится через минуту.

### Проверка

- `https://allareg-bot.…workers.dev/api/health` — должен вернуть `{"ok":true,...}`;
- бот отвечает на `/start` и показывает панель;
- на сайте расписание совпадает с ботом, заявка приходит в Telegram.

### Обновление и логи

```bash
npx wrangler deploy        # выкатить новую версию кода
npx wrangler tail          # смотреть логи в реальном времени
npm run cf:webhook         # переустановить вебхук (например, после смены URL)
```

### Ограничения и нюансы

- На бесплатном плане 10 мс CPU на запрос. Нашему коду хватает с запасом (сборка — 254 КиБ,
  48 КиБ gzip), но тяжёлые вычисления сюда добавлять не стоит.
- Домен `workers.dev` может быть медленнее или недоступен из некоторых сетей.
  Тогда добавьте сайт в Cloudflare (бесплатно, меняются NS-записи домена) и привяжите
  `bot.regressional.ru` в разделе **Workers → Settings → Domains & Routes**.
- Заявки и расписание лежат в D1. Бэкап:

  ```bash
  npx wrangler d1 export allareg --remote --output=backup.sql
  ```

- Если позже переедете на VPS, удалите вебхук: `npm run cf:webhook:delete`,
  иначе бот будет ждать сообщения на Cloudflare.

### Локальная разработка воркера

```bash
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars
# вписать BOT_TOKEN, ADMIN_IDS, WEBHOOK_SECRET
npm run cf:db:init:local
npm run cf:dev
```

Сайт на `http://localhost:8787` (API), Telegram до localhost не достучится —
для проверки бота используйте тесты или туннель.

---

## Вариант 2. Свой сервер (Node.js)

Нужен VPS с HTTPS. Бот работает через длинный polling, данные — в `data/*.json`.
Подходит, если хостинг уже есть или нужен полный контроль (например, бесплатный
Oracle Cloud Always Free — но там требуется карта для верификации).

### Быстрый старт

```bash
git clone https://github.com/iluscho/allareg.git
cd allareg
npm install --omit=dev

cp .env.example .env        # Windows: copy .env.example .env
```

В `.env`: `BOT_TOKEN`, затем `ADMIN_IDS` (свой ID узнаете командой `/id`).

```bash
npm start
```

Откройте `http://localhost:8080` — это тот же сайт, но с живым API.

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Данные — в `./data` на хосте, переживают перезапуск.

### systemd

```bash
sudo cp deploy/allareg-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now allareg-bot
sudo journalctl -u allareg-bot -f
```

Пути и пользователя поправьте в юните под свой сервер.

### HTTPS

GitHub Pages работает по HTTPS, поэтому API тоже должен быть по HTTPS — иначе браузер
заблокирует запросы. Проще всего Caddy:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # свой домен
sudo systemctl reload caddy
```

И поставьте `TRUST_PROXY=1` в `.env`, иначе ограничение частоты будет считать всех одним IP.

### Подключение сайта

```js
window.SITE_CONFIG = { apiBase: 'https://bot.regressional.ru', telegram: '' };
```

Закоммитить и запушить.

---

## Настройки

### Cloudflare (секреты и переменные)

| Имя | Где задаётся | Назначение |
|---|---|---|
| `BOT_TOKEN` | `wrangler secret put` | Токен бота |
| `ADMIN_IDS` | `wrangler secret put` | ID администраторов через запятую |
| `WEBHOOK_SECRET` | `wrangler secret put` | Защита вебхука, ≥ 16 символов |
| `SITE_URL` | `wrangler.toml` | Подпись сайта в боте |
| `TZ_NAME` | `wrangler.toml` | Часовой пояс дат |
| `ALLOWED_ORIGINS` | `wrangler.toml` | `*` или список доменов через запятую |
| `RATE_LIMIT_MAX` | `wrangler.toml` | Заявок с одного IP за окно |
| `RATE_LIMIT_WINDOW_MS` | `wrangler.toml` | Длина окна, мс |

### Node.js (`.env`)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BOT_TOKEN` | — | Токен от BotFather |
| `ADMIN_IDS` | — | Telegram ID администраторов |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP-сервер |
| `SITE_URL` | `https://regressional.ru` | Подпись сайта |
| `ALLOWED_ORIGINS` | `*` | Домены для CORS |
| `TRUST_PROXY` | `0` | `1` за Nginx/Caddy |
| `DATA_DIR` | `data` | Каталог с JSON |
| `SEED_SCHEDULE` | `schedule.json` | Начальное расписание |
| `TZ_NAME` | `Europe/Moscow` | Часовой пояс |
| `RATE_LIMIT_MAX` | `5` | Заявок с IP за окно |
| `RATE_LIMIT_WINDOW_MS` | `600000` | Окно, мс |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

---

## API

Ответы — JSON, CORS открыт, чтобы форма работала с GitHub Pages.

### `GET /api/health`

```json
{ "ok": true, "runtime": "cloudflare-worker", "events": { "onsite": 10, "online": 10 }, "requests": { "total": 0, "new": 0 } }
```

### `GET /api/schedule`

```json
{
  "onsite": [{ "num": "01", "dates": "12–13 декабря 2026", "title": "Эриксоновский гипноз" }],
  "online": []
}
```

### `POST /api/requests`

```bash
curl -X POST https://allareg-bot.ваш-аккаунт.workers.dev/api/requests \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Анна",
    "contact": "@anna",
    "topic": "therapy",
    "preferredTime": "после 18:00",
    "message": "Хочу на индивидуальную сессию",
    "consent": true
  }'
```

Успех — `201 { "ok": true, "id": 1 }`. Ошибки валидации — `400` с объектом `fields`,
слишком часто — `429` с заголовком `Retry-After`.

Темы: `therapy` — гипнотерапия, `course` — обучение, `other` — другой вопрос.

Защита: honeypot-поле `website`, лимиты длины полей, лимит частоты по IP.

---

## Данные и резервные копии

**Cloudflare:** таблицы в D1 (`state`, `pending`, `rate_limit`), выгрузка —
`npx wrangler d1 export allareg --remote --output=backup.sql`.

**Node.js:** `data/schedule.json` и `data/requests.json`, каталог исключён из git.

```bash
tar -czf backup-$(date +%F).tar.gz data/
```

При первом запуске расписание создаётся из `schedule.json` сайта.

---

## Безопасность

- токен и `.env` **никогда** не коммитятся: `.env` в `.gitignore`, а в `.env.example` только пустые значения;
- если токен всё же попал в git или в переписку — перевыпустите его у @BotFather (`/revoke`);
- управление доступно только ID из `ADMIN_IDS`;
- вебхук защищён секретом (`X-Telegram-Bot-Api-Secret-Token`);
- заявки хранятся только у вас и не уходят третьим лицам;
- в форме есть обязательное согласие на обработку персональных данных; текст согласия
  стоит проверить на соответствие 152-ФЗ.

---

## Тесты

```bash
npm test
```

52 теста: логика расписания и заявок, HTTP API, атомарная запись, D1-хранилище,
маршруты Cloudflare Worker и полный сценарий бота (меню → добавление → изменение →
удаление → заявка) на мок-сервере Telegram API. Токен для тестов не нужен.

---

## Структура проекта

```
index.html              # сайт: расписание и форма заявки
config.js               # адрес API и ссылка на Telegram
schedule.json           # статический резерв расписания
src/                    # Node-версия и общая логика
├── botCore.js          # команды, кнопки, пошаговые формы
├── bot.js              # Node-обвязка: polling и память
├── botViews.js         # тексты и клавиатуры (правки оформления — здесь)
├── server.js           # Express: API и локальная раздача сайта
├── services.js         # операции над расписанием и заявками
├── schedule.js         # модель мероприятий
├── requests.js         # модель и валидация заявок
├── storage.js          # атомарная запись JSON
├── seed.js             # первичное расписание
└── index.js            # точка входа Node-версии
worker/                 # Cloudflare Workers
├── index.js            # export default fetch
├── app.js              # маршруты, API, вебхук
├── store.js            # JSON-документы в D1
├── pendingStore.js     # незавершённый ввод в D1
└── schema.sql          # таблицы
scripts/set-webhook.mjs # привязка/отвязка вебхука
test/                   # тесты и моки
deploy/                 # systemd и Caddyfile
wrangler.toml           # конфигурация Cloudflare
Dockerfile, docker-compose.yml
```

---

## Частые вопросы

**Бот молчит после деплоя на Cloudflare.** Проверьте `npx wrangler tail`, затем
`npm run cf:webhook` и `getWebhookInfo` (скрипт показывает состояние). Убедитесь, что
`WEBHOOK_SECRET` в `.env` совпадает с секретом в Cloudflare.

**Telegram возвращает 401 на вебхук.** Не совпадает секрет: путь `/telegram/<секрет>`
и заголовок `X-Telegram-Bot-Api-Secret-Token` должны содержать одно и то же значение.

**Заявка сохраняется, но в Telegram не приходит.** Пустой `ADMIN_IDS` или вы не отправили
боту `/start` с этого аккаунта — Telegram не даёт боту писать первым.

**Форма пишет «Не удалось отправить заявку».** Не заполнен `apiBase` в `config.js`,
воркер не задеплоен или стоит HTTP вместо HTTPS (со страницы Pages браузер заблокирует запрос).

**Изменения в боте не видны на сайте.** Сайт работает на статическом `schedule.json`,
то есть `apiBase` не задан. Укажите адрес API/воркера в `config.js` и закоммитьте.

**Как изменить тексты сообщений?** `src/botViews.js` — все тексты и кнопки там.

**Как добавить администратора?** Дописать ID в `ADMIN_IDS` (в Cloudflare — `wrangler secret put`,
в Node — в `.env` и перезапустить).

**Как менять темы обращения?** `src/requests.js` → `TOPICS` и `option value` в `index.html`.
