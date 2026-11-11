# Railway deployment

Подготовлены Dockerfile, .dockerignore и railway.toml. Railway deployment, изменение service variables и production-миграции не выполнялись.

## Подготовка

1. Создайте отдельное окружение Arcade и PostgreSQL service. Не выбирайте production-базу бота.
2. Подключите согласованный код codex/arcade-rebuild, root directory — корень monorepo. Dockerfile собирает web/server и переносит dist с production dependencies в runtime под пользователем node.
3. railway.toml задаёт Dockerfile builder и /health/ready. Сервер слушает 0.0.0.0 и PORT Railway. Начните с одной реплики.
4. Создайте HTTPS-домен службы и внесите его в Discord root URL Mapping.

Railway поддерживает Dockerfile и проверяет readiness на порту PORT. См. [Dockerfile](https://docs.railway.com/builds/dockerfiles) и [healthchecks](https://docs.railway.com/deployments/healthchecks).

## Переменные

| Переменная | Значение |
| --- | --- |
| NODE_ENV / ARCADE_ENV | production |
| ARCADE_AUTH_MODE | discord |
| ARCADE_HOST | 0.0.0.0 |
| ARCADE_SERVE_WEB | true |
| ARCADE_ENABLE_TEST_GAME | false |
| ARCADE_ORIGIN | https://APP_ID.discordsays.com |
| ARCADE_DISCORD_CLIENT_ID | Application ID Arcade |
| ARCADE_DISCORD_CLIENT_SECRET | Новый секрет только в variables |
| ARCADE_DATABASE_URL | Reference на отдельный Arcade Postgres DATABASE_URL |
| PORT | Назначается Railway |

Для сервиса ArcadePostgres reference имеет вид ${{ArcadePostgres.DATABASE_URL}}. Название должно совпадать с вашим сервисом. Runtime использует внутреннее соединение; ручным миграциям нужен согласованный доступ из среды CLI. Не выводите URL в логи.

## Миграции перед запуском

Runtime-образ не содержит Prisma CLI и не мигрирует автоматически. Миграции применяет отдельный одноразовый сервис `arcade-migrate` из того же репозитория и ветки:

- `Dockerfile.migrate` — образ с полным workspace и Prisma CLI; запускает `tooling/migrate-arcade.mjs` и завершается.
- `tooling/migrate-arcade.mjs` — `prisma migrate status` (диагностика), затем `prisma migrate deploy`, затем проверка: все 12 таблиц `arcade.*` и `_prisma_migrations` без незавершённых записей. URL БД никогда не печатается. Код выхода ненулевой при любой ошибке.
- `railway.migrate.toml` — конфиг сервиса миграций: `dockerfilePath = Dockerfile.migrate`, `restartPolicyType = NEVER`, без healthcheck.

Запрещено: `migrate reset`, `db push`, миграции при старте приложения, ручной запуск migration.sql (первая миграция без квалифицированных имён — search_path arcade задаёт только prisma.config.ts).

### Настройка сервиса arcade-migrate (один раз)

**Важно:** корневой `railway.toml` применяется ко всем сервисам этого репозитория, и config-as-code имеет приоритет над настройками dashboard — поле «Dockerfile Path» в UI будет проигнорировано, пока сервис читает корневой `railway.toml` (он соберёт обычный `Dockerfile` и запустит веб-сервер вместо миграций; deployment при этом может показать SUCCESS). Поэтому сервис обязан использовать собственный конфиг.

1. Убедитесь, что целевая БД — отдельный сервис ArcadePostgres, не база бота. В переменных arcade-migrate задайте только:
   `ARCADE_DATABASE_URL = ${{ArcadePostgres.DATABASE_URL}}` (имя сервиса — как в вашем проекте). Ссылка использует приватную сеть Railway; сервис обязан находиться в том же environment.
2. Project canvas → New Service → GitHub repo → та же ветка `codex/arcade-rebuild`, имя `arcade-migrate`.
3. Settings → Config as Code (Railway Config File): укажите **абсолютный путь `/railway.migrate.toml`**. Это обязательный шаг — без него сервис унаследует корневой `railway.toml` и соберёт не тот образ.
   - Если Railway отклоняет config-as-code для нового сервиса: переменная `RAILWAY_DOCKERFILE_PATH=Dockerfile.migrate` + в Settings → Deploy restart policy **Never** и healthcheck **выключен**. В этом случае убедитесь в логах сборки, что используется именно `Dockerfile.migrate`.
4. Переменные Discord/бота сервису миграций не нужны — не копируйте их.

### Проверка правильного образа (до миграций)

В логах деплоя arcade-migrate должно быть:

- Build: используется `Dockerfile.migrate` (не `Dockerfile`).
- Runtime: строки `== prisma migrate status ==`, затем `== prisma migrate deploy ==`, затем `Verification OK: arcade schema complete, all migrations finished.` и exit code 0.
- Если вместо этого поднимается веб-сервер или `node apps/server/dist/index.js` — образ собран неверно, остановите deployment и проверьте config-as-code path.
- Статус SUCCESS в Railway не является доказательством миграции — смотрите именно runtime-логи.

### Порядок выполнения

1. Перед запуском зафиксируйте план: `migrate status` в логах сборки/запуска покажет ровно две ожидаемые миграции — `202611090001_arcade_platform`, `202611090002_active_membership`. Проверьте их SQL в `packages/database/prisma/migrations/` и подтвердите целевую БД.
2. Дождитесь успешного деплоя сервиса arcade-migrate (exit 0, в логах `Verification OK`). При повторном деплое `migrate deploy` — no-op.
3. Удалите или остановите сервис arcade-migrate — он больше не нужен. Не удаляйте его до проверки `/health/ready`.
4. Запустите/перезапустите основной сервис Arcade: при старте `buildApp` проверяет `player.count()`, затем `/health/live` и `/health/ready` отвечают 200.

Тот же скрипт доступен локально после `pnpm install`: `pnpm db:migrate:arcade` при выставленном `ARCADE_DATABASE_URL`. Для удалённой БД используйте публичный proxy URL сервиса ArcadePostgres или `railway connect` — internal-хосты недоступны снаружи.

## Проверка

- /health/live и /health/ready: 200; /api/config: postgresql и discord.
- /api/games: Дурак ready, UNO/Мафия planned; sandbox отсутствует, dev-вход запрещён.
- Root HTML, /.proxy/assets, /.proxy/api/games доступны.
- Выполнен [Discord checklist](DISCORD_SETUP.md), включая два аккаунта и WebSocket.
- Рестарт службы восстанавливает комнаты.
- Настроены backups PostgreSQL и мониторинг ошибок/соединений.

Rollback приложения должен сохранять совместимость stateVersion с checkpoints. Не откатывайте БД удалением таблиц. Глобальная блокировка и polling рассчитаны на начальный объём; многорепличная нагрузка пока не испытана.

Docker build не запускался: в текущей Windows-среде Docker отсутствует. Production bundle проверен локально на PostgreSQL, включая static/proxy. Linux CI подготовлен, удалённый результат не заявляется.
