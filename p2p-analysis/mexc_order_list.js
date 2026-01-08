// MEXC Order List Content Script
// Injects per-row order info fetched from backend and stays in sync with SPA updates

(function(){
    const URL_REQUIRED_PATH = /\/buy-crypto\/order-processing\/fiat-order-list/;
    const REQUIRED_HOST = /mexc\.com$/;

    let listObserver = null;
    let urlWatcher = null;
    let currentUrl = location.href;
    let currentUrlParams = new URLSearchParams(location.search);

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
            wrapper.style.flexDirection = 'row'; // Horizontal layout
            wrapper.style.gap = '4px';
            wrapper.style.alignItems = 'center';
            wrapper.style.marginBottom = '4px';
            wrapper.style.flexWrap = 'wrap';
            
            // Вставляем в НАЧАЛО контейнера (перед текстом статуса)
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

    const rowStates = new Map(); // orderId -> {status: 'loading'|'done'|'error', ts}

    function clearRowStates() {
        rowStates.clear();
        console.log('[P2P MEXC] Row states cleared for new page');
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

    function clearAllBadges() {
        // Remove all badges from the page
        const allBadgeWrappers = $all('.p2p-analytics-badges-wrapper');
        allBadgeWrappers.forEach(wrapper => {
            wrapper.remove();
        });
        console.log('[P2P MEXC] Cleared', allBadgeWrappers.length, 'badge wrappers');
    }

    async function processRow(row) {
        const orderId = extractOrderIdFromRow(row);
        if (!orderId) {
            console.log('[P2P MEXC] No order ID found in row');
            return;
        }
        
        console.log('[P2P MEXC] Processing order ID:', orderId);
        
        // Check if this row was previously processed with a different orderId
        // This happens during pagination when DOM elements are reused
        const previousOrderId = row.getAttribute('data-p2p-order-id');
        if (previousOrderId && previousOrderId !== orderId) {
            console.log('[P2P MEXC] Row reused for different order (old:', previousOrderId, 'new:', orderId, ') - clearing badges');
            // Clear old badges from this row
            const oldBadges = row.querySelector('.p2p-analytics-badges-wrapper');
            if (oldBadges) {
                oldBadges.remove();
            }
        }
        
        // Mark this row with current orderId
        row.setAttribute('data-p2p-order-id', orderId);
        
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
                    const msg = String(e && e.message ? e.message : e || '');
                    if (/404|not found|Не найден/i.test(msg)) {
                        rowStates.set(orderId, { status: 'stop404', ts: Date.now() });
                        return;
                    } else if (/Не авторизован|Сессия истекла/i.test(msg)) {
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'auth' });
                        return;
                    } else if (/Слишком много запросов/i.test(msg)) {
                        console.log(`[P2P MEXC] Rate limited for order ${orderId}, skipping`);
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'ratelimit' });
                        return;
                    } else {
                        rowStates.set(orderId, { status: 'error', ts: Date.now(), error: 'network' });
                        return;
                    }
                }

            const state = formatBadgeState(order);
            
            // Only show badges for completed orders
            // MEXC structure: .page_orderTabInfo__6ggOE > .page_tabListSix__s04Ms
            const statusContainer = row.querySelector('.page_tabListSix__s04Ms, [class*="tabListSix"]');
            if (!statusContainer) {
                console.log('[P2P MEXC] Status container not found for order:', orderId);
                rowStates.set(orderId, { status: 'done', ts: Date.now() });
                return;
            }
            
            // Check if order is completed
            const statusText = statusContainer.textContent || '';
            const isCompleted = statusText.includes('Завершен') || statusText.includes('Completed');
            
            if (!isCompleted) {
                console.log('[P2P MEXC] Order not completed, skipping badges:', orderId);
                rowStates.set(orderId, { status: 'done', ts: Date.now() });
                return;
            }
            
            // Find the status text element to insert badges before it
            const statusTextEl = statusContainer.querySelector('.page_statusColText__md_kg, [class*="statusColText"]');
            if (!statusTextEl) {
                console.log('[P2P MEXC] Status text element not found for order:', orderId);
                rowStates.set(orderId, { status: 'done', ts: Date.now() });
                return;
            }
            
            // Get or create badge container in the parent of statusTextEl
            const targetContainer = statusTextEl.parentElement;
            if (targetContainer && (state.isSaved || state.hasReceipt)) {
                const badgesData = upsertBadges(targetContainer);
                if (badgesData) {
                    setBadgesState(badgesData, state);
                }
            }
            
                rowStates.set(orderId, { status: 'done', ts: Date.now() });
            } catch (err) {
                console.error('[P2P MEXC] Error processing row:', err);
                rowStates.set(orderId, { status: 'error', ts: Date.now() });
            }
        });
    }

    let lastFirstOrderId = null; // Track first order ID to detect pagination
    
    async function processAllVisibleRows() {
        // MEXC fiat-order-list page structure:
        // Each order is in div.page_orderTableContent__kF0J0
        // Inside: div.page_orderTableListContent__WHvFy
        
        // Method 1: Try specific MEXC class
        let rows = $all('.page_orderTableContent__kF0J0, [class*="orderTableContent"]');
        
        // Method 2: Fallback to common patterns if not found
        if (rows.length === 0) {
            rows = $all('[class*="order-table"] [class*="order-item"], [class*="order-row"], [class*="orderList"] > div');
        }
        
        console.log('[P2P MEXC] Found', rows.length, 'rows to process');
        
        // Detect pagination: if first order ID changed, we're on a different page
        if (rows.length > 0) {
            const firstOrderId = extractOrderIdFromRow(rows[0]);
            if (firstOrderId) {
                if (lastFirstOrderId && lastFirstOrderId !== firstOrderId) {
                    console.log('[P2P MEXC] Pagination detected: first order ID changed from', lastFirstOrderId, 'to', firstOrderId);
                    clearAllBadges();
                    clearRowStates();
                }
                lastFirstOrderId = firstOrderId;
            }
        }
        
        // Process rows through queue (automatically throttled to 3 concurrent)
        const promises = rows.map(row => processRow(row).catch(err => {
            console.error('[P2P MEXC] Error in processRow:', err);
        }));
        
        await Promise.all(promises);
        console.log('[P2P MEXC] Finished processing', rows.length, 'rows');
    }

    function startListObserver() {
        stopListObserver();
        listObserver = new MutationObserver(() => {
            // Debounced re-scan
            if (startListObserver._t) clearTimeout(startListObserver._t);
            startListObserver._t = setTimeout(processAllVisibleRows, 120);
        });
        listObserver.observe(document.documentElement, { subtree: true, childList: true });
        
        // Listen for clicks on pagination buttons
        document.addEventListener('click', (e) => {
            const target = e.target;
            // Check if clicked element is a pagination button
            if (target && (
                target.matches('[class*="pagination"]') ||
                target.closest('[class*="pagination"]') ||
                target.matches('[class*="Pagination"]') ||
                target.closest('[class*="Pagination"]')
            )) {
                console.log('[P2P MEXC] Pagination click detected, will refresh badges');
                // Wait for content to update, then clear and reprocess
                setTimeout(() => {
                    console.log('[P2P MEXC] Processing after pagination click');
                    processAllVisibleRows();
                }, 500);
            }
        }, true); // Use capture phase to catch clicks early
    }

    function stopListObserver() {
        if (listObserver) { listObserver.disconnect(); listObserver = null; }
        if (startListObserver._t) { clearTimeout(startListObserver._t); startListObserver._t = null; }
    }

    function ensureUrlWatcher() {
        if (urlWatcher) {
            console.log('[P2P MEXC] URL watcher already running');
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
                if (paginationParamsChanged) {
                    console.log('[P2P MEXC] Pagination params changed - clearing badges');
                    clearAllBadges();
                    clearRowStates();
                    lastFirstOrderId = null;
                }
                currentUrl = newUrl;
                currentUrlParams = newParams;
                init();
            }
        }, 300);
        
        // Listen for browser back/forward navigation
        window.addEventListener('popstate', () => {
            console.log('[P2P MEXC] URL change detected via popstate');
            init();
        });
        
        // Listen for hash changes
        window.addEventListener('hashchange', () => {
            console.log('[P2P MEXC] URL change detected via hashchange');
            init();
        });
        
        // Patch history API
        try {
            if (!history.pushState._p2pPatched) {
                const originalPushState = history.pushState;
                history.pushState = function() {
                    const result = originalPushState.apply(this, arguments);
                    console.log('[P2P MEXC] URL change detected via pushState');
                    setTimeout(() => init(), 100);
                    return result;
                };
                history.pushState._p2pPatched = true;
            }
            
            if (!history.replaceState._p2pPatched) {
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    const result = originalReplaceState.apply(this, arguments);
                    console.log('[P2P MEXC] URL change detected via replaceState');
                    setTimeout(() => init(), 100);
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
        lastFirstOrderId = null;
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
        console.log('[P2P MEXC] Init called, current URL:', location.href);
        
        if (initInProgress) {
            console.log('[P2P MEXC] Init already in progress, skipping...');
            return;
        }
        
        if (!isTargetPage()) { 
            console.log('[P2P MEXC] Not on target page, cleaning up...');
            cleanup(); 
            return; 
        }
        
        if (lastInitUrl === location.href && listObserver) {
            console.log('[P2P MEXC] Already initialized for this URL, processing rows...');
            processAllVisibleRows();
            return;
        }
        
        initInProgress = true;
        lastInitUrl = location.href;
        currentUrl = location.href;
        currentUrlParams = new URLSearchParams(location.search);
        
        console.log('[P2P MEXC] Starting fresh initialization...');
        cleanup();
        clearRowStates();
        
        const ready = await waitAuthReady();
        if (!ready) { 
            console.log('[P2P MEXC] Auth not ready after waiting');
            initInProgress = false;
            return; 
        }
        
        console.log('[P2P MEXC] Auth ready, processing rows and starting observer...');
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        processAllVisibleRows();
        startListObserver();
        
        initInProgress = false;
        console.log('[P2P MEXC] Initialization complete');
    }

    ensureUrlWatcher();
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    console.log('[P2P MEXC] Order list script loaded and initialized');
})();

