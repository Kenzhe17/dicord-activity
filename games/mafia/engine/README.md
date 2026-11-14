# Мафия: движок

Детерминированный серверный движок (`index.ts`): машина состояний reveal → night → dawn → discussion → voting → (runoff) → night → finished, роли мафия/комиссар/доктор/мирный, ночные действия, голосование с runoff, чаты town/mafia/dead, статистика и условия победы/ничьей. Правила — в ../RULES.md.

ГПСЧ — mulberry32 от серверного seed, состояние `rng` хранится в checkpoint, поэтому реплей журнала действий детерминирован. Движок не выполняет I/O и не импортирует React/SDK/Node API. Настройки — ../server/definition.ts (пресеты темпа classic/short/blitz).
