# Discord Developer Portal и live-проверка

SDK реализован, но приложение не запускалось внутри настоящего Discord-клиента в этой работе. Действующий client secret и изменения Portal не использовались.

## Настройки

1. Создайте отдельное Discord Application для Arcade или используйте согласованное. Application ID → ARCADE_DISCORD_CLIENT_ID.
2. Включите Activities. В Activities → URL Mappings задайте prefix / и target домен HTTPS-службы Arcade. Вторая mapping: /discord-cdn → cdn.discordapp.com для аватаров.
3. Backend: ARCADE_AUTH_MODE=discord, ARCADE_DISCORD_CLIENT_SECRET через secrets, ARCADE_ORIGIN=https://APP_ID.discordsays.com, ARCADE_SERVE_WEB=true. Production: NODE_ENV=production, ARCADE_ENV=production, ARCADE_ENABLE_TEST_GAME=false.
4. Используйте новый Client Secret, если старый раскрывался. Не копируйте значение из SECURITY.md.
5. SDK запрашивает identify. Code обменивается сервером; Embedded flow не использует браузерный redirect callback. Bot token, Administrator, privileged intents и доступ к экономике не нужны.
6. Настройте доступ тестировщиков к приложению и запускайте Activity из Discord в тестовом голосовом канале. Включите поддерживаемые платформы Activity для desktop/web/mobile. Названия полей Portal могут меняться.

Root mapping и тестовый туннель описаны в [официальном руководстве Discord](https://docs.discord.com/developers/activities/building-an-activity). Последовательность authorize → серверный обмен → authenticate соответствует [Embedded App SDK](https://github.com/discord/embedded-app-sdk/blob/main/README.md).

## Proxy

Frontend base: /.proxy/. В Discord API/Socket.IO используют /.proxy/api и /.proxy/socket.io. Backend принимает и пути без префикса. Аватары идут через /.proxy/discord-cdn. Client secret никогда не передаётся в Vite.

Для локального live-теста поднимите собранный сервер с ARCADE_SERVE_WEB=true и отдельной dev-БД, откройте HTTPS-туннель к его порту, назначьте root mapping. Включите Discord auth и выключите sandbox. pnpm dev намеренно использует mock и для live OAuth не подходит.

frame_id, guildId, channelId и участники Activity не используются для авторизации API. Backend проверяет /users/@me; SDK authenticate дополнительно сравнивает ID. Participants API и события используются при доступности; неподдерживаемый клиент получает fallback.

## Что проверить в Discord

- Первый вход: согласие identify, code exchange, правильные ID/username/avatar.
- Отказ, timeout, неверный/повторный code: понятная ошибка, повторный вход.
- Повторное открытие: тот же профиль и восстановление комнаты/матча.
- Два настоящих аккаунта: context и изменение состава Activity.
- Desktop/web/mobile: participants API, viewport, клавиатура, reduced motion.
- Proxy: HTML, JS/CSS, CDN аватаров, WebSocket upgrade, CSP.
- Приватное лобби: посторонний не видит состав/матч; перевыпуск приглашения отзывает старое.
- Потеря сети, sleep/resume, рестарт backend: reconnect и отсутствие повторного хода.
- Logout: старый API-токен и сокеты не действуют, повторный вход доступен.

Дополнительно для Дурака проверьте полные партии в обоих режимах с 2–6 реальными аккаунтами: персональные руки, перевод нескольких карт, таймер, сворачивание мобильного клиента, возвращение в Activity и сохранение результата без изменения рейтинга. После рестарта сервера текущий ход получает минимум 30 секунд; закрытые карты и стол должны сохраниться.

Тесты SDK/OAuth используют синтетический транспорт и не заменяют этот список. Дурак доступен в production-конфигурации; sandbox там запрещён. Для первой live-проверки используйте отдельный staging с Discord auth и отдельной Arcade-БД.
