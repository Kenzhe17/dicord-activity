# Этап 2 — Platform Core & Discord Integration

Дата: 10 ноября 2026. Ветка: codex/arcade-rebuild. Реализована и локально проверена рабочая платформа на PostgreSQL. Подтверждение настоящего Discord OAuth/SDK и Railway deployment требует внешнего окружения.

## Реализовано

- Discord SDK: ready, code authorization, серверный обмен и /users/@me, проверка совпадения identity после authenticate, username/avatar, context, participants и обновления при поддержке, timeout/error/relogin, unsubscribe и logout.
- Persistent сессии с хешами, сроком и отзывом; одноразовые OAuth challenges. Клиентские ID не принимаются как подтверждение личности. Mock и sandbox запрещены в production.
- Prisma 7/PostgreSQL: arcade namespace, профили, настройки, комнаты, membership/presence, игровые snapshots/actions, результаты, статистика, recovery events и receipts.
- Публичные/приватные комнаты, отдельные приглашения с перевыпуском, ready/version checks, host transfer, архивирование, heartbeat/reconnect, восстановление после рестарта.
- Транзакционная обработка команд и идемпотентность. Socket.IO проверяет сессию/membership, публикует персональные views, отзывает соединение при logout.
- Исполняемый GameModule pipeline: проверка настроек/состава, запуск, действия, replay, завершение и однократная запись статистики. Sandbox проверяет инфраструктуру и скрытые персональные поля.
- 10 экранов: главная, библиотека, страница игры, создание, список комнат, лобби, профиль, история, рейтинги, настройки. Premium Dark UI, адаптивность, reduced motion, compact cards и сохранение предпочтений.
- Production bundle со статикой/proxy, Dockerfile, Railway config, CI и инструкции.

Движки Дурака, UNO и Мафии не реализовывались: статус «Скоро», доступно лобби. Тестовая игра отсутствует в production registry/library. Экономика и валюта бота не подключены.

## Фактически выполненные проверки

Среда: Windows, Node 26.13.0, pnpm 11.25.0, локальный PostgreSQL 18, Chromium.

| Проверка | Результат |
| --- | --- |
| pnpm install --frozen-lockfile --prod=false | Успешно |
| Две миграции arcade_dev и arcade_test | Применены локально |
| Prisma validate / generate | Успешно |
| TypeScript tsc --noEmit | Без ошибок |
| ESLint | Без ошибок |
| Границы архитектуры | 42 исходных файла, успешно |
| Vitest | **33 теста, 9 файлов — прошли** |
| Playwright | **3 E2E — прошли**, 12.8 секунды |
| Production Vite + tsup build | Успешно |
| smoke-built | PostgreSQL ready, static/assets/proxy, sandbox скрыт |
| restart-smoke | Настоящий новый backend PID; восстановлены сессия, private room, активный матч и результат |
| Production pnpm deploy artifact | Создан и запущен с отдельными production dependencies; smoke прошёл |
| git diff --check | Без ошибок whitespace |
| Защищённые файлы | Все 7 SHA-256 совпали |
| Проверка известного sensitive marker | Есть в защищённом SECURITY.md; копий вне него не найдено |

Vitest покрывает OAuth provider с тестовым fetch, SDK lifecycle с тестовым SDK, API protection, отзыв сессии/сокета, приватность приглашений, посторонний доступ, версии, конкурирующие retries, запуск/завершение GameModule, персональные скрытые данные, восстановление, offline-host transfer, архивацию после суток и изоляцию схемы.

Playwright проверяет двух клиентов публичного лобби, offline/reconnect, reload и выход/закрытие; профиль/историю/рейтинг/настройки и адаптивность; приватную партию sandbox от приглашения до сохранённого результата. Desktop/mobile screenshots просмотрены, горизонтальное переполнение на 390px не обнаружено. Артефакты: tests/.artifacts (не в Git).

restart-smoke завершает настоящий backend-процесс и запускает новый. Повторный ход после рестарта не увеличивает версию повторно; история содержит один итог.

## Файлы

- [Список файлов этапа 2](stage2-changed-files.txt).
- [Полный статус рабочего дерева](stage2-working-tree-status.txt): включает также ранее согласованные удаления Stage 0 и Foundation.
- [Исторический отчёт этапа 1](FOUNDATION_REPORT.md) сохранён как история; его прежние memory-only ограничения заменены текущей реализацией.

Отдельного commit после Foundation не было, поэтому Git diff относительно HEAD включает все этапы. Новых удалений защищённых данных нет. Commit/push не выполнялись.

## Запуск и внешняя настройка

[README](../../README.md) содержит команды локального запуска. PostgreSQL остаётся на loopback:55432; dev/test данные находятся вне репозитория. Если процесс уже работает, повторно запускать db:local не нужно.

[Конфигурация](../CONFIGURATION.md) описывает переменные и production start.
[Discord Portal](../DISCORD_SETUP.md) содержит mappings, OAuth и список live-проверок.
[Railway](../RAILWAY_DEPLOYMENT.md) описывает отдельную БД, сборку, секреты, ручные согласованные миграции и healthcheck.
[База данных](../DATABASE.md) описывает изоляцию arcade и границу экономики.

## Что не подтверждено и ограничения

Настоящий OAuth consent, Activity context/participants, Discord proxy/CDN/WebSocket и поведение desktop/mobile Discord не проверялись с реальными аккаунтами. Автоматические OAuth/SDK тесты используют синтетический транспорт.

Docker/Linux build, удалённый CI и Railway deployment не запускались. Проверенный deployment artifact не заменяет Docker build. Production миграции не выполнялись.

Global advisory lock и polling дают корректность текущей реализации, но ограничивают масштабирование. Нагрузочные испытания отсутствуют. Replay пока проходит весь журнал при чтении/действии. История/рейтинг ограничены 50 записями; retention архивов не реализован. Прерванные после суточного отсутствия партии сохраняются, но не возобновляются автоматически. Рейтинг sandbox демонстрационный, не утверждённая экономика игр.

## Сохранность и секреты

Python-бот и его таблицы не изменялись. Production-база не подключалась. Git-история, backup, лицензии, старые env и SECURITY.md сохранены.

В SECURITY.md обнаружен унаследованный предполагаемый секрет. Значение не раскрывалось в работе этапа 2, не переносилось в новые файлы и не использовалось для авторизации. Файл исключён из Docker context. Для реального входа нужен новый секрет через защищённое окружение.
