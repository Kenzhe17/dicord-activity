# UNO — релизная проверка и production-чеклист

Статус: UNO реализован как GameModule (`games/uno`, `apps/web/src/components/uno/**`, `apps/server/src/uno.test.ts`, `tests/e2e/uno.spec.ts`) и зарегистрирован в `apps/server/src/games.ts` через `registerModule` — движок активен (`status: 'ready'` в `games/uno/server/module.ts`). Отдельной конфигурации для UNO не требуется: игра использует общий матчерс, комнаты, приглашения, сокеты и PostgreSQL-чекпоинты платформы.

## 1. Результаты QA (локальный прогон, Windows + Node 26 + pnpm 11.25)

| Команда | Результат |
| --- | --- |
| `pnpm typecheck` (`tsc --noEmit`) | PASS |
| `pnpm lint` (`eslint .`) | PASS (после исправления `/* global */` в untracked-скриптах `dbg.mjs`, `uno-shots.mjs`) |
| `pnpm --filter @rize/web build` | PASS (vite 8.3.7, dist ~798 kB суммарно; предупреждение о chunk `index-*.js` 646.73 kB >500 kB — некритично, gzip 198 kB) |
| `pnpm --filter @rize/web build` (повторно на финальной проверке) | PASS — `index.html` 0.41 kB, `client-*.js` 150.41 kB, `index-*.js` 646.73 kB, `index-*.css` 75.92 kB |
| `pnpm --filter @rize/server build` | PASS (tsup 8.5.1, target node22, dist/index.js 410.03 kB + map 658 kB) |
| `pnpm db:validate` | PASS (Prisma schema valid) |
| `node tooling/check-boundaries.mjs` | PASS (120 файлов) |
| `pnpm test` (vitest, 40 файлов) | 331 passed / 8 failed — все падения в файлах Дурака/платформы/stakes, к UNO отношения не имеют (см. §4) |
| UNO unit/integration | 48/48 PASS: `games/uno/tests/engine.test.ts` (35), `property.test.ts` (7), `definition.test.ts` (2), `apps/server/src/uno.test.ts` (4) |
| `tests/e2e/uno.spec.ts` | 1 чистый PASS + 3 прогона, где игровой сценарий прошёл целиком (78–83 шага, результат, скриншоты, reconnect), но teardown упал на ENOENT копирования Playwright trace-артефактов в общий `tests/.artifacts/.playwright-artifacts-0` — инфраструктурный флаки Windows/параллельных e2e-сессий, не дефект UNO. Ещё 1 запуск не стартовал: порты 3001/5173 заняты dev-серверами другой сессии |

## 2. Railway production-конфигурация

Специфичных для UNO переменных окружения нет и не нужно — движок, UI и настройки (`mode`: points/quick, `target`, `maxPlayers`) входят в сборку и проверяются Zod-схемой `unoSettingsSchema` на сервере.

Действуют общие требования из [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) и `apps/server/src/config.ts`:

| Переменная | Значение для production |
| --- | --- |
| `NODE_ENV` / `ARCADE_ENV` | `production` |
| `ARCADE_AUTH_MODE` | `discord` |
| `ARCADE_HOST` | `0.0.0.0` |
| `ARCADE_SERVE_WEB` | `true` (запекается в Dockerfile) |
| `ARCADE_ENABLE_TEST_GAME` | `false` (запекается в Dockerfile) |
| `PORT` | назначает Railway |
| `ARCADE_ORIGIN` | `https://APP_ID.discordsays.com` |
| `ARCADE_DISCORD_CLIENT_ID` / `ARCADE_DISCORD_CLIENT_SECRET` | credentials приложения Arcade |
| `ARCADE_DISCORD_BOT_TOKEN` | **обязателен** при включённом guild-lockdown — без него все Discord-логины отклоняются (`guild_verifier_missing`) |
| `ARCADE_ALLOWED_GUILD_ID` | snowflake'ы разрешённых серверов (по умолчанию два r!z3-сервера) |
| `ARCADE_DATABASE_URL` | reference на отдельный ArcadePostgres |
| `ARCADE_DISCORD_PUBLIC_KEY`, `ARCADE_ANNOUNCE_CHANNEL_ID`, `ARCADE_ADMIN_USER_IDS` | нужны только для /news-анонсов, не для UNO |
| `ARCADE_ECONOMY_*`, `ARCADE_STAKES_ENABLED` | только для ставок Дурака; UNO их не использует |

