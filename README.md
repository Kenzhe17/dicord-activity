# r!z3 Arcade

Игровой хаб внутри Discord Embedded Activity. Этап 3: Дурак — подкидной и переводной. Ветка: codex/arcade-rebuild.

Работают авторизация, постоянные комнаты, приглашения, переподключение, запуск GameModule, история и статистика. Дурак доступен для 2–6 игроков по согласованным правилам. UNO доступна для 2–10 игроков (очки до цели, быстрая партия) — правила и QA в docs/UNO_RELEASE.md. Мафия имеет статус **«Скоро»**. Отдельный тестовый модуль sandbox доступен только в development/test.

## Локальный запуск

Нужны Node.js 22.13+ (рекомендуется 24 LTS) и pnpm 11.25.0.

~~~powershell
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:local
~~~

Оставьте PostgreSQL работающим в первом терминале. Во втором:

~~~powershell
pnpm db:migrate:local
pnpm db:migrate:test
pnpm dev
~~~

Откройте [http://127.0.0.1:5173](http://127.0.0.1:5173). API: порт 3001. Используйте именно 127.0.0.1 из-за проверки Origin.

Локальный PostgreSQL 18 слушает loopback:55432. Данные и автоматически созданные реквизиты сохраняются **вне репозитория**, в ~/.rize3-arcade/local-postgres. Создаются отдельные arcade_dev и arcade_test. Скрипты не читают старые env-файлы и не обращаются к базе бота. Остановка PostgreSQL не удаляет данные. Встроенный PostgreSQL предназначен для разработки.

pnpm dev включает mock-вход и sandbox. Для проверки откройте два независимых браузерных контекста, войдите двумя игроками, выберите «Дурак», режим и вместимость, создайте комнату и присоединитесь вторым игроком. Оба отмечают готовность, хост запускает партию. Игроки атакуют и защищаются картами. Разрешённые карты подсвечивает сервер; для защиты выберите свою карту, затем цель на столе и «Защититься». Результат сохраняется в истории и статистике; рейтинговые очки не меняются. Приватная комната требует отдельного приглашения от хоста.

Обновление страницы и рестарт backend сохраняют сессию и стол. Повторный локальный вход по имени создаёт новый dev-профиль; прежний восстанавливается по токену текущей вкладки.

## Проверки

При работающей PostgreSQL и применённых тестовых миграциях:

~~~powershell
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
node tooling/smoke-built.mjs
node tooling/restart-smoke.mjs
pnpm test:durak:sim
~~~

Перед E2E выполните pnpm build и остановите pnpm dev: Playwright сам занимает 3001/5173 и временно 3003 для проверки настоящего перезапуска backend. check запускает Prisma validate/generate, TypeScript, ESLint, контроль границ пакетов, Vitest и production build. Тесты работают только с отдельной локальной arcade_test; пользовательские данные не сбрасываются.

## Документация

- [Архитектура и контракт модулей](docs/ARCHITECTURE.md)
- [Конфигурация и собранное приложение](docs/CONFIGURATION.md)
- [PostgreSQL и граница экономики](docs/DATABASE.md)
- [Discord Developer Portal и live-проверка](docs/DISCORD_SETUP.md)
- [Railway deployment](docs/RAILWAY_DEPLOYMENT.md)
- [Правила Дурака](games/durak/RULES.md)
- [Отчёт этапа 3](docs/rebuild/STAGE3_REPORT.md)
- [Исторический отчёт этапа 2](docs/rebuild/STAGE2_REPORT.md)
- [Исторический отчёт Foundation](docs/rebuild/FOUNDATION_REPORT.md)
- [Правила будущих игр](docs/GAME_RULES_PENDING.md)
- [Подготовка GitHub и проверка секретов](docs/rebuild/PUBLICATION_SECURITY.md)

Защищённые файлы сохранены. В унаследованном SECURITY.md обнаружена строка, похожая на секрет: значение не используется и не переносится. Для Discord нужен новый секрет. База бота не подключалась, production-миграции и deployment не выполнялись.

Публикуемая ветка начинается с нового корневого коммита без старой истории с секретом. Локальные SECURITY.md и все .env-файлы исключены из Git и Docker context. Старая история сохранена отдельно в локальных main/backup; их не следует отправлять вместе с новой веткой. Исключение старой истории не отзывает ранее опубликованный Client Secret.
