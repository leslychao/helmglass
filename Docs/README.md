# Документация Helm Glass

- [Техническая спецификация](architecture.html) — канонический владелец архитектуры, контрактов и критериев готовности; HTML с оглавлением, поиском, диаграммами и печатью в PDF открывается без интернета.
- [Последний HTML-дизайн](Helm-Glass-v8.html) — интерактивный демонстрационный макет, не подключённый к backend или ChatGPT.
- Готовые компоненты: [реестр зависимостей](architecture.html#reuse-matrix), [границы применения и источники](architecture.html#reuse-candidates).
- Исполнение: [наблюдение страницы и действия](architecture.html#browser-observation), [аудио, расшифровка и акустические признаки](architecture.html#audio-analysis).
- Восстановление и совместный просмотр: [фоновое восстановление](architecture.html#background-recovery), [контекст задачи](architecture.html#task-recovery-context), [связь задачи с браузером](architecture.html#browser-continuity), [передача управления](architecture.html#control-handoff), [контракт виджета](architecture.html#widget-transport), [приёмка](architecture.html#continuity-acceptance).
- Обновления интерфейса: [WebSocket и восстановление актуальных данных](architecture.html#section-34).
- Действия браузера: [видимость, доступность и подписи кнопок в кабинете и виджете](architecture.html#browser-actions).
- Навигация кабинета: [возврат из вложенных экранов и сохранение контекста списка](architecture.html#cabinet-navigation).
- Продолжение в ChatGPT: [уточнения и команды](architecture.html#task-clarifications), [единственный актуальный виджет](architecture.html#chat-widget-ownership), [границы платформы](architecture.html#chatgpt-platform). [Демонстрация переписки](Helm-Glass-v8.html#/widget/101?chat=demo-a) — локальная модель, не реальная интеграция.
