# r!z3 Arcade — Rich Presence Art Assets (Assets 2.0)

Шесть PNG 512×512 для загрузки в **Discord Developer Portal → Arcade app →
Rich Presence → Art Assets**.

Имена файлов совпадают с ключами, которые использует `apps/web/src/presence.ts`
(`PRESENCE_ASSET_KEYS`). Менять ключи в коде не нужно.

| Файл | Ключ Art Asset | Состояние в коде |
| --- | --- | --- |
| `arcade_main.png` | `arcade_main` | главное меню Arcade |
| `durak_lobby.png` | `durak_lobby` | лобби Дурака |
| `durak_playing.png` | `durak_playing` | активная партия |
| `arcade_victory.png` | `arcade_victory` | победа в партии |
| `uno_main.png` | `uno_main` | UNO (planned) |
| `mafia_main.png` | `mafia_main` | Мафия (planned) |

## Как загрузить

1. Откройте https://discord.com/developers/applications → приложение Arcade.
2. В левом меню выберите **Rich Presence → Art Assets**.
3. Для каждого файла нажмите **Upload Image** и загрузите PNG.
4. В поле имени ассета введите имя файла **без расширения**
   (например `durak_lobby` для `durak_lobby.png`).
5. Сохраните. Discord может показать старое изображение до нескольких минут —
   это нормально (кэш клиента).

Размещение файлов в репозитории **не обновляет** Rich Presence: Discord берёт
картинки только из Art Assets приложения. Автоматической загрузки через
официальный API нет — только ручная загрузка в портале.

## Проверки

- Формат: PNG, 512×512, RGB (без альфа-канала — Discord Art Assets его не требует).
- Все шесть файлов ~360–390 KB, имена совпадают с ключами в `presence.ts`.
- Если ассет не загружен, Discord просто не показывает картинку — обновления
  presence при этом продолжают работать.