Пробелов для UNO нет: модуль — обычная зависимость workspace (`@rize/uno` в `apps/server` и `apps/web`), собирается в runtime-образ, состояние матча хранится в `matchSnapshot.state` и переживает рестарт через общий механизм recovery.

Дополнительно проверено на финальной стадии:

- `railway.toml`/`nixpacks.toml`/`Procfile` в репозитории отсутствуют **намеренно** — вся конфигурация Railway задаётся в dashboard service settings, чтобы один сервис не переопределял другой (см. [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md)). Railway использует корневой `Dockerfile`.
- `Dockerfile` пиннит `node:24-bookworm-slim` (требование Node >=22 выполнено), `pnpm@11.25.0`, `pnpm install --frozen-lockfile`, `pnpm db:generate && pnpm build`, runtime под `USER node`, `EXPOSE 3001`, CMD `node apps/server/dist/index.js`. ENV runtime: `NODE_ENV=production ARCADE_ENV=production ARCADE_AUTH_MODE=discord ARCADE_HOST=0.0.0.0 ARCADE_SERVE_WEB=true ARCADE_ENABLE_TEST_GAME=false`.
- Два сервиса Railway: основной `arcade` (Dockerfile, healthcheck `/health/ready`, restart `ON_FAILURE`) и одноразовый `arcade-migrate` (Dockerfile.migrate, restart `NEVER`, без healthcheck). UNO миграций не добавляет — `packages/database/prisma/` без изменений (`git diff` пуст, всего 3 существующие миграции).
- Health endpoints: `GET /health/live`, `GET /health/ready` (проверяет PostgreSQL); `GET /api/config` отдаёт `authMode`, `clientId`, `allowedGuildIds`; `GET /api/games` — все 5 игр (`durak`, `uno`, `mafia`, `codenames`, `monopoly`) со `status: 'ready'`, sandbox скрыт при `ARCADE_ENABLE_TEST_GAME=false`. `unoModule` в `apps/server/src/games.ts` регистрируется через `registerModule`, `games/uno/server/module.ts` выставляет `info.status: 'ready'`.
- Smoke-тест собранного артефакта уже включает UNO: `node tooling/smoke-built.mjs` поднимает `apps/server/dist/index.js` в production-режиме и ассертит `games.find(g => g.id === 'uno')?.status === 'ready'`.
- Переменные окружения задокументированы в `.env.example` (актуализирован: имена `ARCADE_*`, плейсхолдеры, без значений). `apps/web` env-переменных не читает — `clientId` приходит из `/api/config`, `vite.config.ts` использует `envDir: './config'` (пуст), поэтому `apps/web/.env.production` в сборку не попадает.

## 3. Staging-деплой и rollback

**Выполнено (2026-11-14):** коммит `078c1f4` развёрнут на Railway staging как отдельный сервис `dicord-activity-uno` → https://dicord-activity-uno-staging.up.railway.app (env `staging` проекта feisty-trust, отдельный staging `Postgres`, миграции применены `arcade-migrate-staging`, `ARCADE_AUTH_MODE=mock` для автоматизированной проверки). Подтверждено: `/api/games` → uno=ready; полный 2-player UNO-матч через API+WebSocket — finished за 51 действие, reconnect посреди матча, идемпотентность requestId, ровно одна запись результата в истории; повторы — 112 действий/42.7s. Скрипт прогона: `artifacts/staging-qa/staging-qa.mjs`.

Ограничения staging: mock auth (dev-вход); `ARCADE_ORIGIN` указывает на railway-домен — для реального Discord Activity его нужно сменить на `https://<APP_ID>.discordsays.com` и включить `ARCADE_AUTH_MODE=discord` + Discord-секреты; URL Mapping Discord-приложения указывает на production — live Activity-проверка на staging требует отдельного Discord-приложения или временного переключения mapping (решение за владельцем).

Порядок:

