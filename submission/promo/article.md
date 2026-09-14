# Technical article

The strongest promotion for this plugin is not an announcement but an explanation: the interesting part is the accounting model, and it is the part a reader can argue with. Two venues fit, depending on the language.

## Variant A — Russian, for Habr

**Заголовок:** `Почему счётчик расходов на токены врёт, и как это исправить журналом`

**Structure, with what goes in each section:**

1. **Проблема.** Стоимость чата обычно показывают как пересчёт: взяли текущее потребление, умножили на текущий тариф. Чат, пересекающий пиковое окно DeepSeek, задним числом дорожает или дешевеет; сверить цифру с реальным счётом невозможно. Показать на своём примере: 158 млн токенов, из них 156 млн — чтения кэша, то есть тариф кэша решает всё.
2. **Идея: журнал как источник истины.** Append-only JSONL, одна запись на сессию за интервал: позиция в дереве, четыре корзины токенов, дельта и кумулятив, тариф. Каждый проход считает только прирост и только по текущему тарифу; записанное не пересчитывается. Показать формат записи целиком — он короткий.
3. **Как проверить, что не врёт.** Сверка двух независимых путей: свёртка событий сессии по ходам против кумулятивной записи лога. Числа: 39 ходов, 192 753 094 токена, $1.180602102 — расхождение ноль. Это и есть тест, который стоит показывать.
4. **Где пришлось признать ограничения.** Неактивная сессия не отдаёт использование — значит, либо «—», либо лог, и это надо честно помечать. Форма проекции `tokenUsage` оказалась обёрнута в `totals` — читатель, который смотрел на верхний уровень, молча считал ноль; отдельный раздел про то, почему молчаливый ноль хуже ошибки.
5. **Планирование под бюджет.** Оценки как диапазоны (P50/P90, происхождение числа: declared / history / bootstrap), резерв 20% на переделки, упаковка под лимит, сценарии маршрутизации и почему адекватность модели считается по фактам каталога, а не по выдуманной «оценке качества».
6. **Что дальше.** Тарифы длинного контекста, пер-ходовая разбивка для чатов из лога, и честная строчка о том, чего в плагине сознательно нет.

## Variant B — English, for dev.to

Same six sections, retitled:

`Your token cost dashboard is lying, and an append-only ledger is the fix`

Keep the numbers identical (they are all checkable in the repository) and cut section 6 to two sentences. dev.to readers want the code sample early: put the JSONL record in section 2, before any prose about it.

## What makes this article worth reading

- It argues a position (re-computation is the wrong model) instead of listing features.
- Every number comes with the way it was produced, including the one that came out wrong first (the `totals` wrapper priced a 158-million-token chat at zero).
- It names the plugin once, at the end, rather than in every paragraph. Habr and dev.to both punish the opposite.
