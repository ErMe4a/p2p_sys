## 1. Модель и миграция

- [x] 1.1 Добавить на `Exchange` (`orders/models.py`): `receipts_enabled = models.BooleanField(default=True, verbose_name="Чек включён")` и `receipt_exception_users = models.ManyToManyField(User, blank=True, related_name='receipt_exception_exchanges', verbose_name="Исключения по чеку")`.
- [x] 1.2 Сгенерировать и проверить миграцию (`makemigrations orders`, локально без БД — как и остальные миграции в проекте).

## 2. Проверка в receipt_service.py

- [x] 2.1 В `create_or_update_and_send_receipt()` (`orders/receipt_service.py`) добавить проверку сразу после существующей проверки Intelion: найти `Exchange` по `name__iexact=order.exchange_type` (`is_deleted=False`), и если найден и `receipts_enabled=False` — вернуть `ReceiptResponse(status="SKIPPED", error_text=f"Чеки для биржи {exchange.name} отключены администратором")`.
- [x] 2.2 Проверить, что при отсутствии соответствующей записи `Exchange` (имя не совпало ни с одной биржей каталога) поведение не меняется — чек отправляется как обычно (новая проверка не должна ничего ломать для бирж вне каталога).

## 3. Админ-панель: действия в каталоге

- [x] 3.1 В POST-диспетчере каталога (`orders/views.py`, там же, где `toggle_exchange_public`/`toggle_exchange`) добавить `action == 'toggle_exchange_receipts'` — переключает `receipts_enabled` для биржи по id.
- [x] 3.2 ~~Добавить `action == 'add_receipt_exception_user'` / `'remove_receipt_exception_user'`~~ — реализовано, затем убрано целиком (см. §6).

## 4. Шаблон каталога

- [x] 4.1 В `custom_admin/catalog.html`, рядом с существующими кнопками «Сделать публичной»/«Скрыть» для каждой биржи, добавить переключатель фискализации.
- [x] 4.2 ~~Добавить отдельный блок под биржей — тег-лист пользователей-исключений~~ — реализовано, затем убрано целиком (см. §6).
- [x] 4.3 ~~Блок исключений показывать только когда `receipts_enabled=False`~~ — снято вместе с блоком.

## 5. Проверка и деплой (первая версия, с исключениями)

- [x] 5.1 Локально проверить синтаксис изменённых файлов (`ast.parse` для `.py`, ручной просмотр шаблона).
- [x] 5.2 Задеплоить (`git pull` → `migrate` → `restart p2p` + `restart celery*`).
- [ ] 5.3 ~~Проверить вживую на проде на биржу без реального трафика~~ — попытка привела к инциденту с реальным чеком на кассе pershin (history.md §48.9); полноценная безопасная проверка ещё не проведена, актуальна для итоговой (без исключений) версии — см. §6.4.
- [x] 5.4 ~~Проверить список исключений~~ — неактуально, список убран.
- [x] 5.5 Проверить логи (`journalctl -u p2p`, `-u celery-receipt`) на ошибки после деплоя первой версии — чисто.

## 6. Упрощение по решению Максима: убрать список исключений, кнопка → эмодзи

По прямому запросу: «если чек не нужен, то он точно никому не нужен» — список пользователей-исключений убран полностью, отключение биржи теперь безусловно для всех. Кнопка заменена на эмодзи 🧾, цвет которой (зелёный/красный) сам показывает состояние, без текстовой подписи.

- [x] 6.1 Убрать `Exchange.receipt_exception_users` (`orders/models.py`), сгенерировать миграцию удаления поля (`makemigrations orders`).
- [x] 6.2 Упростить проверку в `receipt_service.create_or_update_and_send_receipt()` — убрать условие по `receipt_exception_users`, оставить только `exchange.receipts_enabled`.
- [x] 6.3 Убрать `action == 'add_receipt_exception_user'` / `'remove_receipt_exception_user'` из POST-диспетчера каталога (`orders/views.py`), убрать `receipt_exception_users` из `prefetch_related`.
- [x] 6.4 В `custom_admin/catalog.html`: убрать блок тег-листа исключений целиком (и его CSS `.receipt-exception-panel`); заменить текст кнопки на эмодзи 🧾, поменять местами цвета (`btn-outline-success` когда `receipts_enabled=True`, `btn-outline-danger` когда `False` — раньше было наоборот, красным подсвечивалось действие «отключить», а не текущее состояние).
- [x] 6.5 Задеплоить упрощённую версию (`git pull` → `migrate` → `restart p2p` + `restart celery*`).
- [x] 6.6 Проверить БЕЗОПАСНО (без создания реального ордера и без вызова `create_or_update_and_send_receipt()` вообще) — прочитан исходник функции на сервере (подтверждено: условие `if exchange and not exchange.receipts_enabled` без `receipt_exception`), условие проверено на временной (rollback) записи `Exchange` — отключено → пропуск, включено → нет. Плюс сквозной рендер `/p2p-admin/catalog/` — кнопка-эмодзи 🧾 на месте, старых текстовых подписей и блока исключений не осталось.
- [x] 6.7 Проверить логи (`journalctl -u p2p`, `-u celery-receipt`) на ошибки после деплоя — чисто.
