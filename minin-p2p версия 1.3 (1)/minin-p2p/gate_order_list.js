// Gate.io Order List Content Script
// Injects per-row order info fetched from backend and stays in sync with SPA updates

(function(){
    // URL patterns for Gate.io P2P order list page
    const URL_REQUIRED_PATTERNS = [
        /\/p2p\/orders/,
        /\/p2p\/my-orders/,
        /\/p2p\/trade\/records/,
        /\/my\/p2p\/orders/,
        /\/p2p\/order\/list/
    ];
    const REQUIRED_HOST = /gate\.com$/;

    let listObserver = null;
    let urlWatcher = null;
    let paginationClickHandler = null;
    let currentUrl = location.href;
    let currentUrlParams = new URLSearchParams(location.search);
    
    // Versioning to cancel stale operations
    let processingVersion = 0;
    let pendingForceRefresh = false;

    // Exchange type constant for Gate.io (must match server)
    const EXCHANGE_TYPE_GATE = 4; // Assuming 4 is the ID for Gate.io

    function isTargetPage() {
    try {
        const url = new URL(location.href);
        const hostname = url.hostname;
        
        // Проверяем домен - может быть gate.com или gate.io
        const isCorrectDomain = hostname.includes('gate.com') || hostname.includes('gate.io');
        
        // Проверяем путь - страница списка ордеров
        const path = url.pathname;
        const isOrdersPage = path.includes('/p2p/orders') || 
                             path.includes('/p2p/my-orders') || 
                             path.includes('/my/p2p/orders');
        
        console.log('[P2P Gate] URL check - domain:', hostname, 'isCorrect:', isCorrectDomain, 
                    'path:', path, 'isOrdersPage:', isOrdersPage);
        
        return isCorrectDomain && isOrdersPage;
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
            // Floppy disk icon (saved)
            svg.innerHTML = `
                <path d="M2 2C2 1.44772 2.44772 1 3 1H10.5858C10.851 1 11.1054 1.10536 11.2929 1.29289L13.7071 3.70711C13.8946 3.89464 14 4.149 14 4.41421V14C14 14.5523 13.5523 15 13 15H3C2.44772 15 2 14.5523 2 14V2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5 1V4C5 4.55228 5.44772 5 6 5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="5" y="10" width="6" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
            `;
        } else if (type === 'receipt') {
            // Receipt icon
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
    
    let wrapper = container.querySelector('.p2p-analytics-badges-wrapper');
    
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'p2p-analytics-badges-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'row';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';
        wrapper.style.marginBottom = '4px';
        wrapper.style.marginTop = '4px';
        wrapper.style.flexWrap = 'wrap';
        
        // Вставляем бейджи в ячейку статуса или в конец строки
        container.insertBefore(wrapper, container.firstChild);
    }
    
    return {
        wrapper,
        savedBadge: wrapper.querySelector('.p2p-analytics-saved-badge'),
        receiptBadge: wrapper.querySelector('.p2p-analytics-receipt-badge')
    };
}

function findTargetContainer(row) {
    // Пытаемся найти ячейку статуса (последняя колонка)
    const cells = row.querySelectorAll('td');
    if (cells.length >= 7) {
        const statusCell = cells[6]; // 7-я колонка (индекс 6) - Статус
        const statusContent = statusCell.querySelector('.mantine-18l7ils, div');
        if (statusContent) {
            return statusContent;
        }
        return statusCell;
    }
    
    // Если не нашли по колонкам, ищем элемент со статусом
    const statusElement = row.querySelector('[class*="status"], [class*="Status"], .mantine-1bm8x5c');
    if (statusElement) {
        return statusElement.parentElement || statusElement;
    }
    
    // В крайнем случае используем всю строку
    return row;
}

async function processRow(row, version) {
    const orderId = extractOrderIdFromRow(row);
    if (!orderId) {
        return;
    }
    
    if (version !== processingVersion) {
        console.log('[P2P Gate] Version changed, skipping order:', orderId);
        return;
    }
    
    const rowOrderId = row.getAttribute('data-p2p-order-id');
    const rowStatus = row.getAttribute('data-p2p-status');
    const rowVersion = row.getAttribute('data-p2p-version');
    const rowTimestamp = parseInt(row.getAttribute('data-p2p-timestamp') || '0', 10);
    const now = Date.now();
    
    if (rowOrderId && rowOrderId !== orderId) {
        console.log('[P2P Gate] Row reused for different order (old:', rowOrderId, 'new:', orderId, ') - clearing');
        row.removeAttribute('data-p2p-status');
        row.removeAttribute('data-p2p-version');
        row.removeAttribute('data-p2p-timestamp');
        const oldBadges = row.querySelectorAll('.p2p-analytics-badges-wrapper');
        oldBadges.forEach(badge => badge.remove());
    }
    
    if (rowOrderId === orderId && rowVersion === String(version)) {
        if (rowStatus === 'loading' || rowStatus === 'done') {
            return;
        }
        if (rowStatus === 'stop404' && (now - rowTimestamp) < STOP404_TTL_MS) {
            return;
        }
    }
    
    row.setAttribute('data-p2p-order-id', orderId);
    row.setAttribute('data-p2p-status', 'loading');
    row.setAttribute('data-p2p-version', String(version));
    row.setAttribute('data-p2p-timestamp', String(now));

    return requestQueue.add(async () => {
        const currentOrderIdBeforeRequest = extractOrderIdFromRow(row);
        if (currentOrderIdBeforeRequest !== orderId) {
            console.log('[P2P Gate] Row content changed before request, skipping order:', orderId);
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
                    console.log(`[P2P Gate] Rate limited for order ${orderId}, will retry`);
                    row.setAttribute('data-p2p-status', 'error');
                    return;
                } else {
                    row.setAttribute('data-p2p-status', 'error');
                    return;
                }
            }
            
            const currentOrderId = extractOrderIdFromRow(row);
            if (currentOrderId !== orderId) {
                console.log('[P2P Gate] Row content changed during request, skipping badge update for:', orderId);
                return;
            }

            const state = formatBadgeState(order);
            
            // Находим контейнер для бейджей
            const targetContainer = findTargetContainer(row);
            
            if (targetContainer && (state.isSaved || state.hasReceipt)) {
                const badgesData = upsertBadges(targetContainer);
                if (badgesData) {
                    setBadgesState(badgesData, state);
                }
            }
            
            row.setAttribute('data-p2p-status', 'done');
        } catch (err) {
            console.error('[P2P Gate] Error processing row:', err);
            row.setAttribute('data-p2p-status', 'error');
        }
    });
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
    console.log('[P2P Gate] extractOrderIdFromRow for element:', row);
    
    // Метод 1: Ищем элемент с ID ордера по классу mantine-Text-root cursor-pointer mantine-dmywfc
    // В вашем HTML это выглядит так: <div class="mantine-Text-root cursor-pointer mantine-dmywfc">25162693</div>
    const orderIdElement = row.querySelector('.mantine-Text-root.cursor-pointer.mantine-dmywfc');
    if (orderIdElement) {
        const orderId = orderIdElement.textContent?.trim() || '';
        if (orderId && /^\d+$/.test(orderId)) {
            console.log('[P2P Gate] Found order ID from cursor-pointer element:', orderId);
            return orderId;
        }
    }
    
    // Метод 2: Ищем любые элементы с классом cursor-pointer, содержащие только цифры
    const cursorElements = row.querySelectorAll('.cursor-pointer');
    for (const el of cursorElements) {
        const text = el.textContent?.trim() || '';
        if (text.length >= 6 && /^\d+$/.test(text)) {
            console.log('[P2P Gate] Found order ID from cursor-pointer text:', text);
            return text;
        }
    }
    
    // Метод 3: Ищем по позиции в таблице (вторая колонка - ID Ордера)
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
        const idCell = cells[1]; // Вторая колонка (индекс 1) - ID Ордера
        const idElement = idCell.querySelector('.mantine-Text-root, div');
        if (idElement) {
            const text = idElement.textContent?.trim() || '';
            if (text.length >= 6 && /^\d+$/.test(text)) {
                console.log('[P2P Gate] Found order ID from second column:', text);
                return text;
            }
        }
    }
    
    // Метод 4: Ищем ссылку на детали ордера
    const detailLink = row.querySelector('a[href*="transaction_details"]');
    if (detailLink) {
        const href = detailLink.getAttribute('href');
        const match = href.match(/transaction_details[\/=](\d+)/);
        if (match) {
            console.log('[P2P Gate] Found order ID from transaction_details link:', match[1]);
            return match[1];
        }
    }
    
    // Метод 5: Ищем любой элемент с числовым содержимым длиной 6+ цифр
    const allElements = row.querySelectorAll('div, span, td');
    for (const el of allElements) {
        // Пропускаем элементы, которые содержат другие элементы
        if (el.children.length > 0) continue;
        
        const text = el.textContent?.trim() || '';
        if (text.length >= 6 && /^\d+$/.test(text)) {
            console.log('[P2P Gate] Found order ID from numeric element:', text);
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
        
        const res = await P2P.makeAuthenticatedRequest(
            `${P2P.API_BASE_URL}/api/order/by-string-id?stringOrderId=${encodeURIComponent(orderId)}&exchangeType=${EXCHANGE_TYPE_GATE}`, 
            { method: 'GET' }
        );
        const data = await res.json();
        return data;
    }

    function formatBadgeState(order) {
        const isSaved = !!order;
        
        // Check if receipt exists and has UUID
        const hasReceipt = !!order && 
                           !!order.receipt && 
                           !!order.receipt.uuid; 

        return { isSaved, hasReceipt };
    }

    // Request queue to limit concurrent API calls
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
        
        clear() {
            this.queue = [];
        }
    }

    const requestQueue = new RequestQueue(3);

    function clearAllBadges() {
        const allBadgeWrappers = $all('.p2p-analytics-badges-wrapper');
        allBadgeWrappers.forEach(wrapper => {
            wrapper.remove();
        });
        
        const allRows = $all('[data-p2p-order-id]');
        allRows.forEach(row => {
            row.removeAttribute('data-p2p-order-id');
            row.removeAttribute('data-p2p-status');
            row.removeAttribute('data-p2p-version');
            row.removeAttribute('data-p2p-timestamp');
        });
        
        console.log('[P2P Gate] Cleared', allBadgeWrappers.length, 'badge wrappers and', allRows.length, 'row states');
    }

    const STOP404_TTL_MS = 30000;

    async function processRow(row, version) {
        const orderId = extractOrderIdFromRow(row);
        if (!orderId) {
            return;
        }
        
        if (version !== processingVersion) {
            console.log('[P2P Gate] Version changed, skipping order:', orderId);
            return;
        }
        
        const rowOrderId = row.getAttribute('data-p2p-order-id');
        const rowStatus = row.getAttribute('data-p2p-status');
        const rowVersion = row.getAttribute('data-p2p-version');
        const rowTimestamp = parseInt(row.getAttribute('data-p2p-timestamp') || '0', 10);
        const now = Date.now();
        
        if (rowOrderId && rowOrderId !== orderId) {
            console.log('[P2P Gate] Row reused for different order (old:', rowOrderId, 'new:', orderId, ') - clearing');
            row.removeAttribute('data-p2p-status');
            row.removeAttribute('data-p2p-version');
            row.removeAttribute('data-p2p-timestamp');
            const oldBadges = row.querySelectorAll('.p2p-analytics-badges-wrapper');
            oldBadges.forEach(badge => badge.remove());
        }
        
        if (rowOrderId === orderId && rowVersion === String(version)) {
            if (rowStatus === 'loading' || rowStatus === 'done') {
                return;
            }
            if (rowStatus === 'stop404' && (now - rowTimestamp) < STOP404_TTL_MS) {
                return;
            }
        }
        
        row.setAttribute('data-p2p-order-id', orderId);
        row.setAttribute('data-p2p-status', 'loading');
        row.setAttribute('data-p2p-version', String(version));
        row.setAttribute('data-p2p-timestamp', String(now));

        return requestQueue.add(async () => {
            const currentOrderIdBeforeRequest = extractOrderIdFromRow(row);
            if (currentOrderIdBeforeRequest !== orderId) {
                console.log('[P2P Gate] Row content changed before request, skipping order:', orderId);
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
                        console.log(`[P2P Gate] Rate limited for order ${orderId}, will retry`);
                        row.setAttribute('data-p2p-status', 'error');
                        return;
                    } else {
                        row.setAttribute('data-p2p-status', 'error');
                        return;
                    }
                }
                
                const currentOrderId = extractOrderIdFromRow(row);
                if (currentOrderId !== orderId) {
                    console.log('[P2P Gate] Row content changed during request, skipping badge update for:', orderId);
                    return;
                }

                const state = formatBadgeState(order);
                
                // Find the status cell/container in Gate.io order list
                let statusContainer = row.querySelector(
                    '[class*="status"], [class*="Status"], ' +
                    '[class*="state"], [class*="order-state"], ' +
                    'td:last-child, .ant-table-cell:last-child'
                );
                
                // If no status container, try to find the main info container
                if (!statusContainer) {
                    statusContainer = row.querySelector(
                        '[class*="order-info"], [class*="orderInfo"], ' +
                        '.ant-table-cell, td'
                    );
                }
                
                let targetContainer = statusContainer;
                
                // If we found a table cell, look inside for a better container
                if (statusContainer && statusContainer.matches('td')) {
                    const innerDiv = statusContainer.querySelector('div');
                    if (innerDiv) {
                        targetContainer = innerDiv;
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
                console.error('[P2P Gate] Error processing row:', err);
                row.setAttribute('data-p2p-status', 'error');
            }
        });
    }

    let scheduleTimeout = null;
    let pendingClearStates = false;
    
    function scheduleProcessing(clearStates = false) {
        if (clearStates) {
            pendingClearStates = true;
        }
        
        if (scheduleTimeout) {
            clearTimeout(scheduleTimeout);
        }
        
        scheduleTimeout = setTimeout(() => {
            scheduleTimeout = null;
            
            const currentVersion = ++processingVersion;
            
            requestQueue.clear();
            
            if (pendingClearStates) {
                console.log('[P2P Gate] Clearing all states for new page/pagination');
                clearAllBadges();
                pendingClearStates = false;
            }
            
            console.log('[P2P Gate] Processing with version:', currentVersion);
            processAllVisibleRows(currentVersion);
        }, 250);
    }
    
    async function processAllVisibleRows(version) {
    console.log('[P2P Gate] processAllVisibleRows called, looking for rows...');
    
    // Метод 1: Ищем строки таблицы по тегу tr
    let rows = $all('tr');
    console.log('[P2P Gate] Found with tr selector:', rows.length);
    
    // Фильтруем только строки с данными (не заголовок)
    rows = rows.filter(row => {
        // Пропускаем строку заголовка
        if (row.querySelector('th')) return false;
        // Должна иметь ячейки
        const cells = row.querySelectorAll('td');
        return cells.length >= 2;
    });
    console.log('[P2P Gate] After filtering header rows:', rows.length);
    
    // Метод 2: Если не нашли, ищем по специфичным классам Gate.io
    if (rows.length === 0) {
        rows = $all('tr.h-\\[80px\\], tr[class*="h-["]');
        console.log('[P2P Gate] Found with height class selector:', rows.length);
    }
    
    // Метод 3: Ищем любые элементы, похожие на строки
    if (rows.length === 0) {
        rows = $all('[class*="order-item"], [class*="orderItem"], [class*="order-row"], [class*="orderRow"]');
        console.log('[P2P Gate] Found with fallback selectors:', rows.length);
    }
    
    console.log('[P2P Gate] Total rows to process:', rows.length, 'version:', version);
    
    if (rows.length === 0) {
        return;
    }
    
    const promises = rows.map(row => processRow(row, version).catch(err => {
        console.error('[P2P Gate] Error in processRow:', err);
    }));
    
    await Promise.all(promises);
    
    if (version === processingVersion) {
        console.log('[P2P Gate] Finished processing', rows.length, 'rows, version:', version);
    } else {
        console.log('[P2P Gate] Processing interrupted by newer version');
    }
}

    let paginationRetryTimeout = null;
    
    function startListObserver() {
        stopListObserver();
        
        paginationClickHandler = (e) => {
            const target = e.target;
            // Check if clicked element is a pagination button (Gate.io uses Ant Design)
            if (target && (
                target.matches('.ant-pagination-item, .ant-pagination-item *') ||
                target.closest('.ant-pagination') ||
                target.matches('[class*="pagination"]') ||
                target.closest('[class*="pagination"]') ||
                target.matches('.ant-pagination-prev, .ant-pagination-next') ||
                target.closest('.ant-pagination-prev, .ant-pagination-next')
            )) {
                console.log('[P2P Gate] Pagination click detected');
                scheduleProcessing(true);
                
                if (paginationRetryTimeout) {
                    clearTimeout(paginationRetryTimeout);
                }
                paginationRetryTimeout = setTimeout(() => {
                    console.log('[P2P Gate] Pagination retry - ensuring all rows processed');
                    scheduleProcessing(true);
                }, 800);
            }
        };
        
        document.addEventListener('click', paginationClickHandler, true);
        
        listObserver = new MutationObserver((mutations) => {
            let hasSignificantChanges = false;
            
            for (const mutation of mutations) {
                if (mutation.target.closest && mutation.target.closest('.p2p-analytics-badges-wrapper')) {
                    continue;
                }
                
                if (mutation.target.classList && (
                    mutation.target.classList.contains('p2p-analytics-badges-wrapper') ||
                    mutation.target.classList.contains('p2p-analytics-badge-item')
                )) {
                    continue;
                }
                
                let isOurBadge = false;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList) {
                        if (node.classList.contains('p2p-analytics-badges-wrapper') ||
                            node.classList.contains('p2p-analytics-badge-item')) {
                            isOurBadge = true;
                            break;
                        }
                    }
                }
                if (isOurBadge) {
                    continue;
                }
                
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.matches && (
                            node.matches('tr.ant-table-row') ||
                            node.matches('[class*="order-item"]') ||
                            node.querySelector && (
                                node.querySelector('tr.ant-table-row') ||
                                node.querySelector('[class*="order-item"]')
                            )
                        )) {
                            hasSignificantChanges = true;
                            break;
                        }
                    }
                }
                
                if (hasSignificantChanges) break;
            }
            
            if (hasSignificantChanges) {
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
        
        console.log('[P2P Gate] Starting URL watcher for SPA navigation detection');
        
        urlWatcher = setInterval(() => {
            const newUrl = location.href;
            const newParams = new URLSearchParams(location.search);
            
            const urlChanged = newUrl !== currentUrl;
            
            const paginationParamsChanged = 
                newParams.get('page') !== currentUrlParams.get('page') ||
                newParams.get('pageNum') !== currentUrlParams.get('pageNum') ||
                newParams.get('offset') !== currentUrlParams.get('offset') ||
                newParams.get('limit') !== currentUrlParams.get('limit');
            
            if (urlChanged || paginationParamsChanged) {
                console.log('[P2P Gate] URL or pagination params changed:', currentUrl, '->', newUrl);
                currentUrl = newUrl;
                currentUrlParams = newParams;
                
                init(true);
            }
        }, 300);
        
        window.addEventListener('popstate', () => {
            console.log('[P2P Gate] URL change detected via popstate');
            init(true);
        });
        
        window.addEventListener('hashchange', () => {
            console.log('[P2P Gate] URL change detected via hashchange');
            init(true);
        });
        
        try {
            if (!history.pushState._p2pPatched) {
                const originalPushState = history.pushState;
                history.pushState = function() {
                    const result = originalPushState.apply(this, arguments);
                    console.log('[P2P Gate] URL change detected via pushState');
                    setTimeout(() => init(true), 100);
                    return result;
                };
                history.pushState._p2pPatched = true;
            }
            
            if (!history.replaceState._p2pPatched) {
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    const result = originalReplaceState.apply(this, arguments);
                    console.log('[P2P Gate] URL change detected via replaceState');
                    setTimeout(() => init(true), 100);
                    return result;
                };
                history.replaceState._p2pPatched = true;
            }
        } catch(e) {
            console.warn('[P2P Gate] Failed to patch history API:', e);
        }
    }

    function cleanup() {
        console.log('[P2P Gate] Cleaning up order list script...');
        stopListObserver();
        requestQueue.clear();
    }

    function waitAuthReady() {
        return new Promise((resolve) => {
            let attempts = 0;
            const max = 40;
            const t = setInterval(() => {
                attempts++;
                if (getAuth()) { clearInterval(t); resolve(true); return; }
                if (attempts >= max) { clearInterval(t); resolve(false); }
            }, 100);
        });
    }

    let initInProgress = false;

    async function init(forceRefresh = false) {
        console.log('[P2P Gate] Init called, forceRefresh:', forceRefresh, 'current URL:', location.href);
        
        if (initInProgress) {
            console.log('[P2P Gate] Init already in progress');
            if (forceRefresh) {
                pendingForceRefresh = true;
            }
            return;
        }
        
        if (!isTargetPage()) { 
            console.log('[P2P Gate] Not on target page, cleaning up...');
            cleanup(); 
            return; 
        }
        
        initInProgress = true;
        currentUrl = location.href;
        currentUrlParams = new URLSearchParams(location.search);
        
        console.log('[P2P Gate] Starting initialization...');
        cleanup();
        
        if (forceRefresh) {
            clearAllBadges();
        }
        
        const ready = await waitAuthReady();
        if (!ready) { 
            console.log('[P2P Gate] Auth not ready after waiting');
            initInProgress = false;
            return; 
        }
        
        console.log('[P2P Gate] Auth ready, waiting for DOM to settle...');
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        scheduleProcessing(forceRefresh);
        startListObserver();
        
        initInProgress = false;
        console.log('[P2P Gate] Initialization complete');
        
        if (pendingForceRefresh) {
            pendingForceRefresh = false;
            console.log('[P2P Gate] Processing pending force refresh');
            setTimeout(() => init(true), 100);
        }
    }

    ensureUrlWatcher();
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(true));
    } else {
        init(true);
    }
    
    console.log('[P2P Gate] Order list script loaded and initialized');
})();