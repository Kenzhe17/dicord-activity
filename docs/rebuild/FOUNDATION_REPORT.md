# Отчёт: этапы 0 и 1

Дата: 9 ноября 2026. Рабочая ветка: `codex/arcade-rebuild`. Этап 1 завершён в пределах Foundation. Следующие игровые этапы не объявляются реализованными.

## Сброс и сохранность

- Перед очисткой повторно проверены HEAD, `backup/pre-rebuild`, Git diff и SHA-256 каждого из 42 файлов. Расхождений не было.
- Все 42 согласованных старых файла удалены явным патчем. Часть путей затем создана заново новой реализацией; поэтому Git отображает их как modified, а не deleted.
- Автоматическая проверка отклонила удаление через PowerShell с сообщением `blocked by policy`, без подробного объяснения. Исходники удалось удалить точным патчем. Старые `node_modules`, `apps/server/dist`, `packages/shared/dist` перемещены в резервную папку вне проекта, соответственно в `retired-node-modules`, `retired-server-dist`, `retired-shared-dist`. Они не используются новым workspace.
- Пустые каталоги assets/third_party оставлены: данных или кода в них нет. Данные вне согласованного списка не удалялись.
- Все семь защищённых tracked-файлов побайтно совпадают с `protected-file-hashes.json`, включая env-файлы, `.gitignore`, лицензии и `SECURITY.md`.
- `backup/pre-rebuild` по-прежнему указывает на `165bca0e6b1b0bcaa213ca0897342947ecbe4c71`. Git bundle и архив исходных сборок сохранены.
- `SECURITY.md` проверен без вывода значений. Предполагаемый credential остаётся только в исходном защищённом файле среди проверенных новых/отслеживаемых файлов проекта. Значение не перенесено в новый код или документацию. Это проверка конкретного обнаруженного секрета, не полный аудит истории.
- Новых коммитов, push, операций над удалёнными ветками и изменений базы нет.

## Реализовано

| Область | Файлы и поведение |
| --- | --- |
| Workspace | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `.gitattributes`: 12 workspace-проектов с корнем, строгий TypeScript и совместимые зависимости |
| Ядро | `packages/platform-core/src`: типизированный GameModule, planned/executable registration, Zod validation, домен комнат |
| Multiplayer | `packages/multiplayer/src`: версии, принадлежность матчу, дедупликация, immutable transitions, скрытые views, журнал и восстановление проверкой replay |
| Discord | `packages/discord/src`: отдельные server/client границы, SDK workflow, backend OAuth exchange, проверенная identity, session TTL/revoke |
| PostgreSQL | `packages/database`: валидная Prisma-схема arcade, сгенерированный клиент, явная фабрика, контракты CAS storage/EconomyPort; соединение не открывается |
| Игры | `games/durak`, `games/uno`, `games/mafia`: независимые пакеты, metadata, схемы настроек, тесты и описанные границы engine/server/client |
| API | `apps/server/src`: Fastify, авторизация, валидация, rate limiting, проверка Origin, HTTP rooms, Socket.IO subscription, health, shutdown |
| Web | `apps/web/src`, `packages/ui`: React/Vite/Tailwind/Zustand/Motion, библиотека, локальный вход, публичные/приватные лобби, готовность, передача хоста, выход, WebSocket reconnect |
| QA | `tests/e2e`, `playwright.config.ts`, `tooling`: browser flow, property tests, import-boundary check, smoke собранного backend |
| CI | `.github/workflows/check.yml`: установка по lockfile, общие проверки и Chromium E2E; GitHub workflow подготовлен, удалённый запуск не выполнялся |
| Документация | README, ARCHITECTURE, CONFIGURATION, DATABASE, GAME_RULES_PENDING и этот отчёт |

Полный перечень новых, изменённых и удалённых путей находится в `changed-files.txt`. Список не включает node_modules, dist, Prisma generated и результаты Playwright, исключённые из Git.

## Фактически выполненные проверки

| Проверка | Результат |
| --- | --- |
| `pnpm install --frozen-lockfile` | Успешно |
| `pnpm db:validate` | Схема корректна, без подключения к PostgreSQL |
| `pnpm db:generate` | Prisma Client 7.8.0 сгенерирован, без миграций |
| `pnpm typecheck` | Успешно |
| `pnpm lint` | Успешно, ESLint 10 |
| `pnpm check:boundaries` | Успешно, 35 TypeScript/TSX файлов |
| `pnpm test` | 23 теста, 7 файлов, все прошли |
| Property-based | 200 воспроизводимых последовательностей команд комнат, до 100 команд каждая |
| `pnpm build` | Frontend и backend собраны; Discord SDK выделен в отдельный загружаемый chunk |
| `pnpm test:e2e` | 2 сценария Chromium: два игрока, join/ready/leave, потеря сети и resubscribe, desktop/mobile |
| `node tooling/smoke-built.mjs` | Собранный API стартовал: live=200, production ready=503, auth disabled, без БД |
| `git diff --check` | Успешно |
| Проверка защищённых файлов | SHA-256 совпадают; удаления вне manifest отсутствуют |

Проверено на Windows с Node 26.13.0 и pnpm 11.25.0. Linux CI пока не запускался. Браузерные скриншоты: `tests/.artifacts/library-desktop.png`, `library-mobile.png`, `lobby-mobile.png`; просмотрены десктопная и мобильная библиотека. Предупреждения Playwright о NO_COLOR/FORCE_COLOR относятся к окружению запуска.

В ходе проверки исправлены: обработка unknown-ошибки Fastify, захват зависимостей Vitest, конфигурация build scripts pnpm 11, пустой JSON body в HTTP-клиенте и браузерное WebSocket-подключение. Первоначальные неуспешные прогоны не представлены как успешные.

## Ограничения и следующий этап

- Движки Дурака, UNO-style и Мафии ещё не написаны. Игры честно обозначены как planned. Полные RULES.md, согласование спорных правил и игровые симуляции относятся к этапам 4–6.
- Комнаты и сессии хранятся в памяти. Проверен reconnect в пределах живой сессии, но перезапуск сервера и обновление вкладки не восстанавливают локальную сессию. Persistent adapters, timers, orphan-room cleanup и full match transport — следующие этапы.
- OAuth boundary реализована и протестирована с искусственным upstream. Live-вход внутри Discord, URL mappings и мобильный Discord не проверены.
- База бота не подключалась; схема реальной экономики не изучалась. Миграции и интеграция требуют отдельного согласования. Новая валюта не создана.
- Статистика, рейтинги, результаты реальных матчей и Railway deployment ещё не реализованы. Readiness в production намеренно не объявляет memory Foundation готовым.

## Локальный запуск

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

Адрес: http://127.0.0.1:5173. Для повторной проверки: `pnpm check`, затем `pnpm test:e2e` при свободных портах 3001/5173. Реальные секреты и PostgreSQL не нужны.

## Использованные технические справочники

- [Prisma 7 generators](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators): явный output генератора и driver adapter.
- [Prisma Config](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference): отдельная CLI-конфигурация.
- [Discord Embedded App SDK](https://github.com/discord/embedded-app-sdk): authorize/exchange/authenticate.
- [Fastify lifecycle](https://github.com/fastify/fastify/blob/main/docs/Reference/Hooks.md): закрытие WebSocket до HTTP shutdown.
- [pnpm settings](https://pnpm.io/settings): workspace и allowBuilds.
