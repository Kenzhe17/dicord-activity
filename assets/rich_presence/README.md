# r!z3 Arcade — Rich Presence Art Assets (Assets 2.0 + дополнение)

PNG для загрузки в **Discord Developer Portal → Arcade app →
Rich Presence → Art Assets**. Всего 18 ключей: 3 общих + 5 игр × 3 стадии.

Имена файлов совпадают с ключами, которые использует `apps/web/src/presence.ts`
(`PRESENCE_ASSET_KEYS`). Менять ключи в коде не нужно.

## Общие ассеты

| Файл | Ключ | Состояние в коде |
| --- | --- | --- |
| `arcade_main.png` | `arcade_main` | главное меню и библиотека игр |
| `arcade_victory.png` | `arcade_victory` | победа в партии |
| `arcade_defeat.png` | `arcade_defeat` | поражение в партии |

## Игровые ассеты

| Игра | `*_main` | `*_lobby` | `*_playing` |
| --- | --- | --- | --- |
| Дурак | `durak_main.png` | `durak_lobby.png` | `durak_playing.png` |
| UNO | `uno_main.png` | `uno_lobby.png` | `uno_playing.png` |
| Мафия | `mafia_main.png` | `mafia_lobby.png` | `mafia_playing.png` |
| Codenames | `codenames_main.png` | `codenames_lobby.png` | `codenames_playing.png` |
| Monopoly | `monopoly_main.png` | `monopoly_lobby.png` | `monopoly_playing.png` |

Старые 6 файлов — 512×512 RGB; 12 новых файлов — 1024×1024 RGB. Discord
Art Assets принимает оба размера.

## Как загрузить

1. Откройте https://discord.com/developers/applications → приложение Arcade
   (Application ID `1566418593191690330`).
2. В левом меню выберите **Rich Presence → Art Assets**.
3. Для каждого файла нажмите **Upload Image** и загрузите PNG.
4. В поле имени ассета введите имя файла **без расширения**
   (например `durak_lobby` для `durak_lobby.png`).
5. Сохраните. Discord может показать старое изображение до нескольких минут —
   это нормально (кэш клиента).

Уже загруженные ассеты не удалять и не заменять — загружайте только
отсутствующие ключи.

Размещение файлов в репозитории **не обновляет** Rich Presence: Discord берёт
картинки только из Art Assets приложения. Автоматической загрузки через
официальный API нет — только ручная загрузка в портале.

## Проверки

- Формат: PNG, RGB. Старые файлы 512×512, новые 1024×1024.
- Имена всех 18 файлов совпадают с `PRESENCE_ASSET_KEYS` в `presence.ts`.
- Если ассет не загружен, Discord просто не показывает картинку — обновления
  presence при этом продолжают работать.
