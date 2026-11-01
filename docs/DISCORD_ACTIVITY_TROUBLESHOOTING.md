# Discord Activity Troubleshooting

## Проблема: 403 Forbidden при загрузке CSS/JS файлов

Discord Activity использует встроенный домен `discordsays.com` для загрузки файлов. Чтобы Activity работал, нужно:

### 1. Проверьте Discord Developer Portal - Activity Settings

Перейдите в [Discord Developer Portal](https://discord.com/developers/applications) > Ваше приложение > **Activity**

Проверьте:
- **Application URL**: должно быть Railway URL: `https://rize3-arcadeserver-production.up.railway.app`
- **Embedded App SDK**: должен быть включен (✅)
- **Supported Activities**: выберите **Embedded App**

### 2. Проверьте CORS на Railway

В Railway > Settings > Variables убедитесь:
```
CORS_ORIGIN=https://rize3-arcadeserver-production.up.railway.app
```

Или используйте `*` для тестирования:
```
CORS_ORIGIN=*
```

### 3. Проверьте логи Railway

Откройте Railway Logs и посмотрите, есть ли запросы от Discord Activity.
Должны быть запросы вида:
```
GET /assets/index-xxx.css 200
GET /assets/index-xxx.js 200
```

Если там 403 - проблема с CORS.

### 4. Альтернативное решение: Изменить CORS на *

В Railway > Settings > Variables измените:
```
CORS_ORIGIN=*
```

Это позволит любому домену загружать файлы (только для тестирования).

### 5. После изменений

1. Сохраните изменения в Railway
2. Railway автоматически перезапустит контейнер
3. Попробуйте снова запустить Activity в Discord
