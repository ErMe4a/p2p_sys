// Gate.io Order List Content Script
// Injects per-row order info fetched from backend and stays in sync with SPA updates

(function(){
    let listObserver = null;
    let urlWatcher = null;
    let paginationClickHandler = null;
    let currentUrl = location.href;
    let currentUrlParams = new URLSearchParams(location.search);
    let processingVersion = 0;
    let pendingForceRefresh = false;
    const EXCHANGE_TYPE_GATE = 4;
    const STOP404_TTL_MS = 30000;

    // ── Целевая страница ──────────────────────────────────────────────────────
    function isTargetPage() {
        try {
            const url = new URL(location.href);
            const hostname = url.hostname;
            const isCorrectDomain = hostname.includes('gate.com') || hostname.includes('gate.io');
            const path = url.pathname.toLowerCase();
            // Реальный URL: /ru/p2p/usercenter-orders  + старые варианты
            const isOrdersPage = path.includes('/p2p/') && (
                path.includes('order') || path.includes('record') || path.includes('usercenter')
            );
            console.log('[P2P Gate List] isTargetPage:', isCorrectDomain, isOrdersPage, path);
            return isCorrectDomain && isOrdersPage;
        } catch (_) { return false; }
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    function getAuth() { return window.P2PAuth || null; }

    function waitAuthReady() {
        return new Promise((resolve) => {
            let attempts = 0;
            const t = setInterval(() => {
                if (getAuth()) { clearInterval(t); resolve(true); return; }
                if (++attempts >= 40) { clearInterval(t); resolve(false); }
            }, 100);
        });
    }

    // ── SVG иконки ────────────────────────────────────────────────────────────
    function createSvgIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.style.display = 'block';
        if (type === 'saved') {
            svg.innerHTML = `<path d="M2 2C2 1.44772 2.44772 1 3 1H10.5858C10.851 1 11.1054 1.10536 11.2929 1.29289L13.7071 3.70711C13.8946 3.89464 14 4.149 14 4.41421V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 1V4C5 4.55228 5.44772 5 6 5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="10" width="6" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/>`;
        } else if (type === 'receipt') {
            svg.innerHTML = `<path d="M3 1.5C2.72386 1.5 2.5 1.72386 2.5 2V14C2.5 14.2761 2.72386 14.5 3 14.5H13C13.2761 14.5 13.5 14.2761 13.5 14V2C13.5 1.72386 13.2761 1.5 13 1.5H3Z" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="4.5" x2="11" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="9.5" x2="9" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 13L6 12L7 13L8 12L9 13L10 12L11 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        return svg;
    }

    function createStyledBadge(text, type, color) {
        const wrapper = document.createElement('div');
        wrapper.className = 'p2p-analytics-badge-item';
        Object.assign(wrapper.style, {
            display: 'inline-flex', flexDirection: 'row', alignItems: 'center',
            gap: '4px', padding: '2px 6px', borderRadius: '4px',
            backgroundColor: color.bg, border: `1px solid ${color.border}`,
            maxWidth: '100%', marginTop: '3px'
        });
        const iconWrapper = document.createElement('div');
        Object.assign(iconWrapper.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '12px', height: '12px', color: color.text, flexShrink: '0'
        });
        iconWrapper.appendChild(createSvgIcon(type));
        const label = document.createElement('span');
        label.textContent = text;
        Object.assign(label.style, {
            fontSize: '11px', lineHeight: '1.2', color: color.text,
            whiteSpace: 'nowrap', fontWeight: '500'
        });
        wrapper.appendChild(iconWrapper);
        wrapper.appendChild(label);
        return wrapper;
    }

    // ── Поиск строк ордеров ───────────────────────────────────────────────────
    /**
     * Находит все строки-контейнеры ордеров на странице Gate.
     * Gate использует Mantine div-таблицу, не <tr>.
     * Стратегия: ищем кнопки "Посмотреть детали" / "Квитанция" и поднимаемся
     * до контейнера с ID ордера (7–12 цифр).
     */
    /**
     * Находит строки ордеров.
     * Стратегия: берём кнопку "Посмотреть детали" и поднимаемся к наименьшему
     * предку, который содержит ровно ОДИН числовой ID ордера (свой, а не чужие).
     * Это предотвращает захват общего родителя для нескольких строк.
     */
    function findOrderRows() {
        const actionEls = Array.from(document.querySelectorAll('a, button, span'))
            .filter(el => {
                // Берём только конечные узлы (без дочерних) с нужным текстом
                if (el.children.length > 0) return false;
                const t = (el.textContent || '').trim().toLowerCase();
                return t === 'посмотреть детали' || t === 'квитанция' ||
                       t === 'view details' || t === 'details';
            });

        console.log('[P2P Gate List] Action buttons found:', actionEls.length);

        const rows = new Set();
        for (const el of actionEls) {
            // Поднимаемся вверх и ищем наименьший предок содержащий ровно один ID
            let best = null;
            let node = el.parentElement;
            for (let i = 0; i < 15 && node && node !== document.body; i++) {
                const id = extractOrderIdFromElement(node);
                if (id) {
                    // Проверяем что этот узел не является общим для нескольких строк
                    // (считаем сколько кнопок "детали" он содержит)
                    const detailBtns = Array.from(node.querySelectorAll('a, button, span'))
                        .filter(b => {
                            if (b.children.length > 0) return false;
                            const t = (b.textContent || '').trim().toLowerCase();
                            return t === 'посмотреть детали' || t === 'details' || t === 'квитанция';
                        });
                    if (detailBtns.length === 1) {
                        // Ровно одна кнопка — это наша строка
                        best = node;
                        break;
                    } else if (!best) {
                        // Несколько кнопок — общий предок, берём как запасной
                        best = node;
                    }
                }
                node = node.parentElement;
            }
            if (best) rows.add(best);
        }

        // Запасной вариант: Mantine-строки
        if (rows.size === 0) {
            const candidates = document.querySelectorAll(
                '[class*="mantine-Table-tr"], [class*="mantine-Table-row"], tr'
            );
            for (const el of candidates) {
                if (extractOrderIdFromElement(el)) rows.add(el);
            }
        }

        console.log('[P2P Gate List] Rows identified:', rows.size);
        return [...rows];
    }

    /**
     * Извлекает ID ордера из элемента-строки.
     * Приоритеты:
     *   1. Ссылка transaction_details в href
     *   2. .cursor-pointer листовой узел только с цифрами (8+ цифр — чтобы не захватить год/цену)
     *   3. Первый прямой дочерний блок (первая "колонка") — ищем там числа
     */
    function extractOrderIdFromElement(el) {
        if (!el) return null;

        // 1. Ссылка на детали ордера (самый надёжный способ)
        const link = el.querySelector('a[href*="transaction_details"]');
        if (link) {
            const m = (link.getAttribute('href') || '').match(/transaction_details[\\/=](\d+)/);
            if (m) return m[1];
        }

        // 2. .cursor-pointer листовой узел — Gate рендерит ID ордера именно так
        //    Требуем 8+ цифр, чтобы не спутать с годом (2026) или ценой (85)
        const cursors = el.querySelectorAll('.cursor-pointer');
        for (const c of cursors) {
            if (c.children.length > 0) continue;
            const t = (c.textContent || '').trim();
            if (/^\d{8,12}$/.test(t)) return t;
        }

        // 3. Ищем ТОЛЬКО в первом прямом дочернем блоке (первая колонка = ID ордера)
        const firstCol = el.children && el.children[0];
        if (firstCol) {
            // Берём только листовые узлы первой колонки
            const leaves = Array.from(firstCol.querySelectorAll('div, span'));
            for (const leaf of leaves) {
                if (leaf.children.length > 0) continue;
                const t = (leaf.textContent || '').trim();
                // 7–12 цифр но НЕ похоже на дату (YYYY-MM-DD) или время (HH:MM:SS)
                if (/^\d{7,12}$/.test(t) && !/^\d{4}-/.test(t)) return t;
            }
            // Запасной — regex по всему тексту первой колонки
            const raw = (firstCol.textContent || '').replace(/\d{4}-\d{2}-\d{2}/g, '');
            const m = raw.match(/(\d{7,12})/);
            if (m) return m[1];
        }

        return null;
    }

    // Обёртка для совместимости с processRow
    function extractOrderIdFromRow(row) {
        return extractOrderIdFromElement(row);
    }

    // ── Поиск контейнера для бейджей ─────────────────────────────────────────
    /**
     * Ищет ячейку статуса в строке Gate.
     *
     * Реальная структура строки (из HTML):
     * div.sc-eEfZyg (строка)
     *   ├─ div (ID + дата)
     *   ├─ div.mantine-2yyo8a (разделитель)
     *   ├─ div "Покупка/Продажа"
     *   ├─ div.mantine-2yyo8a
     *   ├─ ... колонки с данными ...
     *   ├─ div.sc-fEcfgj (СТАТУС — предпоследний значимый потомок)
     *   │    └─ div.mantine-1sayu55
     *   │         ├─ div "Завершено"   ← сюда вставляем бейдж
     *   │         └─ div "Квитанция о транзакции"
     *   ├─ div.mantine-2yyo8a
     *   └─ div.sc-mlMua (кнопки — последний значимый потомок)
     *
     * Стратегия: берём предпоследний значимый прямой потомок строки.
     * Это надёжнее чем искать текст "Завершено" по всему дереву —
     * текстовый поиск может попасть в соседнюю строку при определённых layout-ах.
     */
    function findTargetContainer(row) {
        if (!row) return null;

        // Получаем прямых потомков строки, пропуская пустые разделители
        const significantChildren = Array.from(row.children).filter(el => {
            const t = (el.textContent || '').trim();
            // Пропускаем пустые mantine-разделители (mantine-2yyo8a и подобные)
            return t.length > 0;
        });

        // Строка Gate: [...колонки данных..., колонка СТАТУСА, колонка КНОПОК]
        // Берём предпоследний значимый потомок = колонка статуса
        if (significantChildren.length >= 2) {
            const statusCol = significantChildren[significantChildren.length - 2];
            const statusTexts = ['завершено', 'отменено', 'в споре', 'открыт', 'completed', 'cancelled', 'open', 'disputed'];
            const colText = (statusCol.textContent || '').toLowerCase();
            if (statusTexts.some(s => colText.includes(s))) {
                // Возвращаем сам statusCol — бейдж будет добавлен через appendChild
                // и встанет ПОСЛЕ текста "Завершено" и кнопки "Квитанция"
                return statusCol;
            }
        }

        // Запасной вариант: ищем прямого потомка содержащего текст статуса
        const statusTexts2 = ['завершено', 'отменено', 'в споре', 'completed', 'cancelled'];
        for (const child of significantChildren) {
            const t = (child.textContent || '').toLowerCase();
            if (statusTexts2.some(s => t.includes(s))) {
                return child; // возвращаем сам потомок-колонку
            }
        }

        // Крайний запасной вариант — предпоследняя колонка
        return significantChildren[significantChildren.length - 2] || row;
    }

    // ── Бейджи ────────────────────────────────────────────────────────────────
    function upsertBadges(container) {
        if (!container) return null;
        let wrapper = container.querySelector('.p2p-analytics-badges-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'p2p-analytics-badges-wrapper';
            Object.assign(wrapper.style, {
                display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px'
            });
            container.appendChild(wrapper);
        }
        return {
            wrapper,
            savedBadge: wrapper.querySelector('.p2p-analytics-saved-badge'),
            receiptBadge: wrapper.querySelector('.p2p-analytics-receipt-badge')
        };
    }

    function setBadgesState(badgesData, state) {
        const { wrapper, savedBadge, receiptBadge } = badgesData;
        if (!wrapper) return;
        const colors = {
            saved:   { bg: '#e6f4ff', text: '#0958d9', border: '#91caff' },
            receipt: { bg: '#f9f0ff', text: '#722ed1', border: '#d3adf7' }
        };
        let hasAny = false;
        if (state.isSaved) {
            if (!savedBadge) {
                const b = createStyledBadge('Отправлен', 'saved', colors.saved);
                b.classList.add('p2p-analytics-saved-badge');
                wrapper.appendChild(b);
            }
            hasAny = true;
        } else if (savedBadge) { savedBadge.remove(); }

        if (state.hasReceipt) {
            if (!receiptBadge) {
                const b = createStyledBadge('Чек пробит', 'receipt', colors.receipt);
                b.classList.add('p2p-analytics-receipt-badge');
                wrapper.appendChild(b);
            }
            hasAny = true;
        } else if (receiptBadge) { receiptBadge.remove(); }

        wrapper.style.display = hasAny ? 'flex' : 'none';
    }

    // ── API ───────────────────────────────────────────────────────────────────
    async function fetchOrder(orderId) {
        const P2P = getAuth();
        if (!P2P) throw new Error('Auth not ready');
        if (!await P2P.isAuthenticated()) throw new Error('Не авторизован');
        const res = await P2P.makeAuthenticatedRequest(
            `${P2P.API_BASE_URL}/api/order/by-string-id?stringOrderId=${encodeURIComponent(orderId)}&exchangeType=${EXCHANGE_TYPE_GATE}`,
            { method: 'GET' }
        );
        if (res.status === 404) throw new Error('404');
        if (res.status === 429) throw new Error('Слишком много запросов');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    function formatBadgeState(order) {
        // Логика бейджей:
        // - Ордер есть в системе → "Отправлен" (синий)
        // - Ордер есть в системе И чек пробит → оба: "Отправлен" + "Чек пробит"
        const isSaved = !!order;
        const hasReceipt = !!(order && order.receipt && order.receipt.uuid);
        return { isSaved, hasReceipt };
    }

    // ── Request queue ─────────────────────────────────────────────────────────
    class RequestQueue {
        constructor(max = 3) { this.max = max; this.running = 0; this.queue = []; }
        add(fn) {
            return new Promise((resolve, reject) => {
                this.queue.push({ fn, resolve, reject });
                this._run();
            });
        }
        async _run() {
            if (this.running >= this.max || !this.queue.length) return;
            this.running++;
            const { fn, resolve, reject } = this.queue.shift();
            try { resolve(await fn()); } catch (e) { reject(e); } finally {
                this.running--;
                this._run();
            }
        }
        clear() { this.queue = []; }
    }
    const requestQueue = new RequestQueue(3);

    // ── Обработка строки ──────────────────────────────────────────────────────
    async function processRow(row, version) {
        const orderId = extractOrderIdFromRow(row);
        if (!orderId || version !== processingVersion) return;

        const now = Date.now();
        const prevId      = row.getAttribute('data-p2p-order-id');
        const prevStatus  = row.getAttribute('data-p2p-status');
        const prevVersion = row.getAttribute('data-p2p-version');
        const prevTs      = parseInt(row.getAttribute('data-p2p-timestamp') || '0', 10);

        // Строка переиспользована под другой ордер — сбрасываем
        if (prevId && prevId !== orderId) {
            row.removeAttribute('data-p2p-status');
            row.removeAttribute('data-p2p-version');
            row.removeAttribute('data-p2p-timestamp');
            row.querySelectorAll('.p2p-analytics-badges-wrapper').forEach(b => b.remove());
        }

        // Уже обработано в этой версии
        if (prevId === orderId && prevVersion === String(version)) {
            if (prevStatus === 'loading' || prevStatus === 'done') return;
            if (prevStatus === 'stop404' && (now - prevTs) < STOP404_TTL_MS) return;
        }

        row.setAttribute('data-p2p-order-id', orderId);
        row.setAttribute('data-p2p-status', 'loading');
        row.setAttribute('data-p2p-version', String(version));
        row.setAttribute('data-p2p-timestamp', String(now));

        return requestQueue.add(async () => {
            // Строка могла измениться пока ждали очередь
            if (extractOrderIdFromRow(row) !== orderId) return;

            try {
                let order = null;
                try {
                    order = await fetchOrder(orderId);
                } catch (e) {
                    const msg = String(e?.message || e || '');
                    if (/404|not found|Не найден/i.test(msg)) {
                        row.setAttribute('data-p2p-status', 'stop404');
                        row.setAttribute('data-p2p-timestamp', String(Date.now()));
                    } else {
                        row.setAttribute('data-p2p-status', 'error');
                    }
                    return;
                }

                if (extractOrderIdFromRow(row) !== orderId) return; // ещё раз проверяем

                const state = formatBadgeState(order);
                console.log('[P2P Gate List] Order', orderId, '→ isSaved:', state.isSaved, 'hasReceipt:', state.hasReceipt);
                if (state.isSaved || state.hasReceipt) {
                    const container = findTargetContainer(row);
                    console.log('[P2P Gate List] Target container for', orderId, ':', container?.className?.substring(0, 40));
                    if (container) {
                        const badges = upsertBadges(container);
                        if (badges) setBadgesState(badges, state);
                    }
                }
                row.setAttribute('data-p2p-status', 'done');
            } catch (err) {
                console.error('[P2P Gate List] processRow error:', err);
                row.setAttribute('data-p2p-status', 'error');
            }
        });
    }

    // ── Обработка всех строк ──────────────────────────────────────────────────
    async function processAllVisibleRows(version) {
        const rows = findOrderRows();
        console.log('[P2P Gate List] Found rows:', rows.length);
        if (!rows.length) return;
        await Promise.all(rows.map(r => processRow(r, version).catch(e => {
            console.error('[P2P Gate List] processRow error:', e);
        })));
    }

    // ── Очистка ───────────────────────────────────────────────────────────────
    function clearAllBadges() {
        document.querySelectorAll('.p2p-analytics-badges-wrapper').forEach(el => el.remove());
        document.querySelectorAll('[data-p2p-order-id]').forEach(el => {
            el.removeAttribute('data-p2p-order-id');
            el.removeAttribute('data-p2p-status');
            el.removeAttribute('data-p2p-version');
            el.removeAttribute('data-p2p-timestamp');
        });
    }

    // ── Scheduling ────────────────────────────────────────────────────────────
    let scheduleTimeout = null;
    let pendingClearStates = false;

    function scheduleProcessing(clearStates = false) {
        if (clearStates) pendingClearStates = true;
        if (scheduleTimeout) clearTimeout(scheduleTimeout);
        scheduleTimeout = setTimeout(() => {
            scheduleTimeout = null;
            const ver = ++processingVersion;
            requestQueue.clear();
            if (pendingClearStates) { clearAllBadges(); pendingClearStates = false; }
            console.log('[P2P Gate List] Processing version:', ver);
            processAllVisibleRows(ver);
        }, 300);
    }

    // ── Observer ──────────────────────────────────────────────────────────────
    let paginationRetryTimeout = null;

    function startListObserver() {
        stopListObserver();

        paginationClickHandler = (e) => {
            const t = e.target;
            if (t && (
                t.matches('[class*="Pagination"]') ||
                t.closest('[class*="Pagination"], [class*="pagination"]') ||
                t.matches('button[data-action="previous"], button[data-action="next"]') ||
                t.closest('button[data-action="previous"], button[data-action="next"]')
            )) {
                console.log('[P2P Gate List] Pagination click');
                scheduleProcessing(true);
                if (paginationRetryTimeout) clearTimeout(paginationRetryTimeout);
                paginationRetryTimeout = setTimeout(() => scheduleProcessing(true), 900);
            }
        };
        document.addEventListener('click', paginationClickHandler, true);

        listObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                // Игнорируем собственные изменения
                if (m.target.closest?.('.p2p-analytics-badges-wrapper')) continue;
                if (m.target.classList?.contains('p2p-analytics-badges-wrapper')) continue;

                let ours = false;
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE &&
                        (node.classList?.contains('p2p-analytics-badges-wrapper') ||
                         node.classList?.contains('p2p-analytics-badge-item'))) {
                        ours = true; break;
                    }
                }
                if (ours) continue;

                // Реагируем на появление новых строк списка
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Новый блок содержащий кнопки деталей или числовые ID
                        const hasDetails = node.querySelector?.('a, button') &&
                            (node.querySelector?.('a[href*="transaction_details"]') ||
                             (node.textContent || '').match(/\d{7,12}/));
                        if (hasDetails) {
                            scheduleProcessing(false);
                            return;
                        }
                    }
                }
            }
        });

        // Наблюдаем за childList (новые узлы) И за изменениями атрибутов
        // Gate/Mantine SPA может перерисовывать список изменяя атрибуты, а не добавляя узлы
        listObserver.observe(document.documentElement, { subtree: true, childList: true });
        
        // Дополнительный интервал на случай если MutationObserver пропустил рендер
        // (React batched updates иногда не триггерят Observer правильно)
        let _lastRowCount = 0;
        const _rowCountChecker = setInterval(() => {
            if (!listObserver) { clearInterval(_rowCountChecker); return; }
            const rows = document.querySelectorAll('[data-p2p-order-id]');
            const newCount = document.querySelectorAll('button').length; // прокси метрика
            if (newCount !== _lastRowCount) {
                _lastRowCount = newCount;
                scheduleProcessing(false);
            }
        }, 1500);
    }

    function stopListObserver() {
        if (listObserver) { listObserver.disconnect(); listObserver = null; }
        if (paginationClickHandler) {
            document.removeEventListener('click', paginationClickHandler, true);
            paginationClickHandler = null;
        }
        if (scheduleTimeout) { clearTimeout(scheduleTimeout); scheduleTimeout = null; }
        if (paginationRetryTimeout) { clearTimeout(paginationRetryTimeout); paginationRetryTimeout = null; }
    }

    function cleanup() {
        stopListObserver();
        requestQueue.clear();
    }

    // ── URL watcher ───────────────────────────────────────────────────────────
    function ensureUrlWatcher() {
        if (urlWatcher) return;
        urlWatcher = setInterval(() => {
            const newUrl = location.href;
            const newParams = new URLSearchParams(location.search);
            const changed = newUrl !== currentUrl ||
                ['page','pageNum','offset','limit'].some(
                    k => newParams.get(k) !== currentUrlParams.get(k)
                );
            if (changed) {
                currentUrl = newUrl;
                currentUrlParams = newParams;
                init(true);
            }
        }, 300);

        window.addEventListener('popstate', () => init(true));
        window.addEventListener('hashchange', () => init(true));

        try {
            if (!history.pushState._p2pGatePatched) {
                const orig = history.pushState;
                history.pushState = function() {
                    const r = orig.apply(this, arguments);
                    setTimeout(() => init(true), 100);
                    return r;
                };
                history.pushState._p2pGatePatched = true;
            }
            if (!history.replaceState._p2pGatePatched) {
                const orig = history.replaceState;
                history.replaceState = function() {
                    const r = orig.apply(this, arguments);
                    setTimeout(() => init(true), 100);
                    return r;
                };
                history.replaceState._p2pGatePatched = true;
            }
        } catch(e) { console.warn('[P2P Gate List] history patch failed:', e); }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    let initInProgress = false;

    async function init(forceRefresh = false) {
        console.log('[P2P Gate List] init(), forceRefresh:', forceRefresh, 'url:', location.href);

        if (initInProgress) {
            if (forceRefresh) pendingForceRefresh = true;
            return;
        }
        if (!isTargetPage()) { cleanup(); return; }

        initInProgress = true;
        currentUrl = location.href;
        currentUrlParams = new URLSearchParams(location.search);

        cleanup();
        if (forceRefresh) clearAllBadges();

        const ready = await waitAuthReady();
        if (!ready) { initInProgress = false; return; }

        await new Promise(r => setTimeout(r, 500));

        scheduleProcessing(forceRefresh);
        startListObserver();
        initInProgress = false;

        if (pendingForceRefresh) {
            pendingForceRefresh = false;
            setTimeout(() => init(true), 100);
        }
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    ensureUrlWatcher();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(true));
    } else {
        init(true);
    }
    console.log('[P2P Gate List] Script loaded');
})();