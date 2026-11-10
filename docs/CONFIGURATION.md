# Конфигурация и запуск

Сервер читает переменные процесса. Старые env-файлы не загружаются; Vite использует apps/web/config. /api/config отдаёт только публичные настройки.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| ARCADE_ENV | development | development / test / production |
| NODE_ENV | — | production принудительно включает production-защиту |
| ARCADE_AUTH_MODE | disabled | disabled / mock / discord |
| ARCADE_HOST | 127.0.0.1 | Для контейнера 0.0.0.0 |
| PORT | 3001 | HTTP и Socket.IO |
| ARCADE_ORIGIN | http://127.0.0.1:5173 | Точный origin; Activity: https://APP_ID.discordsays.com |
| ARCADE_DATABASE_URL | обязательно | PostgreSQL Arcade, namespace arcade |
| ARCADE_DISCORD_CLIENT_ID | — | Публичный Application ID |
| ARCADE_DISCORD_CLIENT_SECRET | — | Только секретное окружение backend |
| ARCADE_ENABLE_TEST_GAME | false | true только вне production |
| ARCADE_SERVE_WEB | false | Раздавать apps/web/dist |
| ARCADE_ROOM_IDLE_MS | 1800000 | Архивация неактивного лобби |
| ARCADE_HOST_GRACE_MS | 120000 | Передача отсутствующего хоста |

Флаги принимают строки true/false. Без БД/миграций сервер не запускается; memory fallback отсутствует.

## Development

Следуйте [README](../README.md). pnpm dev использует только встроенную arcade_dev на loopback и явно включает mock/sandbox. Backend после изменения кода нужно перезапустить; Vite обновляет frontend автоматически.

pnpm test и test:watch используют arcade_test. ARCADE_TEST_DATABASE_URL допускается только для localhost/127.0.0.1 с именем БД arcade_test*. Playwright использует встроенную arcade_test. Артефакты браузерных тестов находятся в tests/.artifacts и исключены из Git.

## Собранное приложение

~~~powershell
pnpm db:generate
pnpm build
# Передайте переменные из таблицы через защищённое окружение процесса.
pnpm start
~~~

Сначала примените согласованные миграции к отдельной Arcade-БД. start их не выполняет. При ARCADE_SERVE_WEB=true одна служба обслуживает HTML, assets, /api и /socket.io. Поддерживаются пути с /.proxy для Discord.

Readiness /health/ready выполняет SELECT 1, liveness /health/live проверяет процесс. SIGINT/SIGTERM останавливает публикации, закрывает Socket.IO/HTTP и Prisma.

node tooling/smoke-built.mjs проверяет production bundle с отключённым входом; node tooling/restart-smoke.mjs проверяет настоящее завершение/запуск процесса в test с mock. Оба используют только локальную arcade_test и завершают свои backend-процессы.

Проверены Windows и Chromium. Linux CI подготовлен, но удалённо не запускался. Docker/Railway и настоящий Discord требуют отдельной проверки.
