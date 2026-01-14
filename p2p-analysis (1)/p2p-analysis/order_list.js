// Order List Content Script (Bybit P2P orderList page)
// Injects per-row order info fetched from backend and stays in sync with SPA updates

(function(){
    const URL_REQUIRED_PATH = /\/p2p\/(orderList|merchant-admin\/order-list)(\/.*)?$/;
    const REQUIRED_HOST = /bybit\.com$/;

    let listObserver = null;
    let urlWatcher = null;
    let currentUrl = location.href;

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
        wrapper.style.marginBottom = '2px';
        
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'p2p-analytics-badge-icon';
        iconWrapper.style.display = 'flex';
        iconWrapper.style.alignItems = 'center';
        iconWrapper.style.justifyContent = 'center';
        iconWrapper.style.width = '16px';
        iconWrapper.style.height = '16px';
        iconWrapper.style.color = color.text;
        iconWrapper.style.flexShrink = '0';
        
        const icon = createSvgIcon(type);
        iconWrapper.appendChild(icon);
        
        const label = document.createElement('span');
        label.className = 'p2p-analytics-badge-label';
        label.textContent = text;
        label.style.fontSize = '14px';
        label.style.lineHeight = '1.5715';
        label.style.color = 'var(--bds-gray-t1-title, rgba(0, 0, 0, 0.88))';
        label.style.whiteSpace = 'nowrap';
        label.style.fontWeight = '400';
        
        wrapper.appendChild(iconWrapper);
        wrapper.appendChild(label);
        
        return wrapper;
    }

    function upsertBadges(container, isNewTable) {
        if (!container) {
            console.log('[P2P] upsertBadges: container is null');
            return null;
        }
        
        // Ищем уже существующую обертку
        let wrapper = container.querySelector('.p2p-analytics-badges-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'p2p-analytics-badges-wrapper';
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.gap = '2px';
            wrapper.style.alignItems = 'flex-start';
            
            if (isNewTable) {
                // For new table: Position absolutely to the left of the status content
                // Ensure container is relative for absolute positioning context
                if (getComputedStyle(container).position === 'static') {
                    container.style.position = 'relative';
                }
                
                wrapper.style.position = 'absolute';
                wrapper.style.right = '100%'; // Push to the left of the container
                wrapper.style.top = '50%';
                wrapper.style.transform = 'translateY(-50%)'; // Center vertically
                wrapper.style.marginRight = '24px'; // Space between badges and status
                wrapper.style.width = 'max-content'; // Prevent wrapping
                
                container.insertBefore(wrapper, container.firstChild);
            } else {
                // For old table: Insert into flow with horizontal spacing
                wrapper.style.marginRight = '13%'; // Space between badges and status text
                // Вставляем в НАЧАЛО ячейки статуса (слева)
                container.insertBefore(wrapper, container.firstChild);
            }
            console.log('[P2P] upsertBadges: wrapper inserted');
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
        
        // Цветовые схемы для бейджей
        const colors = {
            saved: {
                bg: '#e6f4ff',      // Светло-голубой фон
                text: '#0958d9',    // Синий текст
                border: '#91caff'   // Голубая рамка
            },
            receipt: {
                bg: '#f9f0ff',      // Светло-фиолетовый фон
                text: '#722ed1',    // Фиолетовый текст
                border: '#d3adf7'   // Фиолетовая рамка
            }
        };
        
        let hasAnyBadge = false;
        
        // Бейдж "Отправлен"
        if (state.isSaved) {
            if (!badgesData.savedBadge) {
                const badge = createStyledBadge('Отправлен', 'saved', colors.saved);
                badge.className = 'p2p-analytics-saved-badge';
                wrapper.appendChild(badge);
            }
            hasAnyBadge = true;
        } else if (badgesData.savedBadge) {
            badgesData.savedBadge.remove();
        }
        
        // Бейдж "Чек пробит"
        if (state.hasReceipt) {
            if (!badgesData.receiptBadge) {
                const badge = createStyledBadge('Чек пробит', 'receipt', colors.receipt);
                badge.className = 'p2p-analytics-receipt-badge';
                wrapper.appendChild(badge);
            }
            hasAnyBadge = true;
        } else if (badgesData.receiptBadge) {
            badgesData.receiptBadge.remove();
        }
        
        // Показываем/скрываем обертку
        wrapper.style.display = hasAnyBadge ? 'flex' : 'none';
    }

    function extractOrderIdFromRow(row) {
        // Old Bybit table DOM: order id is inside td.order-id span.id
        let idEl = row.querySelector('td.fiat-amount .order-id .id, .order-id .id, .fiat-amount .id, span.id');
        if (idEl) return (idEl.textContent || '').trim();

        // New merchant admin table: Order ID is in the 2nd column (index 1)
        // Check if it's the new table structure by checking for cells
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
             // The order ID is in the text of the 2nd cell.
             // We look for a long sequence of digits.
             const text = cells[1].textContent || '';
             const match = text.match(/\d{18,}/); 
             if (match) return match[0];
        }
        return null;
    }

    async function fetchOrder(orderId) {
        const P2P = getAuth();
        if (!P2P) throw new Error('Auth not ready');
        const isAuth = await P2P.isAuthenticated();
        if (!isAuth) throw new Error('Не авторизован');
        const res = await P2P.makeAuthenticatedRequest(`${P2P.API_BASE_URL}/api/order?id=${encodeURIComponent(orderId)}`, { method: 'GET' });
        // 404 handled by makeAuthenticatedRequest as non-ok -> throw; try parse if ok
        const data = await res.json();
        return data;
    }

    function formatBadgeState(order) {
        const isSaved = !!order;
        const hasReceipt = !!order && !!order.receipt;
        return { isSaved, hasReceipt };
    }

    const rowStates = new Map(); // orderId -> {status: 'loading'|'done'|'error', ts}

    function clearRowStates() {
        rowStates.clear();
        console.log('[P2P] Row states cleared for new page');
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
    }

    const requestQueue = new RequestQueue(3); // Max 3 concurrent requests

    async function processRow(row) {
        const orderId = extractOrderIdFromRow(row);
        if (!orderId) return;
        
        // Prevent duplicate rapid requests
        const prev = rowStates.get(orderId);
        if (prev && (prev.status === 'loading' || prev.status === 'stop404')) return;

        // Add to queue to prevent overwhelming the API
        return requestQueue.add(async () => {
            rowStates.set(orderId, { status: 'loading', ts: Date.now() });

            try {
                let order = null;
                try {
                    order = await fetchOrder(orderId);
                } catch (e) {
                    // If backend returned non-ok, makeAuthenticatedRequest throws. Consider 404 as not saved.
                    const msg = String(e && e.message ? e.message : e || '');
                    if (/404|not found|Не найден/i.test(msg)) {
                        // Stop and do not update DOM for this order
                        rowStates.set(orderId, { status: 'stop404', ts: Date.now() });
                        return;
                    } else if (/403|Доступ запрещен|Нет доступа к этому ордеру|forbidden|access denied/i.test(msg)) {
                        // 403 for order means user doesn't have access to this order (not their order)
                        // Treat same as 404 - just skip this order silently
                        rowStates.set(orderId, { status: 'stop404', ts: Date.now() });
                        return;
                    } else if (/Не авторизован|Сессия истекла/i.test(msg)) {
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'auth' });
                        return;
                    } else if (/Слишком много запросов/i.test(msg)) {
                        // Rate limiting - just mark as error, don't spam logs
                        console.log(`[P2P] Rate limited for order ${orderId}, skipping`);
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'ratelimit' });
                        return;
                    } else {
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'network' });
                        return;
                    }
                }

            const state = formatBadgeState(order);
            // Detect table type and status cell
            let statusCell = row.querySelector('td.fiat-order-status');
            let isNewTable = false;

            if (!statusCell) {
                const cells = row.querySelectorAll('td');
                // In new table, status is last column (index 5 usually, but safer to take last)
                if (cells.length > 0 && row.closest('.merchant-order-list__table')) {
                    statusCell = cells[cells.length - 1];
                    isNewTable = true;
                }
            }

            if (statusCell) {
                // Проверяем, что это завершенный ордер
                let isCompleted = false;
                if (isNewTable) {
                    // In new table, look for "Завершено" text
                    isCompleted = (statusCell.textContent || '').includes('Завершено');
                } else {
                    const statusText = statusCell.querySelector('.moly-space-item.w-full.moly-space-item-first');
                    isCompleted = statusText && statusText.textContent.trim() === 'Завершено';
                }
                
                if (isCompleted) {
                    let targetContainer = statusCell;
                    if (isNewTable) {
                        // Insert inside the flex column container to stack properly
                        const innerDiv = statusCell.querySelector('.merchant-order-list__py-3');
                        if (innerDiv) targetContainer = innerDiv;
                    }

                    const badgesData = upsertBadges(targetContainer, isNewTable);
                    if (badgesData) {
                        setBadgesState(badgesData, state);
                    }
                }
            }
                rowStates.set(orderId, { status: 'done', ts: Date.now() });
            } catch (err) {
                console.error('[P2P] Error processing row:', err);
                rowStates.set(orderId, { status: 'error', ts: Date.now() });
            }
        });
    }

    async function processAllVisibleRows() {
        const table = document.querySelector('.otc-order-table, .merchant-order-list__table');
        if (!table) return;
        const rows = $all('tbody > tr', table);
        
        // Process rows through queue (automatically throttled to 3 concurrent)
        const promises = rows.map(row => processRow(row).catch(err => {
            console.error('[P2P] Error in processRow:', err);
        }));
        
        await Promise.all(promises);
        console.log('[P2P] Finished processing', rows.length, 'rows');
    }

    function startListObserver() {
        stopListObserver();
        listObserver = new MutationObserver(() => {
            // Debounced re-scan
            if (startListObserver._t) clearTimeout(startListObserver._t);
            startListObserver._t = setTimeout(processAllVisibleRows, 120);
        });
        listObserver.observe(document.documentElement, { subtree: true, childList: true });
    }

    function stopListObserver() {
        if (listObserver) { listObserver.disconnect(); listObserver = null; }
        if (startListObserver._t) { clearTimeout(startListObserver._t); startListObserver._t = null; }
    }

    function ensureUrlWatcher() {
        if (urlWatcher) {
            console.log('[P2P] URL watcher already running');
            return;
        }
        
        console.log('[P2P] Starting URL watcher for SPA navigation detection');
        
        // Poll for URL changes (catches all cases)
        urlWatcher = setInterval(() => {
            if (location.href !== currentUrl) {
                console.log('[P2P] URL change detected via polling:', currentUrl, '->', location.href);
                currentUrl = location.href;
                init();
            }
        }, 300);
        
        // Listen for browser back/forward navigation
        window.addEventListener('popstate', () => {
            console.log('[P2P] URL change detected via popstate');
            init();
        });
        
        // Listen for hash changes
        window.addEventListener('hashchange', () => {
            console.log('[P2P] URL change detected via hashchange');
            init();
        });
        
        // Patch history API to catch pushState/replaceState (SPA routing)
        try {
            if (!history.pushState._p2pPatched) {
                const originalPushState = history.pushState;
                history.pushState = function() {
                    const result = originalPushState.apply(this, arguments);
                    console.log('[P2P] URL change detected via pushState');
                    // Small delay to let SPA update DOM
                    setTimeout(() => init(), 100);
                    return result;
                };
                history.pushState._p2pPatched = true;
            }
            
            if (!history.replaceState._p2pPatched) {
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    const result = originalReplaceState.apply(this, arguments);
                    console.log('[P2P] URL change detected via replaceState');
                    // Small delay to let SPA update DOM
                    setTimeout(() => init(), 100);
                    return result;
                };
                history.replaceState._p2pPatched = true;
            }
        } catch(e) {
            console.warn('[P2P] Failed to patch history API:', e);
        }
    }

    function cleanup() {
        console.log('[P2P] Cleaning up order list script...');
        stopListObserver();
        // Don't clear rowStates here - only on page change
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

    let lastInitUrl = '';
    let initInProgress = false;

    async function init() {
        console.log('[P2P] Init called, current URL:', location.href);
        
        // Prevent multiple simultaneous inits
        if (initInProgress) {
            console.log('[P2P] Init already in progress, skipping...');
            return;
        }
        
        if (!isTargetPage()) { 
            console.log('[P2P] Not on target page, cleaning up...');
            cleanup(); 
            return; 
        }
        
        // If we're already initialized for this URL, just process rows
        if (lastInitUrl === location.href && listObserver) {
            console.log('[P2P] Already initialized for this URL, processing rows...');
            processAllVisibleRows();
            return;
        }
        
        initInProgress = true;
        lastInitUrl = location.href;
        
        console.log('[P2P] Starting fresh initialization...');
        cleanup();
        clearRowStates();
        
        const ready = await waitAuthReady();
        if (!ready) { 
            console.log('[P2P] Auth not ready after waiting');
            initInProgress = false;
            return; 
        }
        
        console.log('[P2P] Auth ready, processing rows and starting observer...');
        
        // Wait a bit for DOM to settle after SPA navigation
        await new Promise(resolve => setTimeout(resolve, 500));
        
        processAllVisibleRows();
        startListObserver();
        
        initInProgress = false;
        console.log('[P2P] Initialization complete');
    }

    // Start URL watcher immediately and globally (works even when not on target page)
    ensureUrlWatcher();
    
    // Initial check and setup
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    console.log('[P2P] Order list script loaded and initialized');
})();


