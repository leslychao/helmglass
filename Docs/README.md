# Документация Helm Glass

- [Техническая спецификация](architecture.html) — канонический владелец архитектуры, контрактов и критериев готовности; HTML с оглавлением, поиском, диаграммами и печатью в PDF открывается без интернета.
- [Последний HTML-дизайн](Helm-Glass-v8.html) — интерактивный демонстрационный макет, не подключённый к backend или ChatGPT.
- Развёртывание: [единственное рабочее окружение dev](architecture.html#section-27), [predefined-пользователи admin и Ангелина](architecture.html#predefined-users), [приёмка входа и прав](architecture.html#predefined-users-acceptance).
- Запуск: [команды сборки, защищённая конфигурация и Vault recovery](architecture.html#launcher-commands).
- Готовые компоненты: [реестр зависимостей](architecture.html#reuse-matrix), [границы применения и источники](architecture.html#reuse-candidates).
- Исполнение: [наблюдение страницы и действия](architecture.html#browser-observation), [передача аудио в ChatGPT и условия расчёта признаков](architecture.html#audio-analysis), [проверка аудиомаршрута](architecture.html#audio-acceptance).
- Восстановление и совместный просмотр: [фоновое восстановление](architecture.html#background-recovery), [контекст задачи](architecture.html#task-recovery-context), [связь задачи с браузером](architecture.html#browser-continuity), [передача управления](architecture.html#control-handoff), [контракт виджета](architecture.html#widget-transport), [приёмка](architecture.html#continuity-acceptance).
- Обновления интерфейса: [WebSocket и восстановление актуальных данных](architecture.html#section-34).
- Живой браузер: [минимальный WebRTC и H.264](architecture.html#browser-streaming), [сеть и TURN](architecture.html#browser-rtc-network), [GPU сервера 107](architecture.html#browser-gpu-host), [проверка задержки и FPS](architecture.html#browser-performance).
- Действия браузера: [видимость, доступность и подписи кнопок в кабинете и виджете](architecture.html#browser-actions).
- Навигация кабинета: [возврат из вложенных экранов и сохранение контекста списка](architecture.html#cabinet-navigation).
- Продолжение в ChatGPT: [приоритет автоматического восстановления и продолжения](architecture.html#automatic-continuation), [уточнения и команды](architecture.html#task-clarifications), [единственный актуальный виджет](architecture.html#chat-widget-ownership), [границы платформы](architecture.html#chatgpt-platform). [Демонстрация переписки](Helm-Glass-v8.html#/widget/101?chat=demo-a) — локальная модель, не реальная интеграция.
