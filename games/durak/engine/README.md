# Дурак: граница движка

Изолированная детерминированная state machine по согласованному RULES.md: создание, проверка, immutable переходы, персональные views, инварианты и системные таймеры. Здесь нет React, Socket.IO, Node API, доступа к БД или старого игрового кода. CardId 0..35 кодирует масть и ранг; seed остаётся на сервере. GameModule адаптер находится в ../server/module.ts. Симулятор: pnpm test:durak:sim; результат — docs/rebuild/durak-simulations.json.
