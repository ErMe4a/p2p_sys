// Order List Content Script (BingX P2P)
(function () {
    const REQUIRED_HOST = /bingx\.com$|paycat\.com$/;

    let listObserver = null;
    let urlWatcher = null;
    let currentUrl = location.href;

    function isTargetPage() {
        try {
            const url = new URL(location.href);
            if (!REQUIRED_HOST.test(url.hostname)) return false;
            // Активируемся если на странице есть таблица ордеров BingX
            return !!document.querySelector('tbody tr.row-item');
        } catch (_) {
            return false;
        }
    }

    function getAuth() {
        return window.P2PAuth || null;
    }

    function createSvgIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.style.display = 'block';

        if (type === 'saved') {
            svg.innerHTML = `
                <path d="M2 2C2 1.44772 2.44772 1 3 1H10.5858C10.851 1 11.1054 1.10536 11.2929 1.29289L13.7071 3.70711C13.8946 3.89464 14 4.149 14 4.41421V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 1V4C5 4.55228 5.44772 5 6 5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="5" y="10" width="6" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
            `;
        } else if (type === 'receipt') {
            svg.innerHTML = `
                <path d="M3 1.5C2.72386 1.5 2.5 1.72386 2.5 2V14C2.5 14.2761 2.72386 14.5 3 14.5H13C13.2761 14.5 13.5 14.2761 13.5 14V2C13.5 1.72386 13.2761 1.5 13 1.5H3Z" stroke="currentColor" stroke-width="1.5"/>
                <line x1="5" y1="4.5" x2="11" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="5" y1="9.5" x2="9" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M5 13L6 12L7 13L8 12L9 13L10 12L11 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            `;
        }
        return svg;
    }

    function createStyledBadge(text, type, color) {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'inline-flex';
        wrapper.style.flexDirection = 'row';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '4px';
        wrapper.style.marginTop = '2px';

        const iconWrapper = document.createElement('div');
        iconWrapper.style.display = 'flex';
        iconWrapper.style.alignItems = 'center';
        iconWrapper.style.justifyContent = 'center';
        iconWrapper.style.width = '16px';
        iconWrapper.style.height = '16px';
        iconWrapper.style.color = color.text;
        iconWrapper.style.flexShrink = '0';
        iconWrapper.appendChild(createSvgIcon(type));

        const label = document.createElement('span');
        label.textContent = text;
        label.style.fontSize = '12px';
        label.style.lineHeight = '1.5';
        label.style.color = color.text;
        label.style.whiteSpace = 'nowrap';
        label.style.fontWeight = '500';

        wrapper.appendChild(iconWrapper);
        wrapper.appendChild(label);
        return wrapper;
    }

    // Получаем или создаём обёртку для значков внутри строки
    function upsertBadgesWrapper(row) {
        const existing = row.querySelector('.p2p-analytics-badges-wrapper');
        if (existing) {
            return {
                wrapper: existing,
                savedBadge: existing.querySelector('.p2p-analytics-saved-badge'),
                receiptBadge: existing.querySelector('.p2p-analytics-receipt-badge'),
            };
        }

        // Вставляем обёртку в последний <td>, в flex-контейнер, перед блоком статуса
        const cells = row.querySelectorAll('td');
        if (!cells.length) return null;
        const lastCell = cells[cells.length - 1];

        const flexContainer = lastCell.querySelector('.flex.column-direction.gap16.align-end');
        if (!flexContainer) return null;

        // Второй div — блок со статусом (Выполнен/Отменен), вставляем перед ним
        const statusDiv = flexContainer.children[1];

        const wrapper = document.createElement('div');
        wrapper.className = 'p2p-analytics-badges-wrapper';
        wrapper.style.display = 'none';
        wrapper.style.flexDirection = 'column';
        wrapper.style.alignItems = 'flex-end';
        wrapper.style.gap = '2px';
        wrapper.style.marginTop = '2px';

        if (statusDiv) {
            flexContainer.insertBefore(wrapper, statusDiv);
        } else {
            flexContainer.appendChild(wrapper);
        }

        return { wrapper, savedBadge: null, receiptBadge: null };
    }

    function setBadgesState(badgesData, state) {
        const { wrapper } = badgesData;
        if (!wrapper) return;

        const colors = {
            saved:   { text: '#0958d9' },
            receipt: { text: '#722ed1' },
        };

        let hasAny = false;

        // Бейдж "Отправлен"
        if (state.isSaved) {
            if (!badgesData.savedBadge) {
                const badge = createStyledBadge('Отправлен', 'saved', colors.saved);
                badge.className = 'p2p-analytics-saved-badge';
                wrapper.appendChild(badge);
                badgesData.savedBadge = badge;
            }
            hasAny = true;
        } else if (badgesData.savedBadge) {
            badgesData.savedBadge.remove();
            badgesData.savedBadge = null;
        }

        // Бейдж "Чек пробит"
        if (state.hasReceipt) {
            if (!badgesData.receiptBadge) {
                const badge = createStyledBadge('Чек пробит', 'receipt', colors.receipt);
                badge.className = 'p2p-analytics-receipt-badge';
                wrapper.appendChild(badge);
                badgesData.receiptBadge = badge;
            }
            hasAny = true;
        } else if (badgesData.receiptBadge) {
            badgesData.receiptBadge.remove();
            badgesData.receiptBadge = null;
        }

        wrapper.style.display = hasAny ? 'flex' : 'none';
    }

    // Извлекаем Order ID — текстовый узел рядом со span "Ордера: "
    function extractOrderIdFromRow(row) {
        const cells = row.querySelectorAll('td');
        if (!cells.length) return null;
        const lastCell = cells[cells.length - 1];

        const orderSpans = lastCell.querySelectorAll('span.text3');
        for (const span of orderSpans) {
            if (!span.textContent.includes('Ордера')) continue;
            // Идём по соседним узлам после span
            let node = span.nextSibling;
            while (node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent.trim();
                    if (/^\d{10,}$/.test(text)) return text;
                }
                node = node.nextSibling;
            }
        }
        return null;
    }

    // Проверяем статус строки — только "Выполнен" обрабатываем
    function isCompletedRow(row) {
        const cells = row.querySelectorAll('td');
        if (!cells.length) return false;
        const lastCell = cells[cells.length - 1];
        const text = lastCell.textContent || '';
        return text.includes('Выполнен');
    }

    async function fetchOrder(orderId) {
        const P2P = getAuth();
        if (!P2P) throw new Error('Auth not ready');
        const isAuth = await P2P.isAuthenticated();
        if (!isAuth) throw new Error('Не авторизован');
        const res = await P2P.makeAuthenticatedRequest(
            `${P2P.API_BASE_URL}/api/order?id=${encodeURIComponent(orderId)}&exchangeType=5`,
            { method: 'GET' }
        );
        return await res.json();
    }

    function formatBadgeState(order) {
        return {
            isSaved: !!order,
            hasReceipt: !!order && !!order.receipt && !!order.receipt.uuid,
        };
    }

    const rowStates = new Map();

    function clearRowStates() {
        rowStates.clear();
    }

    class RequestQueue {
        constructor(maxConcurrent = 3) {
            this.maxConcurrent = maxConcurrent;
            this.running = 0;
            this.queue = [];
        }
        async add(fn) {
            return new Promise((resolve, reject) => {
                this.queue.push({ fn, resolve, reject });
                this.process();
            });
        }
        async process() {
            if (this.running >= this.maxConcurrent || !this.queue.length) return;
            this.running++;
            const { fn, resolve, reject } = this.queue.shift();
            try { resolve(await fn()); } catch (e) { reject(e); } finally {
                this.running--;
                this.process();
            }
        }
    }

    const requestQueue = new RequestQueue(3);

    async function processRow(row) {
        if (!isCompletedRow(row)) return;

        const orderId = extractOrderIdFromRow(row);
        if (!orderId) return;

        const prev = rowStates.get(orderId);
        if (prev && (prev.status === 'loading' || prev.status === 'stop404')) return;

        return requestQueue.add(async () => {
            rowStates.set(orderId, { status: 'loading', ts: Date.now() });

            try {
                let order = null;
                try {
                    order = await fetchOrder(orderId);
                } catch (e) {
                    const msg = String(e?.message || e || '');
                    if (/404|not found|Не найден/i.test(msg)) {
                        rowStates.set(orderId, { status: 'stop404', ts: Date.now() });
                        return;
                    } else if (/403|forbidden|access denied|Нет доступа/i.test(msg)) {
                        rowStates.set(orderId, { status: 'stop404', ts: Date.now() });
                        return;
                    } else if (/Не авторизован|Сессия истекла/i.test(msg)) {
                        rowStates.set(orderId, { status: 'error', ts: Date.now() });
                        return;
                    } else if (/Слишком много запросов/i.test(msg)) {
                        rowStates.set(orderId, { status: 'error', ts: Date.now() });
                        return;
                    } else {
                        rowStates.set(orderId, { status: 'error', ts: Date.now() });
                        return;
                    }
                }

                const state = formatBadgeState(order);
                const badgesData = upsertBadgesWrapper(row);
                if (badgesData) setBadgesState(badgesData, state);

                rowStates.set(orderId, { status: 'done', ts: Date.now() });
            } catch (err) {
                console.error('[P2P BingX] Error processing row:', err);
                rowStates.set(orderId, { status: 'error', ts: Date.now() });
            }
        });
    }

    async function processAllVisibleRows() {
        const rows = Array.from(document.querySelectorAll('tbody tr.row-item'));
        if (!rows.length) return;
        await Promise.all(rows.map(row => processRow(row).catch(() => {})));
    }

    function startListObserver() {
        stopListObserver();
        listObserver = new MutationObserver(() => {
            if (startListObserver._t) clearTimeout(startListObserver._t);
            startListObserver._t = setTimeout(processAllVisibleRows, 150);
        });
        listObserver.observe(document.documentElement, { subtree: true, childList: true });
    }

    function stopListObserver() {
        if (listObserver) { listObserver.disconnect(); listObserver = null; }
        if (startListObserver._t) { clearTimeout(startListObserver._t); startListObserver._t = null; }
    }

    function waitAuthReady() {
        return new Promise((resolve) => {
            let attempts = 0;
            const t = setInterval(() => {
                attempts++;
                if (getAuth()) { clearInterval(t); resolve(true); return; }
                if (attempts >= 40) { clearInterval(t); resolve(false); }
            }, 100);
        });
    }

    let lastInitUrl = '';
    let initInProgress = false;

    async function init() {
        if (initInProgress) return;

        // isTargetPage() проверяет наличие таблицы в DOM — нужна небольшая задержка
        if (!isTargetPage()) {
            stopListObserver();
            return;
        }

        if (lastInitUrl === location.href && listObserver) {
            processAllVisibleRows();
            return;
        }

        initInProgress = true;
        lastInitUrl = location.href;

        stopListObserver();
        clearRowStates();

        const ready = await waitAuthReady();
        if (!ready) { initInProgress = false; return; }

        await new Promise(resolve => setTimeout(resolve, 500));

        processAllVisibleRows();
        startListObserver();

        initInProgress = false;
    }

    function ensureUrlWatcher() {
        if (urlWatcher) return;
        urlWatcher = setInterval(() => {
            if (location.href !== currentUrl) {
                currentUrl = location.href;
                init();
            }
        }, 300);

        window.addEventListener('popstate', init);
        window.addEventListener('hashchange', init);

        try {
            if (!history.pushState._p2pBingxPatched) {
                const origPush = history.pushState;
                history.pushState = function () {
                    const r = origPush.apply(this, arguments);
                    setTimeout(init, 150);
                    return r;
                };
                history.pushState._p2pBingxPatched = true;
            }
            if (!history.replaceState._p2pBingxPatched) {
                const origReplace = history.replaceState;
                history.replaceState = function () {
                    const r = origReplace.apply(this, arguments);
                    setTimeout(init, 150);
                    return r;
                };
                history.replaceState._p2pBingxPatched = true;
            }
        } catch (e) {}
    }

    ensureUrlWatcher();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[P2P BingX] Order list script loaded');
})();