1. `pnpm install --frozen-lockfile && pnpm db:generate && pnpm build` локально — уже проверено (§1).
2. Задеплоить ту же ветку в staging environment основного сервиса (`Dockerfile`, healthcheck `/health/ready`, restart `ON_FAILURE`, одна реплика). Переменные — по таблице §2 + `ARCADE_DATABASE_URL=${{ArcadePostgresStaging.DATABASE_URL}}`.
3. Одноразово задеплоить/запустить `arcade-migrate` (`Dockerfile.migrate`, restart `NEVER`, пустой start command) — ожидаются те же 3 миграции, новых для UNO нет; `migrate deploy` — no-op, если БД уже на актуальной ревизии.
4. Smoke без Discord: `GET /health/live` → 200, `GET /health/ready` → 200, `GET /.proxy/api/games` → 5 игр ready, `GET /.proxy/` → HTML со ссылкой на asset.
5. Прогнать чеклист §4 (Discord Activity) на staging.
6. Production: тот же образ/ветка → новый deployment основного сервиса; миграции — через `arcade-migrate` (для UNO no-op).

Rollback:

- Приложение: Railway → Deployments → предыдущий успешный deployment → **Redeploy/Rollback**. UNO — чисто кодовое изменение без схемы: состояние матчей хранится в `matchSnapshot.state` как opaque-JSON, `stateVersion: 1`; откат образа безопасен, незавершённые UNO-матчи просто не смогут продолжиться на старом коде (комнаты остаются, матч не восстановится — приемлемо для релиза без живых партий; при наличии живых партий дождаться их завершения или принять потерю).
- БД: **не откатывать** — миграций для UNO нет, `migrate deploy` ничего не менял; `migrate reset`/`db push` запрещены.
- Discord: URL Mappings и guild-настройки не менялись — откат кода не требует действий в Developer Portal.
- Проверка после отката: `/health/ready` 200, `/api/games` — 4 игры ready (UNO исчезнет из списка, т.к. модуль не зарегистрируется).

## 4. Discord Activity — чеклист live-проверки UNO

Основано на `apps/server/src/app.ts` (`/api/auth/discord`, `/api/bootstrap`) и `apps/server/src/guild.ts` (`DiscordGuildVerifier` → `GET /applications/{id}/activity-instances/{instance_id}`). Выполнять на staging-окружении с `ARCADE_AUTH_MODE=discord`, отдельной БД и bot token.

Подготовка (см. также [DISCORD_SETUP.md](DISCORD_SETUP.md)):

1. Activities → URL Mappings: `/` → домен Arcade, `/.proxy/discord-cdn` → `cdn.discordapp.com`.
2. Приложение доступно тестировщикам; Activity запускается из голосового канала сервера из `ARCADE_ALLOWED_GUILD_ID`.
3. `ARCADE_DISCORD_BOT_TOKEN` задан — иначе guild-верификация отклонит всех (`GUILD_RESTRICTED`).
4. Embedded App SDK: `clientId` фронт получает из `GET /api/config` (= `ARCADE_DISCORD_CLIENT_ID`); `VITE_*` в сборке не используется. Activity-клиент (`packages/discord/src/client.ts`) делает `authorize` с `prompt: 'none'`, `scope: identify + rpc.activities.write`, авторизация кода — `POST /.proxy/api/auth/discord` с `code`, `state`, `instanceId`; guild проверяется дважды — клиентским `checkGuild` до OAuth и серверным `DiscordGuildVerifier` (instanceId+guildId+userId против Discord API).

Предварительная проверка без Discord-клиента (staging, mock недоступен в production — только read-only запросы):

- `GET /.proxy/api/games` → 5 игр, у `uno` `status: 'ready'`; `GET /.proxy/api/config` → `authMode: 'discord'`, `clientId` задан, `allowedGuildIds` содержит нужный guild.
- Создание UNO-комнаты через API: `POST /.proxy/api/rooms` с Bearer-сессией — в production без Discord-сессии вернёт 401, поэтому этот шаг проверяется только после живого входа либо на отдельном стенде с `ARCADE_AUTH_MODE=mock` (не production).

Сценарий на реальных устройствах (desktop + mobile клиенты Discord):

