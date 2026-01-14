// MEXC Order List Content Script
// Injects per-row order info fetched from backend and stays in sync with SPA updates

(function(){
    const URL_REQUIRED_PATH = /\/buy-crypto\/order-processing\/fiat-order-list/;
    const REQUIRED_HOST = /mexc\.com$/;

    let listObserver = null;
    let urlWatcher = null;
    let paginationClickHandler = null; // Храним ссылку для правильной очистки
    let currentUrl = location.href;
    let currentUrlParams = new URLSearchParams(location.search);
    
    // Версионирование для отмены устаревших операций
    let processingVersion = 0;
    let pendingForceRefresh = false;

    function isTargetPage() {
        try {
            const url = new URL(location.href);
            return REQUIRED_HOST.test(url.hostname) && URL_REQUIRED_PATH.test(url.pathname);
        } catch (_) {
            return false;
        }
    }

    function getAuth() {
        return window.P2PAuth || null;
    }

    function $(sel, root=document){ return root.querySelector(sel); }
    function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

    function createSvgIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.style.display = 'block';
        
        if (type === 'saved') {
            // Иконка дискеты (сохранение)
            svg.innerHTML = `
                <path d="M2 2C2 1.44772 2.44772 1 3 1H10.5858C10.851 1 11.1054 1.10536 11.2929 1.29289L13.7071 3.70711C13.8946 3.89464 14 4.149 14 4.41421V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 1V4C5 4.55228 5.44772 5 6 5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="5" y="10" width="6" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
            `;
        } else if (type === 'receipt') {
            // Иконка чека
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
        wrapper.className = 'p2p-analytics-badge-item';
        wrapper.style.display = 'inline-flex';
        wrapper.style.flexDirection = 'row';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '4px';
        wrapper.style.marginBottom = '4px';
        wrapper.style.padding = '2px 6px';
        wrapper.style.borderRadius = '4px';
        wrapper.style.backgroundColor = color.bg;
        wrapper.style.border = `1px solid ${color.border}`;
        wrapper.style.maxWidth = '100%';
        
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'p2p-analytics-badge-icon';
        iconWrapper.style.display = 'flex';
        iconWrapper.style.alignItems = 'center';
        iconWrapper.style.justifyContent = 'center';
        iconWrapper.style.width = '12px';
        iconWrapper.style.height = '12px';
        iconWrapper.style.color = color.text;
        iconWrapper.style.flexShrink = '0';
        
        const icon = createSvgIcon(type);
        iconWrapper.appendChild(icon);
        
        const label = document.createElement('span');
        label.className = 'p2p-analytics-badge-label';
        label.textContent = text;
        label.style.fontSize = '11px';
        label.style.lineHeight = '1.2';
        label.style.color = color.text;
        label.style.whiteSpace = 'nowrap';
        label.style.fontWeight = '500';
        
        wrapper.appendChild(iconWrapper);
        wrapper.appendChild(label);
        
        return wrapper;
    }

    function upsertBadges(container) {
        if (!container) {
            return null;
        }
        
        // Ищем уже существующую обертку
        let wrapper = container.querySelector('.p2p-analytics-badges-wrapper');
        
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'p2p-analytics-badges-wrapper';
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'row';
            wrapper.style.gap = '4px';
            wrapper.style.alignItems = 'center';
            wrapper.style.marginBottom = '4px';
            wrapper.style.flexWrap = 'wrap';
            
            container.insertBefore(wrapper, container.firstChild);
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
            saved: {
                bg: '#e6f4ff',
                text: '#0958d9',
                border: '#91caff'
            },
            receipt: {
                bg: '#f9f0ff',
                text: '#722ed1',
                border: '#d3adf7'
            }
        };
        
        let hasAnyBadge = false;
        
        if (state.isSaved) {
            if (!savedBadge) {
                const badge = createStyledBadge('Отправлен', 'saved', colors.saved);
                badge.classList.add('p2p-analytics-saved-badge');
                wrapper.appendChild(badge);
            }
            hasAnyBadge = true;
        } else if (savedBadge) {
            savedBadge.remove();
        }
        
        if (state.hasReceipt) {
            if (!receiptBadge) {
                const badge = createStyledBadge('Чек пробит', 'receipt', colors.receipt);
                badge.classList.add('p2p-analytics-receipt-badge');
                wrapper.appendChild(badge);
            }
            hasAnyBadge = true;
        } else if (receiptBadge) {
            receiptBadge.remove();
        }
        
        wrapper.style.display = hasAnyBadge ? 'flex' : 'none';
    }

    function extractOrderIdFromRow(row) {
        // MEXC fiat-order-list page structure:
        // Order ID is in a.page_orderIdLine__qi2I0 as text content
        
        // Method 1: Try to find via class name
        let orderIdLink = row.querySelector('a.page_orderIdLine__qi2I0, a[class*="orderIdLine"]');
        if (orderIdLink) {
            const text = (orderIdLink.textContent || '').trim();
            if (text && text.length >= 15) return text;
        }
        
        // Method 2: Try to find links with order-processing
        const linkEl = row.querySelector('a[href*="order-processing"]');
        if (linkEl) {
            // Try to extract from href
            const href = linkEl.getAttribute('href');
            const match = href.match(/[?&]id=([^&]+)/);
            if (match) return match[1];
            
            // Try to get from text content
            const text = (linkEl.textContent || '').trim();
            if (text && text.length >= 15 && /^[a-zA-Z0-9]+$/.test(text)) {
                return text;
            }
        }
        
        // Method 3: Try to find in data attributes
        const orderIdAttr = row.querySelector('[data-order-id]');
        if (orderIdAttr) {
            return orderIdAttr.getAttribute('data-order-id');
        }
        
        // Method 4: Look for long alphanumeric IDs in all links
        const allLinks = row.querySelectorAll('a');
        for (const link of allLinks) {
            const text = (link.textContent || '').trim();
            // MEXC order IDs are typically 18-20+ character alphanumeric strings starting with 'd'
            if (/^d\d{15,}$/.test(text)) {
                return text;
            }
        }
        
        return null;
    }

    async function fetchOrder(orderId) {
        const P2P = getAuth();
        if (!P2P) throw new Error('Auth not ready');
        const isAuth = await P2P.isAuthenticated();
        if (!isAuth) throw new Error('Не авторизован');
        const res = await P2P.makeAuthenticatedRequest(`${P2P.API_BASE_URL}/api/order/by-string-id?stringOrderId=${encodeURIComponent(orderId)}&exchangeType=3`, { method: 'GET' });
        const data = await res.json();
        return data;
    }

    function formatBadgeState(order) {
        const isSaved = !!order;
        const hasReceipt = !!order && !!order.receipt;
        return { isSaved, hasReceipt };
    }

    // Request queue to limit concurrent API calls (prevents rate limiting)
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
            if (this.running >= this.maxConcurrent || this.queue.length === 0) {
                return;
            }

            this.running++;
            const { fn, resolve, reject } = this.queue.shift();

            try {
                const result = await fn();
                resolve(result);
            } catch (error) {
                reject(error);
            } finally {
                this.running--;
                this.process();
            }
        }
        
        // Очистка очереди при смене страницы/пагинации
        clear() {
            this.queue = [];
        }
    }

    const requestQueue = new RequestQueue(3); // Max 3 concurrent requests

    function clearAllBadges() {
        // Remove all badges from the page
        const allBadgeWrappers = $all('.p2p-analytics-badges-wrapper');
        allBadgeWrappers.forEach(wrapper => {
            wrapper.remove();
        });
        
        // Также очищаем data-атрибуты со всех строк
        const allRows = $all('[data-p2p-order-id]');
        allRows.forEach(row => {
            row.removeAttribute('data-p2p-order-id');
            row.removeAttribute('data-p2p-status');
            row.removeAttribute('data-p2p-version');
        });
        
        console.log('[P2P MEXC] Cleared', allBadgeWrappers.length, 'badge wrappers and', allRows.length, 'row states');
    }

    // TTL для состояния stop404 (30 секунд)
    const STOP404_TTL_MS = 30000;

    async function processRow(row, version) {
        const orderId = extractOrderIdFromRow(row);
        if (!orderId) {
            return;
        }
        
        // Проверяем версию - если изменилась, прекращаем обработку
        if (version !== processingVersion) {
            console.log('[P2P MEXC] Version changed, skipping order:', orderId);
            return;
        }
        
        // Проверяем состояние на DOM-элементе
        const rowOrderId = row.getAttribute('data-p2p-order-id');
        const rowStatus = row.getAttribute('data-p2p-status');
        const rowVersion = row.getAttribute('data-p2p-version');
        const rowTimestamp = parseInt(row.getAttribute('data-p2p-timestamp') || '0', 10);
        const now = Date.now();
        
        // Если DOM переиспользован для другого ордера - сбрасываем состояние
        if (rowOrderId && rowOrderId !== orderId) {
            console.log('[P2P MEXC] Row reused for different order (old:', rowOrderId, 'new:', orderId, ') - clearing');
            row.removeAttribute('data-p2p-status');
            row.removeAttribute('data-p2p-version');
            row.removeAttribute('data-p2p-timestamp');
            // Ищем и удаляем все бейджи внутри этой строки (могут быть вложены глубоко)
            const oldBadges = row.querySelectorAll('.p2p-analytics-badges-wrapper');
            oldBadges.forEach(badge => badge.remove());
        }
        
        // Пропускаем если этот ордер уже обрабатывается или обработан в текущей версии
        if (rowOrderId === orderId && rowVersion === String(version)) {
            if (rowStatus === 'loading' || rowStatus === 'done') {
                return;
            }
            // Для stop404 проверяем TTL
            if (rowStatus === 'stop404' && (now - rowTimestamp) < STOP404_TTL_MS) {
                return;
            }
        }
        
        // Устанавливаем состояние loading
        row.setAttribute('data-p2p-order-id', orderId);
        row.setAttribute('data-p2p-status', 'loading');
        row.setAttribute('data-p2p-version', String(version));
        row.setAttribute('data-p2p-timestamp', String(now));

        // Add to queue to prevent overwhelming the API
        return requestQueue.add(async () => {
            // Проверяем, что DOM элемент всё ещё содержит тот же ордер
            const currentOrderIdBeforeRequest = extractOrderIdFromRow(row);
            if (currentOrderIdBeforeRequest !== orderId) {
                console.log('[P2P MEXC] Row content changed before request, skipping order:', orderId);
                return;
            }
            
            try {
                let order = null;
                try {
                    order = await fetchOrder(orderId);
                } catch (e) {
                    const msg = String(e && e.message ? e.message : e || '');
                    if (/404|not found|Не найден/i.test(msg)) {
                        row.setAttribute('data-p2p-status', 'stop404');
                        row.setAttribute('data-p2p-timestamp', String(Date.now()));
                        return;
                    } else if (/Не авторизован|Сессия истекла/i.test(msg)) {
                        row.setAttribute('data-p2p-status', 'error');
                        return;
                    } else if (/Слишком много запросов/i.test(msg)) {
                        console.log(`[P2P MEXC] Rate limited for order ${orderId}, will retry`);
                        row.setAttribute('data-p2p-status', 'error');
                        return;
                    } else {
                        row.setAttribute('data-p2p-status', 'error');
                        return;
                    }
                }
                
                // Проверяем, что DOM элемент всё ещё содержит тот же ордер
                const currentOrderId = extractOrderIdFromRow(row);
                if (currentOrderId !== orderId) {
                    console.log('[P2P MEXC] Row content changed during request, skipping badge update for:', orderId);
                    return;
                }

                const state = formatBadgeState(order);
                
                // Ищем контейнер статуса
                let statusContainer = row.querySelector('.page_tabListSix__s04Ms, [class*="tabListSix"]');
                if (!statusContainer) {
                    statusContainer = row.querySelector('[class*="status"], [class*="Status"]');
                }
                
                let targetContainer = null;
                
                if (statusContainer) {
                    const statusText = statusContainer.textContent || '';
                    const isCompleted = statusText.includes('Завершен') || statusText.includes('Completed');
                    
                    if (!isCompleted) {
                        row.setAttribute('data-p2p-status', 'done');
                        return;
                    }
                    
                    const statusTextEl = statusContainer.querySelector('.page_statusColText__md_kg, [class*="statusColText"]');
                    targetContainer = statusTextEl ? statusTextEl.parentElement : statusContainer;
                } else {
                    targetContainer = row.querySelector('.page_orderTabInfo__6ggOE, [class*="orderTabInfo"], [class*="order-info"]');
                    if (!targetContainer) {
                        targetContainer = row.firstElementChild;
                    }
                }
                
                if (targetContainer && (state.isSaved || state.hasReceipt)) {
                    const badgesData = upsertBadges(targetContainer);
                    if (badgesData) {
                        setBadgesState(badgesData, state);
                    }
                }
                
                row.setAttribute('data-p2p-status', 'done');
            } catch (err) {
                console.error('[P2P MEXC] Error processing row:', err);
                row.setAttribute('data-p2p-status', 'error');
            }
        });
    }

    // Единый механизм планирования обработки с debounce
    let scheduleTimeout = null;
    let pendingClearStates = false; // Флаг сохраняется между вызовами!
    
    function scheduleProcessing(clearStates = false) {
        // Если запрошена очистка - запоминаем это (не сбрасываем при последующих вызовах)
        if (clearStates) {
            pendingClearStates = true;
        }
        
        // Отменяем предыдущие запланированные обработки
        if (scheduleTimeout) {
            clearTimeout(scheduleTimeout);
        }
        
        scheduleTimeout = setTimeout(() => {
            scheduleTimeout = null;
            
            // Инкрементируем версию для отмены устаревших операций
            const currentVersion = ++processingVersion;
            
            // Очищаем очередь запросов от старых операций
            requestQueue.clear();
            
            // Используем сохранённый флаг очистки
            if (pendingClearStates) {
                console.log('[P2P MEXC] Clearing all states for new page/pagination');
                clearAllBadges();
                pendingClearStates = false; // Сбрасываем после использования
            }
            
            console.log('[P2P MEXC] Processing with version:', currentVersion);
            processAllVisibleRows(currentVersion);
        }, 250); // Единый debounce 250ms
    }
    
    async function processAllVisibleRows(version) {
        // MEXC fiat-order-list page structure:
        // Each order is in div.page_orderTableContent__kF0J0
        // Inside: div.page_orderTableListContent__WHvFy
        
        // Method 1: Try specific MEXC class
        let rows = $all('.page_orderTableContent__kF0J0, [class*="orderTableContent"]');
        
        // Method 2: Fallback to common patterns if not found
        if (rows.length === 0) {
            rows = $all('[class*="order-table"] [class*="order-item"], [class*="order-row"], [class*="orderList"] > div');
        }
        
        console.log('[P2P MEXC] Found', rows.length, 'rows to process, version:', version);
        
        if (rows.length === 0) {
            return;
        }
        
        // Process rows through queue (automatically throttled to 3 concurrent)
        const promises = rows.map(row => processRow(row, version).catch(err => {
            console.error('[P2P MEXC] Error in processRow:', err);
        }));
        
        await Promise.all(promises);
        
        // Проверяем, что версия не изменилась
        if (version === processingVersion) {
            console.log('[P2P MEXC] Finished processing', rows.length, 'rows, version:', version);
        } else {
            console.log('[P2P MEXC] Processing interrupted by newer version');
        }
    }

    let paginationRetryTimeout = null;
    
    function startListObserver() {
        stopListObserver();
        
        // Создаём обработчик клика на пагинации
        paginationClickHandler = (e) => {
            const target = e.target;
            // Check if clicked element is a pagination button
            if (target && (
                target.matches('[class*="pagination"]') ||
                target.closest('[class*="pagination"]') ||
                target.matches('[class*="Pagination"]') ||
                target.closest('[class*="Pagination"]') ||
                target.matches('.ant-pagination-item') ||
                target.closest('.ant-pagination-item') ||
                target.matches('.ant-pagination-prev') ||
                target.closest('.ant-pagination-prev') ||
                target.matches('.ant-pagination-next') ||
                target.closest('.ant-pagination-next')
            )) {
                console.log('[P2P MEXC] Pagination click detected');
                // Планируем обработку с очисткой состояний
                scheduleProcessing(true);
                
                // Дополнительная обработка с задержкой - MEXC может обновлять DOM асинхронно
                if (paginationRetryTimeout) {
                    clearTimeout(paginationRetryTimeout);
                }
                paginationRetryTimeout = setTimeout(() => {
                    console.log('[P2P MEXC] Pagination retry - ensuring all rows processed');
                    scheduleProcessing(true);
                }, 800);
            }
        };
        
        document.addEventListener('click', paginationClickHandler, true);
        
        // MutationObserver для отслеживания изменений DOM
        listObserver = new MutationObserver((mutations) => {
            // Проверяем, были ли значимые изменения (НЕ от наших бейджей)
            let hasSignificantChanges = false;
            
            for (const mutation of mutations) {
                // Игнорируем изменения наших собственных элементов
                if (mutation.target.closest && mutation.target.closest('.p2p-analytics-badges-wrapper')) {
                    continue;
                }
                
                // Игнорируем если target - это наш контейнер бейджей или его родитель
                if (mutation.target.classList && (
                    mutation.target.classList.contains('p2p-analytics-badges-wrapper') ||
                    mutation.target.classList.contains('p2p-analytics-badge-item') ||
                    mutation.target.classList.contains('p2p-analytics-saved-badge') ||
                    mutation.target.classList.contains('p2p-analytics-receipt-badge')
                )) {
                    continue;
                }
                
                // Проверяем добавленные узлы - игнорируем если это наши бейджи
                let isOurBadge = false;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList) {
                        if (node.classList.contains('p2p-analytics-badges-wrapper') ||
                            node.classList.contains('p2p-analytics-badge-item') ||
                            node.classList.contains('p2p-analytics-saved-badge') ||
                            node.classList.contains('p2p-analytics-receipt-badge')) {
                            isOurBadge = true;
                            break;
                        }
                    }
                }
                if (isOurBadge) {
                    continue;
                }
                
                // Проверяем добавленные узлы - это новые элементы заказов?
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Проверяем, это ли элемент списка ордеров
                        if (node.matches && (
                            node.matches('[class*="orderTableContent"]') ||
                            node.matches('[class*="order-row"]') ||
                            node.querySelector && node.querySelector('[class*="orderTableContent"]')
                        )) {
                            hasSignificantChanges = true;
                            break;
                        }
                    }
                }
                
                if (hasSignificantChanges) break;
            }
            
            if (hasSignificantChanges) {
                // Значимые изменения - планируем обработку без полной очистки
                scheduleProcessing(false);
            }
        });
        
        listObserver.observe(document.documentElement, { subtree: true, childList: true });
    }

    function stopListObserver() {
        if (listObserver) { 
            listObserver.disconnect(); 
            listObserver = null; 
        }
        if (paginationClickHandler) {
            document.removeEventListener('click', paginationClickHandler, true);
            paginationClickHandler = null;
        }
        if (scheduleTimeout) { 
            clearTimeout(scheduleTimeout); 
            scheduleTimeout = null; 
        }
        if (paginationRetryTimeout) {
            clearTimeout(paginationRetryTimeout);
            paginationRetryTimeout = null;
        }
    }

    function ensureUrlWatcher() {
        if (urlWatcher) {
            return;
        }
        
        console.log('[P2P MEXC] Starting URL watcher for SPA navigation detection');
        
        // Poll for URL changes (including query params for pagination)
        urlWatcher = setInterval(() => {
            const newUrl = location.href;
            const newParams = new URLSearchParams(location.search);
            
            // Check if URL changed
            const urlChanged = newUrl !== currentUrl;
            
            // Check if pagination-related params changed (page, offset, etc.)
            const paginationParamsChanged = 
                newParams.get('page') !== currentUrlParams.get('page') ||
                newParams.get('offset') !== currentUrlParams.get('offset') ||
                newParams.get('limit') !== currentUrlParams.get('limit');
            
            if (urlChanged || paginationParamsChanged) {
                console.log('[P2P MEXC] URL or pagination params changed:', currentUrl, '->', newUrl);
                currentUrl = newUrl;
                currentUrlParams = newParams;
                
                // При изменении URL или пагинации - полная переинициализация
                init(true);
            }
        }, 300);
        
        // Listen for browser back/forward navigation
        window.addEventListener('popstate', () => {
            console.log('[P2P MEXC] URL change detected via popstate');
            init(true);
        });
        
        // Listen for hash changes
        window.addEventListener('hashchange', () => {
            console.log('[P2P MEXC] URL change detected via hashchange');
            init(true);
        });
        
        // Patch history API
        try {
            if (!history.pushState._p2pPatched) {
                const originalPushState = history.pushState;
                history.pushState = function() {
                    const result = originalPushState.apply(this, arguments);
                    console.log('[P2P MEXC] URL change detected via pushState');
                    setTimeout(() => init(true), 100);
                    return result;
                };
                history.pushState._p2pPatched = true;
            }
            
            if (!history.replaceState._p2pPatched) {
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    const result = originalReplaceState.apply(this, arguments);
                    console.log('[P2P MEXC] URL change detected via replaceState');
                    setTimeout(() => init(true), 100);
                    return result;
                };
                history.replaceState._p2pPatched = true;
            }
        } catch(e) {
            console.warn('[P2P MEXC] Failed to patch history API:', e);
        }
    }

    function cleanup() {
        console.log('[P2P MEXC] Cleaning up order list script...');
        stopListObserver();
        requestQueue.clear();
    }

    function waitAuthReady() {
        return new Promise((resolve) => {
            let attempts = 0;
            const max = 40; // ~4s
            const t = setInterval(() => {
                attempts++;
                if (getAuth()) { clearInterval(t); resolve(true); return; }
                if (attempts >= max) { clearInterval(t); resolve(false); }
            }, 100);
        });
    }

    let initInProgress = false;

    async function init(forceRefresh = false) {
        console.log('[P2P MEXC] Init called, forceRefresh:', forceRefresh, 'current URL:', location.href);
        
        if (initInProgress) {
            console.log('[P2P MEXC] Init already in progress');
            if (forceRefresh) {
                pendingForceRefresh = true;
            }
            return;
        }
        
        if (!isTargetPage()) { 
            console.log('[P2P MEXC] Not on target page, cleaning up...');
            cleanup(); 
            return; 
        }
        
        initInProgress = true;
        currentUrl = location.href;
        currentUrlParams = new URLSearchParams(location.search);
        
        console.log('[P2P MEXC] Starting initialization...');
        cleanup();
        
        // При forceRefresh или первом запуске очищаем все состояния
        if (forceRefresh) {
            clearAllBadges();
        }
        
        const ready = await waitAuthReady();
        if (!ready) { 
            console.log('[P2P MEXC] Auth not ready after waiting');
            initInProgress = false;
            return; 
        }
        
        console.log('[P2P MEXC] Auth ready, waiting for DOM to settle...');
        
        // Ждём стабилизации DOM
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Запускаем обработку
        scheduleProcessing(forceRefresh);
        startListObserver();
        
        initInProgress = false;
        console.log('[P2P MEXC] Initialization complete');
        
        // Если был запрошен force refresh во время init
        if (pendingForceRefresh) {
            pendingForceRefresh = false;
            console.log('[P2P MEXC] Processing pending force refresh');
            setTimeout(() => init(true), 100);
        }
    }

    ensureUrlWatcher();
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(true));
    } else {
        init(true);
    }
    
    console.log('[P2P MEXC] Order list script loaded and initialized');
})();
