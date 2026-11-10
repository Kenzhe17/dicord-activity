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

Runtime-образ не содержит Prisma CLI и не мигрирует автоматически. Из checkout с devDependencies либо отдельного однократного migration job:

~~~powershell
pnpm install --frozen-lockfile
pnpm db:generate
# ARCADE_DATABASE_URL передан через защищённое окружение.
pnpm --filter @rize/database exec prisma migrate status
pnpm --filter @rize/database exec prisma migrate deploy
~~~

Только после согласования целевой Arcade-БД, backup и SQL. Prisma config фиксирует schema arcade. Не используйте reset/db push. После миграций запустите deployment: приложение проверяет таблицы при старте.

## Проверка

- /health/live и /health/ready: 200; /api/config: postgresql и discord.
- /api/games: Дурак ready, UNO/Мафия planned; sandbox отсутствует, dev-вход запрещён.
- Root HTML, /.proxy/assets, /.proxy/api/games доступны.
- Выполнен [Discord checklist](DISCORD_SETUP.md), включая два аккаунта и WebSocket.
- Рестарт службы восстанавливает комнаты.
- Настроены backups PostgreSQL и мониторинг ошибок/соединений.

Rollback приложения должен сохранять совместимость stateVersion с checkpoints. Не откатывайте БД удалением таблиц. Глобальная блокировка и polling рассчитаны на начальный объём; многорепличная нагрузка пока не испытана.

Docker build не запускался: в текущей Windows-среде Docker отсутствует. Production bundle проверен локально на PostgreSQL, включая static/proxy. Linux CI подготовлен, удалённый результат не заявляется.