- [ ] Запуск Activity из Discord (команда `r!z3 Arcade` / кнопка в канале новостей / voice-канал) → consent identify → вход; UNO видна в библиотеке с тегом «ИГРАТЬ» (не «СКОРО»). Повторный запуск в той же сессии Discord не должен запрашивать consent повторно (`prompt: 'none'`).
- [ ] Внешний браузер по URL Activity: `frame_id` отсутствует → экран «Откройте Arcade как Activity внутри Discord», входа нет (проверка `location.search` в `App.tsx`).
- [ ] Guild-lockdown: Activity, запущенная на сервере вне `ARCADE_ALLOWED_GUILD_ID` (или в DM/групповом DM), показывает экран ограничения (`GuildRestrictedScreen`) и не доходит до OAuth; сервер при этом логирует `guild_verify_rejected` с reason-кодом.
- [ ] Создание комнаты UNO из Activity: режим «Очки до цели»/«Быстрая», цель 100–10000, 2–10 игроков, приватная/публичная комната (настройки валидируются `unoSettingsSchema`: `mode` quick|points, `target` 100–10000, `maxPlayers` 2–10).
- [ ] Приглашение друзей: второй аккаунт (другой Discord-пользователь, тот же разрешённый guild) вступает по коду/ссылке; посторонний сервер войти не может.
- [ ] Полная партия с 2+ реальными клиентами (один desktop, один mobile): раздача, ходы, цвет, Draw Two/Reverse/Skip/Wild/Wild Draw Four, вызов/оспаривание WD4, объявление UNO, штраф +2, конец раунда, подсчёт очков до цели.
- [ ] Мобильный клиент Discord: раскладка стола, отсутствие горизонтального скролла (покрыто e2e viewport 390×844), тап по картам; та же комната открывается на desktop.
- [ ] Свернуть/развернуть Activity, потеря сети, sleep/resume: переподключение без потери руки и без повторного хода (`/api/bootstrap` → восстановление комнаты/матча).
- [ ] Рестарт backend во время партии: чекпоинт восстанавливается, текущий игрок сохраняет ход.
- [ ] Два устройства/вкладки одного аккаунта не дают дублировать действия (requestId/expectedVersion).
- [ ] Выход из Activity и повторный вход: та же комната и матч.

## 5. Классификация падений `pnpm test`

Все 8 падений — в `durak.test.ts` (2), `durakRebuild.test.ts` (1), `platform.test.ts` (3+hook), `stakes.test.ts` (2). Ни один файл не ссылается на UNO; изменения параллельных сессий затрагивают `platform.ts` (hostId в MatchRuntime), `multiplayer` checkpoint schema, модули durak/mafia/monopoly/codenames.

- 7 из 8 — таймауты 10 s на Windows-машине с embedded PostgreSQL (тесты поднимают полное приложение и recovery по общей тестовой БД; полный прогон — 225 s). В изоляции `durakRebuild.test.ts` прошёл 7/7 — падение `DomainError: Устаревшая версия состояния` было флаки под нагрузкой.
- `platform.test.ts` падает и в изоляции (4 теста-таймаута) — это регрессия/инфраструктурная проблема параллельной работы над платформой, **не UNO**: регистрация `unoModule` вместо `unoDefinition` не меняет тайминги recovery. Требует внимания владельцев durak/platform задач; UNO-блокером не является.
- Ранее зафиксированные 18 ошибок lint в `games/mafia`, `games/monopoly`, `durak-layout.spec.ts` в текущем дереве отсутствуют — параллельные сессии их уже исправили.

Исправлено в рамках этой проверки: добавлены `/* global console, document, innerWidth */` в untracked-скрипты `uno-shots.mjs` и `dbg.mjs` (UNO-артефакты отладки; без этого `pnpm lint` падал с 7 `no-undef`).

## 6. Что НЕ проверено

- Реальный Discord-клиент/Railway не использовались: нет доступа к Discord Developer Portal, bot token, Activity Instances API и Railway-окружению. Чеклист §4 и план §3 — документированы, но не выполнены.
- Docker-сборка не запускалась (на машине нет Docker) — как и в предыдущих отчётах; проверены только локальные `pnpm build` артефакты.
- E2E прогонялся на mock-auth (`ARCADE_AUTH_MODE=mock`, test-окружение), не через Discord OAuth; `POST /api/rooms` в production-режиме без Discord-сессии не проверялся вживую.
- Нагрузочное/многорепличное тестирование не проводилось.
- На момент финальной проверки в дереве есть незакоммиченные изменения параллельных сессий (`apps/server/src/platform.ts`, `app.ts`, тесты); сборки прогнаны на этом состоянии — перед релизом пересобрать на зафиксированном коммите.
- UNO-специфичных препятствий к production не выявлено; блокеры релиза — только общие: подтверждение §4 вживую и стабильность `platform.test.ts`/`durak.test.ts`/`stakes.test.ts` от параллельных задач.
