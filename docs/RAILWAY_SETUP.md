# Настройка Discord Activity на Railway

## Шаг 1: Настройка Discord Application

### 1.1 Перейдите в Discord Developer Portal
https://discord.com/developers/applications

### 1.2 Создайте или выберите приложение
- Если приложение с ID `1566376251185168394` уже существует, выберите его
- Иначе создайте новое приложение

### 1.3 Включите Activity Features
1. Перейдите в раздел **Activity**
2. Включите **Embedded App SDK**
3. Нажмите **Save Changes**

### 1.4 Получите Client Secret
1. Перейдите в раздел **OAuth2** > **General**
2. Скопируйте **Client Secret**
3. ⚠️ Никогда не делитесь с этим секретом!

### 1.5 Настройте Redirect URIs
В разделе **OAuth2** > **Redirects** добавьте:
- Для Railway: `https://your-app-name.railway.app`
- Для локальной разработки: `http://localhost:5173`

### 1.6 Настройте Activity (после деплоя)
1. Перейдите в раздел **Activity**
2. В поле **Application URL** введите URL вашего Railway приложения
3. Нажмите **Save Changes**

## Шаг 2: Настройка Railway

### 2.1 Создайте проект на Railway
1. Перейдите на https://railway.app
2. Войдите или создайте аккаунт
3. Нажмите **New Project** > **Deploy from GitHub repo**

### 2.2 Подключите репозиторий
1. Нажмите **Connect GitHub**
2. Выберите репозиторий `rize3-arcade`
3. Нажмите **Deploy Now**

### 2.3 Настройте Environment Variables
В настройках проекта (Settings > Variables) добавьте:

```
DISCORD_CLIENT_ID=1566376251185168394
DISCORD_CLIENT_SECRET=ваш_client_secret_здесь
DISCORD_REDIRECT_URI=https://ваше-имя-app.railway.app
PORT=3001
CORS_ORIGIN=https://ваше-имя-app.railway.app
```

### 2.4 Настройте Frontend Environment Variables
В настройках проекта добавьте также:

```
VITE_DISCORD_CLIENT_ID=1566376251185168394
VITE_SERVER_URL=https://ваше-имя-app.railway.app
```

### 2.5 Дождитесь деплоя
Railway автоматически:
- Соберёт проект через Docker
- Запустит сервер
- Предоставит публичный URL

## Шаг 3: Обновите Discord Application

### 3.1 Получите Railway URL
После деплоя Railway предоставит URL вида:
`https://rize3-arcade-production-xxxx.up.railway.app`

### 3.2 Обновите Discord Configuration
1. Вернитесь в Discord Developer Portal
2. В разделе **OAuth2** > **Redirects** добавьте Railway URL
3. В разделе **Activity** > **Application URL** введите Railway URL
4. Сохраните изменения

## Шаг 4: Тестирование в Discord

### 4.1 Создайте Test Server
1. В Discord Developer Portal перейдите в **General Information**
2. Нажмите **Install App** > **Select a Server**
3. Выберите тестовый сервер
4. Авторизуйте бота

### 4.2 Запустите Activity
1. На сервере откройте список Activities
2. Найдите и запустите r!z3 Arcade
3. Приложение откроется внутри Discord

### 4.3 Проверьте функционал
- ✅ Авторизация пользователя
- ✅ Отображение профиля
- ✅ Создание комнаты
- ✅ Присоединение к комнате
- ✅ Список игроков
- ✅ Статус готовности
- ✅ Запуск игры

## Шаг 5: Многопользовательское тестирование

1. Пригласите друзей на тестовый сервер
2. Попросите их запустить Activity
3. Тест:
   - Один создаёт комнату
   - Другие присоединяются по коду
   - Все нажимают "Готов"
   - Владелец запускает игру

## Тroubleshooting

### Activity не запускается
- Проверьте, что Application URL в Discord правильный
- Убедитесь, что Redirect URIs включают Railway URL
- Проверьте логи Railway

### Ошибка авторизации
- Проверьте DISCORD_CLIENT_SECRET в Railway переменных
- Убедитесь, что Redirect URI совпадает
- Проверьте логи сервера

### WebSocket не подключается
- Проверьте VITE_SERVER_URL
- Убедитесь, что CORS_ORIGIN правильный
- Проверьте, что сервер запущен (Health endpoint)

### Комнаты не синхронизируются
- Проверьте логи Socket.IO
- Убедитесь, что аутентификация работает
- Проверьте, что оба пользователя в одной комнате

## Локальная разработка

Для локальной разработки без Railway:

1. Скопируйте `.env.example` в `.env`
2. Скопируйте `apps/web/.env.example` в `apps/web/.env`
3. Установите Node.js 18+
4. Запустите `npm install`
5. Запустите `npm run dev`
6. Используйте Cloudflare Tunnel для Discord:
   ```bash
   cloudflared tunnel --url http://localhost:5173
   ```
7. Обновите Discord Application с tunnel URL

## Безопасность

⚠️ **ВАЖНО:**
- Никогда не коммитьте `.env` файлы
- Не делитесь Client Secret
- Client ID (1566376251185168394) - публичный, его можно использовать
- Токен бота (MTU2NjM3NjI1MTE4NTE2ODM5NA...) - НИКОГДА не используйте в коде!

Для Discord Embedded App SDK нужен только Client ID и Client Secret из OAuth2 секции, НЕ токен бота.
