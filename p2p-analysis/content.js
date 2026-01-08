// P2P Analytics Content Script
console.log('P2P Analytics: Content script loaded');
console.log('P2P Analytics: Script load time:', new Date().toISOString());

// Exchange type constant for Bybit
const EXCHANGE_TYPE_BYBIT = 1;

// Commission type constants are already declared in order_api.js
// COMMISSION_TYPE_PERCENT and COMMISSION_TYPE_MONEY are available globally

// UI color constants
const GOLD_COLOR_RGB = 'rgb(247, 166, 0)'; // #F7A600

// Helper to detect if we're on merchant-admin page
function isMerchantAdminPage() {
    return /merchant-admin/i.test(window.location.href);
}

// New: helpers to detect order type on page (locale-agnostic)
function normalizeText(str) {
    try {
        return (str || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '');
    } catch (_) {
        return (str || '').toLowerCase();
    }
}

function detectOrderType() {
    // Primary signal: the header title (e.g., "Покупка USDT" | "Продажа USDT" | translations)
    const titleEl = document.querySelector('.title');
    const titleText = normalizeText(titleEl ? titleEl.textContent : '');

    // Broad token sets for BUY/SELL across common locales
    const BUY_TOKENS = [
        'buy', 'compra', 'acheter', 'comprar', 'kaufen', 'покупка', 'купити', 'mua', 'beli', 'شراء', '购买', '買入', '購入', 'zakup'
    ];
    const SELL_TOKENS = [
        'sell', 'venta', 'vendre', 'venda', 'verkauf', 'продажа', 'продати', 'ban', 'jual', 'sat', 'satis', 'بيع', '出售', '賣出', '売却', 'sprzedaz'
    ];

    const hasBuyToken = BUY_TOKENS.some(t => titleText.includes(t));
    const hasSellToken = SELL_TOKENS.some(t => titleText.includes(t));
    if (hasBuyToken && !hasSellToken) return 'buy';
    if (hasSellToken && !hasBuyToken) return 'sell';

    // Fallback signal: role label next to counterparty in chat header, e.g. "(Покупатель)" | "(Buyer)" | etc.
    try {
        const caption = document.querySelector('.im-container-caption');
        const roleText = normalizeText(caption ? caption.textContent : '');
        const buyerTokens = ['buyer', 'покупател', 'pokupatel', 'comprador', 'acheteur', 'kupujacy', 'alici', 'nguoimua', 'pembeli', '買家', 'pokupets', 'pokupets'];
        const sellerTokens = ['seller', 'продавец', 'sprzedawca', 'vendedor', 'vendeur', 'satıcı', 'nguoiban', 'penjual', '卖家'];
        const isBuyerRole = buyerTokens.some(t => roleText.includes(t));
        const isSellerRole = sellerTokens.some(t => roleText.includes(t));
        if (isBuyerRole && !isSellerRole) return 'sell'; // if counterparty is Buyer, we are Seller
        if (isSellerRole && !isBuyerRole) return 'buy';  // if counterparty is Seller, we are Buyer
    } catch (_) { /* noop */ }

    // As a last resort, unknown
    return 'unknown';
}

function isBuyPage() {
    try {
        return detectOrderType() === 'buy';
    } catch (_) {
        return false;
    }
}

function isSellPage() {
    try {
        return detectOrderType() === 'sell';
    } catch (_) {
        return false;
    }
}

// New: Display name replacement helpers
let currentDisplayName = '';
let currentSellDisplayNameTemp = '';
// Added: keep the original BUY page name to allow reset
let originalBuyName = '';
async function loadDisplayNameFromStorage() {
    try {
        const res = await chrome.storage.sync.get(['displayName']);
        currentDisplayName = res.displayName || '';
        return currentDisplayName;
    } catch (e) {
        console.warn('P2P Analytics: Failed to load display name:', e);
        currentDisplayName = '';
        return '';
    }
}

function replacePayerNameInDom(name, root = document) {
    if (!name) return false;
    let replaced = false;

    // Strategy 1: Look for specific container text pattern
    const candidateContainers = root.querySelectorAll('div.moly-space-item span.moly-text, .moly-space-item .moly-text');
    candidateContainers.forEach(container => {
        const text = container.textContent || '';
        const matchesPhrase = /real name of the payer/i.test(text) || /имя\s+плат[её]льщ/i.test(text);
        if (matchesPhrase) {
            const nameSpan = container.querySelector('span[style]') || container.querySelector('span:last-child');
            if (nameSpan) {
                if ((nameSpan.textContent || '').trim() !== name) {
                    nameSpan.textContent = name;
                }
                replaced = true;
            }
        }
    });

    // Strategy 2: Fallback – style-based match (gold color + bold)
    if (!replaced) {
        const spans = root.querySelectorAll('span[style*="font-weight"], span[style*="font-weight:"]');
        spans.forEach(span => {
            try {
                const cs = window.getComputedStyle(span);
                const isBold = (parseInt(cs.fontWeight, 10) || 400) >= 600 || cs.fontWeight === 'bold' || cs.fontWeight === '600';
                const isGold = cs.color === GOLD_COLOR_RGB; // #F7A600
                if (isBold && isGold) {
                    // Heuristic: parent text contains a verification hint
                    const parentText = span.parentElement ? span.parentElement.textContent || '' : '';
                    if (/verify/i.test(parentText) || /реал/i.test(parentText) || /имя/i.test(parentText)) {
                        if ((span.textContent || '').trim() !== name) {
                            span.textContent = name;
                        }
                        replaced = true;
                    }
                }
            } catch (e) {
                // ignore
            }
        });
    }

    return replaced;
}

// New: SELL-specific robust replacement using gold+bold style parameter
function replaceSellerNameInDom(name, root = document) {
    if (!name) return false;
    let replaced = false;

    // Strategy 1: Explicit "Verified" line — replace the last item (name)
    try {
        const verifiedLines = root.querySelectorAll('.im-container-caption__info-verified');
        verifiedLines.forEach((line) => {
            const nameContainer = line.querySelector('.moly-space-item.moly-space-item-last');
            if (nameContainer) {
                const current = (nameContainer.textContent || '').trim();
                if (current !== name) {
                    nameContainer.textContent = name;
                }
                replaced = true;
            }
        });
    } catch (e) {
        // ignore
    }

    // Strategy 1.1: Chat header nickname - REMOVED (should not replace nickname)
    // User requested to NOT replace .im-container-caption__info-nickname

    // Strategy 1.2: Message headers - REMOVED (should not replace names in chat messages)
    // User requested to NOT replace names in chat message headers

    // Strategy 2: Legacy phrase-based replacement (reuse BUY logic for robustness)
    try {
        if (replacePayerNameInDom(name, root)) {
            replaced = true;
        }
    } catch (e) {
        // ignore
    }

    // Strategy 3: Broader style-based match (gold + bold) over spans and divs
    // BUT: exclude payment section to avoid conflicts
    try {
        const scopeRoot = root.querySelector('.im-container-caption__info') || root;
        const styledCandidates = scopeRoot.querySelectorAll(
            '.moly-space-item span, .moly-space-item div, .moly-space span, .moly-space div, .moly-text, span[style*="font-weight"], span[style*="font-weight:"]'
        );
        styledCandidates.forEach(el => {
            try {
                // Do not touch avatar letters or anything inside avatar container
                if (el.closest('.by-avatar')) return;
                if (el.classList && el.classList.contains('by-avatar__container__letter')) return;
                
                // IMPORTANT: Do not touch payment section elements
                if (el.closest('#fiat-otc-order__payment')) return;

                const cs = window.getComputedStyle(el);
                const isBold = (parseInt(cs.fontWeight, 10) || 400) >= 600 || cs.fontWeight === 'bold' || cs.fontWeight === '600';
                const isGold = cs.color === GOLD_COLOR_RGB; // #F7A600
                if (isBold && isGold) {
                    const current = (el.textContent || '').trim();
                    if (current && current !== name) {
                        el.textContent = name;
                        replaced = true;
                    }
                }
            } catch (_) { /* noop */ }
        });
    } catch (e) {
        // ignore
    }

    return replaced;
}

// New: BUY tips-specific replacement using stable phrase "verified name"
function replaceBuyTipsName(name, root = document) {
    if (!name) return false;
    let replaced = false;
    try {
        const spansWithStyle = root.querySelectorAll('span[style]');
        spansWithStyle.forEach((span) => {
            try {
                const styleAttr = span.getAttribute('style') || '';
                // Check for gold color - support both hex and var() notation
                const isGold = /color:\s*(#F7A600|rgb\(\s*247\s*,\s*166\s*,\s*0\s*\)|var\(--bds-brand-700-normal)/i.test(styleAttr);
                const isHeavy = /font-weight\s*:\s*(600|700|bold)/i.test(styleAttr);
                if (!isGold || !isHeavy) return;

                // Check surrounding text for the stable phrase (English and Russian)
                const contextText = (span.parentElement ? span.parentElement.textContent : span.textContent) || '';
                if (/verified\s+name|верифицированному\s+имени/i.test(contextText)) {
                    if ((span.textContent || '').trim() !== name) {
                        span.textContent = name;
                    }
                    replaced = true;
                }
            } catch (_) { /* noop */ }
        });
    } catch (_) {
        // noop
    }
    return replaced;
}

// New: Replace own name in payment method details (SELL order - your payment details)
function replaceOwnNameInPaymentMethod(name, root = document) {
    if (!name) return false;
    let replaced = false;
    
    try {
        const paymentSection = root.querySelector('#fiat-otc-order__payment');
        if (!paymentSection) return false;
        
        // Find "Мой аккаунт получения" marker element
        const allElements = paymentSection.querySelectorAll('span, div');
        let myAccountMarker = null;
        
        for (const el of allElements) {
            const text = (el.textContent || '').trim();
            const normalized = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            
            // Match "My receiving account" in multiple languages
            if (/мой\s+аккаунт\s+получени|my\s+receiv.*account|my\s+account/i.test(normalized)) {
                // Check it's not a huge container (parent of everything)
                // The marker text should be relatively short (< 200 chars)
                if (text.length < 200) {
                    myAccountMarker = el;
                    console.log('P2P Analytics: Found "My Account" marker:', text, 'length:', text.length);
                    break;
                } else {
                    console.log('P2P Analytics: Skipping too long match (parent container):', text.substring(0, 50) + '...', 'length:', text.length);
                }
            }
        }
        
        if (!myAccountMarker) {
            console.log('P2P Analytics: Could not find "My Account" marker');
            // Try fallback - search for exact text content match
            for (const el of allElements) {
                const exactText = (el.textContent || '').trim();
                if (exactText === 'Мой аккаунт получения' || exactText === 'My receiving account' || exactText === 'My account') {
                    myAccountMarker = el;
                    console.log('P2P Analytics: Found marker by exact match:', exactText);
                    break;
                }
            }
        }
        
        if (!myAccountMarker) {
            console.log('P2P Analytics: Still no marker found, aborting');
            return false;
        }
        
        // Find the container that comes AFTER the marker (typically nextElementSibling or close to it)
        let searchRoot = myAccountMarker.nextElementSibling;
        
        // If direct next sibling doesn't exist, search in parent's next siblings
        if (!searchRoot) {
            let parent = myAccountMarker.parentElement;
            while (parent && parent !== paymentSection) {
                searchRoot = parent.nextElementSibling;
                if (searchRoot) break;
                parent = parent.parentElement;
            }
        }
        
        if (!searchRoot) {
            console.log('P2P Analytics: Could not find search root after marker');
            return false;
        }
        
        console.log('P2P Analytics: Searching for name fields in container after marker');
        
        // Find ALL name fields ONLY within the searchRoot (after marker)
        const allRows = searchRoot.querySelectorAll('div[style*="display: flex"]');
        
        allRows.forEach(row => {
            // Find label and value by structure
            const children = Array.from(row.children);
            if (children.length < 2) return;
            
            const labelElement = children[0];
            const valueContainer = children[1];
            
            if (!labelElement || !valueContainer) return;
            
            const labelText = (labelElement.textContent || '').trim().toLowerCase();
            const normalizedLabel = labelText.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            
            // Check if this is a name field
            const isNameField = /фамилия.*имя|full.*name|\bname\b|nombre|nome|nom|имя\s+и\s+фамилия/i.test(normalizedLabel);
            
            if (!isNameField) return;
            
            console.log('P2P Analytics: Found name field in MY ACCOUNT section');
            
            // Find value element
            let valueElement = valueContainer.querySelector('[class*="space-item-first"]');
            
            if (!valueElement) {
                // Fallback: find first div with text (no icon)
                const valueDivs = valueContainer.querySelectorAll('div');
                for (const div of valueDivs) {
                    const text = (div.textContent || '').trim();
                    if (text && text.length > 0 && !div.querySelector('i')) {
                        valueElement = div;
                        break;
                    }
                }
            }
            
            if (!valueElement) {
                console.log('P2P Analytics: Could not find value element');
                return;
            }
            
            const current = (valueElement.textContent || '').trim();
            
            // Don't replace short codes like "GG", "VIP"
            if (/^[A-Z]{2,3}$/.test(current)) {
                console.log('P2P Analytics: Skipping short code:', current);
                return;
            }
            
            // Replace if empty, placeholder, or looks like a name
            const isPlaceholder = !current || /реквизиты\s+указаны/i.test(current);
            const looksLikeName = current.length > 3 || /\s/.test(current);
            
            if (isPlaceholder || (looksLikeName && current !== name)) {
                valueElement.textContent = name;
                replaced = true;
                console.log('P2P Analytics: Replaced payment method name from', current, 'to', name);
            }
        });
    } catch (e) {
        console.warn('P2P Analytics: Failed to replace own name in payment method:', e);
    }
    
    return replaced;
}

// New: Replace counterparty name in payment method details (works for both BUY and SELL)
// For BUY orders: replaces seller's name
// For SELL orders: can also be used to replace buyer's name if needed
function replaceCounterpartyNameInPaymentMethod(name, root = document) {
    if (!name) return false;
    let replaced = false;
    
    try {
        const paymentSection = root.querySelector('#fiat-otc-order__payment');
        if (!paymentSection) return false;
        
        console.log('P2P Analytics: Searching for counterparty name fields in payment section');
        
        // Helper function to check if an element is within "My Account" section
        function isInMyAccountSection(element) {
            let current = element;
            
            // Walk up the DOM tree looking for "My Account" marker
            while (current && current !== paymentSection) {
                // Check previous siblings for "My Account" text
                let prevSibling = current.previousElementSibling;
                
                while (prevSibling) {
                    const text = (prevSibling.textContent || '').trim();
                    const normalized = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
                    
                    // If we find "My Account" marker before this element, it's in "My Account" section
                    if (/мой\s+аккаунт\s+получени|my\s+receiv.*account|my\s+account/i.test(normalized) && text.length < 200) {
                        console.log('P2P Analytics: Element is in "My Account" section - found marker:', text);
                        return true;
                    }
                    
                    prevSibling = prevSibling.previousElementSibling;
                }
                
                current = current.parentElement;
            }
            
            return false;
        }
        
        // Find all payment detail rows with label-value structure
        const allRows = paymentSection.querySelectorAll('div[style*="display: flex"]');
        
        allRows.forEach(row => {
            // IMPORTANT: Skip if this row is in "My Account" section (own payment details in SELL order)
            if (isInMyAccountSection(row)) {
                console.log('P2P Analytics: Skipping name field - it is in "My Account" section (own details)');
                return;
            }
            
            // Find label and value by structure
            const children = Array.from(row.children);
            if (children.length < 2) return;
            
            const labelElement = children[0];
            const valueContainer = children[1];
            
            if (!labelElement || !valueContainer) return;
            
            const labelText = (labelElement.textContent || '').trim().toLowerCase();
            const normalizedLabel = labelText.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            
            // Check if this is a name field - multilingual support
            const isNameField = /фамилия.*имя|full.*name|\bname\b|nombre|nome|nom|имя\s+и\s+фамилия/i.test(normalizedLabel);
            
            if (!isNameField) return;
            
            console.log('P2P Analytics: Found name field (counterparty):', labelText);
            
            // Find value element (first item in space container)
            let valueElement = valueContainer.querySelector('.moly-space-item-first, [class*="space-item-first"]');
            
            if (!valueElement) {
                // Fallback: find first div with text (excluding icons)
                const valueDivs = valueContainer.querySelectorAll('div');
                for (const div of valueDivs) {
                    const text = (div.textContent || '').trim();
                    if (text && text.length > 0 && !div.querySelector('i, svg')) {
                        valueElement = div;
                        break;
                    }
                }
            }
            
            if (!valueElement) {
                console.log('P2P Analytics: Could not find value element');
                return;
            }
            
            const current = (valueElement.textContent || '').trim();
            
            // Don't replace short codes like "GG", "VIP"
            if (/^[A-Z]{2,3}$/.test(current)) {
                console.log('P2P Analytics: Skipping short code:', current);
                return;
            }
            
            // Replace if it's a placeholder or different from target name
            const isPlaceholder = !current || /реквизиты\s+указаны|details\s+specified|detalles\s+especificados/i.test(current);
            const shouldReplace = isPlaceholder || (current.length > 0 && current !== name);
            
            if (shouldReplace) {
                valueElement.textContent = name;
                replaced = true;
                console.log('P2P Analytics: Replaced counterparty name from "' + current + '" to "' + name + '"');
            }
        });
    } catch (e) {
        console.warn('P2P Analytics: Failed to replace counterparty name in payment method:', e);
    }
    
    return replaced;
}

// Added: Detect and capture original BUY page name before any replacement
function detectOriginalBuyName(root = document) {
    let found = '';

    // Strategy A: Phrase-based container (like replacePayerNameInDom)
    try {
        const candidateContainers = root.querySelectorAll('div.moly-space-item span.moly-text, .moly-space-item .moly-text');
        for (const container of candidateContainers) {
            const text = container.textContent || '';
            const matchesPhrase = /real name of the payer/i.test(text) || /имя\s+плат[её]льщ/i.test(text);
            if (matchesPhrase) {
                const nameSpan = container.querySelector('span[style]') || container.querySelector('span:last-child');
                const candidate = (nameSpan ? nameSpan.textContent : container.textContent) || '';
                const trimmed = candidate.trim();
                if (trimmed) {
                    found = trimmed;
                    break;
                }
            }
        }
    } catch (_) { /* noop */ }

    // Strategy B: Style + context based (like replaceBuyTipsName)
    if (!found) {
        try {
            const spansWithStyle = root.querySelectorAll('span[style]');
            for (const span of spansWithStyle) {
                const styleAttr = span.getAttribute('style') || '';
                // Check for gold color - support both hex and var() notation
                const isGold = /color:\s*(#F7A600|rgb\(\s*247\s*,\s*166\s*,\s*0\s*\)|var\(--bds-brand-700-normal)/i.test(styleAttr);
                const isHeavy = /font-weight\s*:\s*(600|700|bold)/i.test(styleAttr);
                if (!isGold || !isHeavy) continue;
                const contextText = (span.parentElement ? span.parentElement.textContent : span.textContent) || '';
                // Check for both English and Russian phrases
                if (/verified\s+name|верифицированному\s+имени/i.test(contextText)) {
                    const candidate = (span.textContent || '').trim();
                    if (candidate) {
                        found = candidate;
                        break;
                    }
                }
            }
        } catch (_) { /* noop */ }
    }

    return found || '';
}

function ensureOriginalBuyNameCaptured(root = document) {
    if (!isBuyPage()) return;
    if (originalBuyName) return;
    const n = detectOriginalBuyName(root);
    if (n) {
        originalBuyName = n;
    }
}

// New: apply persistent BUY displayName only on BUY pages
function applyDisplayNameIfNeeded() {
    if (isBuyPage()) {
        ensureOriginalBuyNameCaptured();
    }
    if (currentDisplayName && isBuyPage()) {
        // First, replace explicitly in BUY tips based on stable phrase and style
        const done = replaceBuyTipsName(currentDisplayName);
        // Also run legacy container/style heuristics for wider coverage
        if (!done) {
            replacePayerNameInDom(currentDisplayName);
        } else {
            // Even if tips replaced, still try legacy pass to catch any other spot
            replacePayerNameInDom(currentDisplayName);
        }
    }
    
    // For SELL orders: replace own name in payment method details
    if (currentDisplayName && isSellPage()) {
        replaceOwnNameInPaymentMethod(currentDisplayName);
    }
}

// Function to extract order ID from URL
// IMPORTANT: orderId MUST always remain a string to preserve precision for large numbers
// Numbers like 1334714309250740224 exceed JavaScript's MAX_SAFE_INTEGER
const getOrderIdFromUrl = () => {
    const url = window.location.href;
    console.log('P2P Analytics: Extracting order ID from URL:', url);
    
    // Use regex to extract order ID from orderList URL pattern
    const orderIdMatch = url.match(/\/orderList\/(\d+)/);
    
    if (orderIdMatch && orderIdMatch[1]) {
        // Ensure orderId is always returned as a string (never as a number)
        // Regex match already returns a string, but we explicitly call String() for safety
        const orderId = String(orderIdMatch[1]);
        console.log('P2P Analytics: Extracted order ID:', orderId, 'Type:', typeof orderId);
        return orderId;
    }
    
    console.error('P2P Analytics: Could not extract valid order ID from URL:', url);
    return null;
};

// fetchBankDetails is available globally from order_api.js

// Wrapper for checkOrderExists with Bybit exchange type - override global
checkOrderExists = async (orderId) => {
    return window.P2POrderAPI.checkOrderExists(orderId, EXCHANGE_TYPE_BYBIT);
};

// saveOrder is available globally from order_api.js

// Wrapper for deleteOrder with Bybit exchange type - override global
deleteOrder = async (orderId) => {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_BYBIT);
};

// Screenshot Functions
const captureScreenshot = async () => {
    try {
        console.log('P2P Analytics: Requesting screenshot from background script...');
        
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'captureScreenshot' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('P2P Analytics: Runtime error:', chrome.runtime.lastError);
                        reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
                    } else if (response && response.success) {
                        console.log('P2P Analytics: Screenshot captured successfully');
                        resolve(response.dataUrl);
                    } else {
                        const errorMsg = response?.error || 'Failed to capture screenshot';
                        console.error('P2P Analytics: Screenshot capture failed:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                }
            );
        });
    } catch (error) {
        console.error('P2P Analytics: Error in captureScreenshot function:', error);
        throw error;
    }
};



const uploadScreenshotFromDataUrl = async (dataUrl, orderId) => {
    try {
        // Check if user is authenticated
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для загрузки скриншота');
            return {
                success: false,
                error: 'Не авторизован'
            };
        }

        // Convert dataUrl to blob
        const response = await fetch(dataUrl);
        const blob = await response.blob();

        // Use existing uploadScreenshot function from auth.js
        const result = await window.P2PAuth.uploadScreenshot(blob, `${orderId}.png`);
        
        return result;
    } catch (error) {
        console.error('Error uploading screenshot:', error);
        
        // Show error to user
        window.P2PAuth.showAuthError(error.message);
        
        return {
            success: false,
            error: error.message
        };
    }
};

const downloadScreenshot = async (dataUrl, orderId) => {
    try {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { 
                    action: 'downloadScreenshot',
                    dataUrl: dataUrl,
                    filename: `order_${orderId}_screenshot.png`
                },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.success) {
                        resolve(response.downloadId);
                    } else {
                        reject(new Error(response?.error || 'Failed to download screenshot'));
                    }
                }
            );
        });
    } catch (error) {
        console.error('Error downloading screenshot:', error);
        throw error;
    }
};

// Added: Reset BUY display name to original default and clear storage
async function resetBuyDisplayName() {
    if (!isBuyPage()) {
        alert('Сброс имени доступен только на странице покупки');
        return;
    }

    try {
        // If we do not yet have the original, try to capture now before clearing
        if (!originalBuyName) {
            originalBuyName = detectOriginalBuyName(document) || '';
        }

        await chrome.storage.sync.set({ displayName: '' });
        currentDisplayName = '';

        // Restore DOM with the original name if known
        if (originalBuyName) {
            replaceBuyTipsName(originalBuyName);
            replacePayerNameInDom(originalBuyName);
        }

        alert('Имя сброшено к исходному');
    } catch (e) {
        console.error('P2P Analytics: Failed to reset name:', e);
        alert('Не удалось сбросить имя: ' + (e?.message || e));
    }
}

// Function to parse order date and type from DOM
function parseOrderInfo() {
    const orderInfo = {};
    
    // Parse order date
    const orderDateElement = document.querySelector('.order-id-and-time .moly-space-item-first div');
    if (orderDateElement) {
        const dateText = orderDateElement.textContent.trim();
        console.log('P2P Analytics: Found order date text:', dateText);
        
        // Parse date in format "2025-07-08 21:22:36"
        const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
            const dateStr = dateMatch[1];
            // Convert to ISO format for API
            const parsedDate = new Date(dateStr);
            orderInfo.createdAt = parsedDate.toISOString();
            console.log('P2P Analytics: Parsed order date:', orderInfo.createdAt);
        } else {
            console.error('P2P Analytics: Could not parse order date from text:', dateText);
        }
    } else {
        console.error('P2P Analytics: Order date element not found');
    }
    
    // Parse order type (BUY or SELL)
    const summaryItemElement = document.querySelector('.summary-item-value.pay');
    if (summaryItemElement) {
        const classList = summaryItemElement.classList;
        console.log('P2P Analytics: Found summary item classes:', Array.from(classList));
        
        if (classList.contains('sell')) {
            orderInfo.type = 'SELL';
        } else if (classList.contains('buy')) {
            orderInfo.type = 'BUY';
        } else {
            console.error('P2P Analytics: Could not determine order type, classes:', Array.from(classList));
        }
        
        console.log('P2P Analytics: Parsed order type:', orderInfo.type);
    } else {
        console.error('P2P Analytics: Summary item element not found');
    }
    
    return orderInfo;
}

// parseNumberOrNull is available globally from order_api.js

// Function to collect form data
function collectFormData() {
    const formData = {};
    
    // Get selected bank
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    const selectedBankId = bankButton ? bankButton.getAttribute('data-bank-id') : null;
    
    formData.bank = bankButton ? bankButton.textContent : null;
    formData.bankId = selectedBankId ? parseInt(selectedBankId) : null;
    
    // Get commission data
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    formData.commission = commissionInput ? parseFloat(commissionInput.value) : null;
    formData.commissionType = commissionType ? commissionType.getAttribute('data-commission-type') || COMMISSION_TYPE_PERCENT : COMMISSION_TYPE_PERCENT;
    
    console.log('P2P Analytics: Commission type collected:', formData.commissionType);
    
    // Always take screenshot on submit
    formData.screenshot = true;
    
    // Get receipt checkbox and related data
    const receiptCheckbox = document.querySelector('#check-checkbox');
    // IMPORTANT: Read checked state even if checkbox is disabled
    // This allows updating receipts for existing orders
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    console.log('P2P Analytics: Receipt checkbox found:', !!receiptCheckbox);
    console.log('P2P Analytics: Receipt checkbox checked:', receiptCheckbox?.checked);
    console.log('P2P Analytics: Receipt checkbox disabled:', receiptCheckbox?.disabled);
    console.log('P2P Analytics: formData.hasReceipt:', formData.hasReceipt);
    
    // Debug: log checkbox element state
    if (receiptCheckbox) {
        console.log('P2P Analytics: Checkbox element:', {
            id: receiptCheckbox.id,
            checked: receiptCheckbox.checked,
            disabled: receiptCheckbox.disabled,
            classList: Array.from(receiptCheckbox.classList)
        });
    }
    
    if (formData.hasReceipt) {
        const contactInput = document.querySelector('#contact-input');
        const rateInput = document.querySelector('#rate-input');
        const quantityInput = document.querySelector('#quantity-input');
        const costInput = document.querySelector('#cost-input');
        
        console.log('P2P Analytics: Receipt input elements found:', {
            contact: !!contactInput,
            rate: !!rateInput,
            quantity: !!quantityInput,
            cost: !!costInput
        });
        
        console.log('P2P Analytics: Receipt input values (raw):', {
            contact: contactInput?.value,
            rate: rateInput?.value,
            quantity: quantityInput?.value,
            cost: costInput?.value
        });
        
        console.log('P2P Analytics: Receipt input states:', {
            contactDisabled: contactInput?.disabled,
            rateDisabled: rateInput?.disabled,
            quantityDisabled: quantityInput?.disabled,
            costDisabled: costInput?.disabled,
            contactReadOnly: contactInput?.readOnly,
            rateReadOnly: rateInput?.readOnly,
            quantityReadOnly: quantityInput?.readOnly,
            costReadOnly: costInput?.readOnly
        });
        
        // Read values from inputs (works even if disabled/readonly)
        const contactValue = contactInput?.value?.trim() || '';
        const rateValue = rateInput?.value?.trim() || '';
        const quantityValue = quantityInput?.value?.trim() || '';
        const costValue = costInput?.value?.trim() || '';
        
        console.log('P2P Analytics: Receipt trimmed values:', {
            contact: contactValue,
            rate: rateValue,
            quantity: quantityValue,
            cost: costValue
        });
        
        const receiptData = {
            contact: contactValue,
            price: parseNumberOrNull(rateValue),
            amount: parseNumberOrNull(quantityValue),
            sum: parseNumberOrNull(costValue),
        };
        
        console.log('P2P Analytics: Parsed receipt data:', receiptData);
        
        // Only set receipt if at least one field has a valid value
        const hasValidData = receiptData.contact || 
                            receiptData.price !== null || 
                            receiptData.amount !== null || 
                            receiptData.sum !== null;
        
        console.log('P2P Analytics: Receipt has valid data:', hasValidData);
        
        if (hasValidData) {
            formData.receipt = receiptData;
            console.log('P2P Analytics: ✓ Receipt data is VALID, will be sent:', receiptData);
        } else {
            formData.receipt = null;
            console.warn('P2P Analytics: ✗ Receipt checkbox checked but NO VALID data found in fields!');
            console.warn('P2P Analytics: This might happen if inputs are empty or values cannot be parsed');
        }
    } else {
        console.log('P2P Analytics: Receipt checkbox NOT checked, skipping receipt data');
        formData.receipt = null;
    }
    
    // Parse order info from DOM
    const orderInfo = parseOrderInfo();
    formData.createdAt = orderInfo.createdAt;
    formData.type = orderInfo.type;
    
    console.log('P2P Analytics: ====== FINAL FORM DATA ======');
    console.log('P2P Analytics: Bank:', formData.bank, '(ID:', formData.bankId + ')');
    console.log('P2P Analytics: Commission:', formData.commission, formData.commissionType);
    console.log('P2P Analytics: Has Receipt:', formData.hasReceipt);
    console.log('P2P Analytics: Receipt data:', formData.receipt);
    console.log('P2P Analytics: Order type:', formData.type);
    console.log('P2P Analytics: Created at:', formData.createdAt);
    console.log('P2P Analytics: =========================');
    
    return formData;
}

// Function to handle form submission
async function handleFormSubmission() {
    const formData = collectFormData();
    
    // Validate required fields
    if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
        alert('Пожалуйста, выберите банк');
        return;
    }
    
    if (!formData.createdAt) {
        alert('Не удалось определить дату создания заказа. Проверьте, что вы находитесь на правильной странице заказа.');
        return;
    }
    
    if (!formData.type) {
        alert('Не удалось определить тип заказа (покупка/продажа). Проверьте, что вы находитесь на правильной странице заказа.');
        return;
    }
    
    // Get order ID from URL
    const orderId = getOrderIdFromUrl();
    if (!orderId) {
        alert('Не удалось получить ID заказа из URL страницы');
        return;
    }

    // Check if user is authenticated
    const isAuth = await window.P2PAuth.isAuthenticated();
    if (!isAuth) {
        window.P2PAuth.showAuthError('Необходимо авторизоваться для отправки заказа');
        return;
    }

    // Show loading state
    const submitButton = document.querySelector('.p2p-analytics-submit-button');
    const originalText = submitButton.textContent;
    submitButton.textContent = 'Отправка...';
    submitButton.disabled = true;
    
    let screenshotDataUrl = null;
    
    try {
        // Always capture screenshot
        submitButton.textContent = 'Создание скриншота...';
        console.log('P2P Analytics: Capturing screenshot...');
        
        try {
            screenshotDataUrl = await captureScreenshot();
            console.log('P2P Analytics: Screenshot captured successfully');
        } catch (error) {
            console.error('P2P Analytics: Error capturing screenshot:', error);
            alert(`Ошибка при создании скриншота: ${error.message}\n\nВозможные причины:\n- Расширение не имеет нужных разрешений\n- Попробуйте перезагрузить расширение в chrome://extensions/`);
            return;
        }

        // Check if order already exists and has a receipt
        let existingReceipt = null;
        try {
            const existingOrderResult = await checkOrderExists(orderId);
            console.log('P2P Analytics: Existing order check result:', existingOrderResult);
            if (existingOrderResult.success && existingOrderResult.exists && existingOrderResult.data && existingOrderResult.data.receipt) {
                existingReceipt = existingOrderResult.data.receipt;
                console.log('P2P Analytics: Order already has a receipt, will not create a new one:', existingReceipt);
            } else {
                console.log('P2P Analytics: Order does not have an existing receipt or does not exist');
            }
        } catch (error) {
            console.warn('P2P Analytics: Could not check existing order receipt:', error);
        }

            console.log('P2P Analytics: formData.hasReceipt:', formData.hasReceipt);
            console.log('P2P Analytics: formData.receipt:', formData.receipt);
            console.log('P2P Analytics: existingReceipt:', existingReceipt);
            
            let receiptValue = null;
            if (formData.hasReceipt && formData.receipt) {
                receiptValue = formData.receipt;
                console.log('P2P Analytics: Using NEW receipt from form');
            } else if (existingReceipt) {
                receiptValue = existingReceipt;
                console.log('P2P Analytics: Using EXISTING receipt');
            } else {
                console.log('P2P Analytics: No receipt will be sent (null)');
            }
            
            // Prepare order data (userId автоматически из JWT токена)
            // IMPORTANT: Keep orderId as string to preserve precision for large numbers
            const orderData = {
                orderId: String(orderId), // Explicitly convert to string to prevent precision loss
                details: { id: formData.bankId },
                commission: formData.commission,
                commissionType: formData.commissionType,
                screenshotName: `${orderId}.png`, // Template literal keeps it as string
                receipt: receiptValue,
                createdAt: formData.createdAt,
                type: formData.type,
                exchangeType: EXCHANGE_TYPE_BYBIT // Bybit
            };
        
        console.log('P2P Analytics: Order data prepared:', orderData);
        console.log('P2P Analytics: Receipt in orderData:', orderData.receipt);
        
        // Save order
        submitButton.textContent = 'Сохранение заказа...';
        const result = await saveOrder(orderData);
        
        if (!result.success) {
            alert(`Ошибка при сохранении заказа: ${result.error}`);
            console.error('Error saving order:', result.error);
            return;
        }
        
        console.log('Order saved successfully:', result);
        
        // Upload screenshot
        submitButton.textContent = 'Загрузка скриншота...';
        console.log('Uploading screenshot...');
        
        try {
            const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
            if (uploadResult.success) {
                console.log('Screenshot uploaded successfully');
            } else {
                console.error('Error uploading screenshot:', uploadResult.error);
                alert(`Заказ сохранен, но произошла ошибка при загрузке скриншота: ${uploadResult.error}`);
            }
        } catch (error) {
            console.error('Error uploading screenshot:', error);
            alert(`Заказ сохранен, но произошла ошибка при загрузке скриншота: ${error.message}`);
        }
        
        // Show success message
        const successMessage = `Ордер успешно сохранен! ID: ${result.orderId}. Скриншот отправлен на сервер.`;
        alert(successMessage);
        
        // Show delete button
        const deleteButton = document.querySelector('.p2p-analytics-delete-button');
        if (deleteButton) {
            deleteButton.style.display = 'block';
        }
        
    } catch (error) {
        console.error('Unexpected error in form submission:', error);
        alert(`Произошла неожиданная ошибка: ${error.message}`);
    } finally {
        submitButton.textContent = originalText;
        submitButton.disabled = false;
    }
}

// Function to reset form
function resetForm() {
    // Reset bank selection
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    if (bankButton) {
        bankButton.textContent = 'Выберите банк';
        bankButton.removeAttribute('data-bank-id');
    }
    
    // Reset commission input
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    if (commissionInput) {
        commissionInput.value = '';
        commissionInput.placeholder = 'Введите комиссию';
    }
    
    // Reset commission type to default
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    if (commissionType) {
        commissionType.textContent = '%';
        commissionType.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
    }
    
    // No screenshot checkbox to reset (always on)
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    if (receiptCheckbox) {
        receiptCheckbox.checked = false;
        receiptCheckbox.dispatchEvent(new Event('change'));
    }
    
    const receiptInputs = document.querySelectorAll('#contact-input, #rate-input, #quantity-input, #cost-input');
    receiptInputs.forEach(input => {
        if (input) input.value = '';
    });
}

async function createDropdownMenu() {
    console.log('P2P Analytics: Creating dropdown menu...');
    
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'p2p-analytics-dropdown-container';

    // Create unified form section (all elements including submit button)
    console.log('P2P Analytics: Creating unified form section...');
    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics: Dropdown menu created successfully');
    return dropdownContainer;
}

async function createUnifiedFormSection() {
    const formSection = document.createElement('div');
    formSection.className = 'p2p-analytics-form-section';

    // Add submit button at the very top
    formSection.appendChild(createSubmitButton());

    // Add delete order button below submit
    const deleteButton = createDeleteOrderButton();
    formSection.appendChild(deleteButton);

    // Add requisites title
    const requisitesTitle = document.createElement('h3');
    requisitesTitle.className = 'p2p-analytics-form-title';
    requisitesTitle.textContent = 'Реквизиты';
    formSection.appendChild(requisitesTitle);

    // Create a wrapper for the button and its menu
    const buttonMenuWrapper = document.createElement('div');
    buttonMenuWrapper.style.position = 'relative';
    buttonMenuWrapper.style.width = '100%';

    const dropdownButton = document.createElement('button');
    dropdownButton.className = 'p2p-analytics-button';
    
    const buttonTextSpan = document.createElement('span');
    buttonTextSpan.className = 'p2p-analytics-button-text';
    buttonTextSpan.textContent = 'Загрузка...';

    const dropdownArrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dropdownArrowSvg.setAttribute('width', '12');
    dropdownArrowSvg.setAttribute('height', '12');
    dropdownArrowSvg.setAttribute('viewBox', '0 0 12 12');
    dropdownArrowSvg.setAttribute('fill', 'currentColor');
    dropdownArrowSvg.style.marginLeft = '8px';
    dropdownArrowSvg.innerHTML = '<path d="M2.94141 4.41645C3.13999 4.21787 3.47075 4.21787 3.66934 4.41645L6.00007 6.74719L8.3308 4.41645C8.52938 4.21787 8.86014 4.21787 9.05873 4.41645C9.25731 4.61504 9.25731 4.9458 9.05873 5.14438L6.39206 7.81105C6.19348 8.00963 5.86272 8.00963 5.66413 7.81105L2.94141 5.14438C2.74283 4.9458 2.74283 4.61504 2.94141 4.41645Z"></path>';

    dropdownButton.appendChild(buttonTextSpan);
    dropdownButton.appendChild(dropdownArrowSvg);

    const dropdownMenu = document.createElement('div');
    dropdownMenu.className = 'p2p-analytics-menu';
    dropdownMenu.style.display = 'none';

    // Fetch bank details from API (userId автоматически из JWT токена)
    console.log('P2P Analytics: Fetching bank details...');
    const bankDetailsResult = await fetchBankDetails();
    console.log('P2P Analytics: Bank details result:', bankDetailsResult);
    
    if (bankDetailsResult.success && bankDetailsResult.data.length > 0) {
        buttonTextSpan.textContent = 'Выберите банк';
        console.log('P2P Analytics: Bank details loaded successfully, count:', bankDetailsResult.data.length);
        
        bankDetailsResult.data.forEach(bankDetail => {
            const menuItemElement = document.createElement('div');
            menuItemElement.className = 'p2p-analytics-menu-item';
            menuItemElement.textContent = bankDetail.name;
            menuItemElement.setAttribute('data-bank-id', bankDetail.id);
            menuItemElement.onclick = (e) => {
                e.stopPropagation();
                buttonTextSpan.textContent = bankDetail.name;
                buttonTextSpan.setAttribute('data-bank-id', bankDetail.id);
                console.log(`${bankDetail.name} (ID: ${bankDetail.id}) selected`);
                dropdownMenu.style.display = 'none';
                dropdownButton.classList.remove('p2p-analytics-button-active');
            };
            dropdownMenu.appendChild(menuItemElement);
        });
    } else {
        buttonTextSpan.textContent = 'Ошибка загрузки банков';
        console.error('P2P Analytics: Failed to load bank details:', bankDetailsResult.error);
        
        const errorItem = document.createElement('div');
        errorItem.className = 'p2p-analytics-menu-item';
        errorItem.textContent = 'Не удалось загрузить список банков';
        errorItem.style.color = '#ff6b6b';
        errorItem.style.cursor = 'default';
        dropdownMenu.appendChild(errorItem);
    }

    // Append button and menu to their dedicated wrapper
    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);

    // Add the bank dropdown to form section
    formSection.appendChild(buttonMenuWrapper);

    // Add commission input with dropdown to form section
    const commissionInputWrapper = createCommissionInput();
    formSection.appendChild(commissionInputWrapper);
    
    // Pre-populate details and commission if order exists
    const orderId = getOrderIdFromUrl();
    if (orderId) {
        checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                console.log('P2P Analytics: Order exists, pre-populating form fields:', order);
                
                // Pre-populate details (requisites)
                if (order.details) {
                    const details = order.details;
                    console.log('P2P Analytics: Order has details:', details);
                    
                    // Find the matching bank detail by ID to get the name
                    const matchingBankDetail = bankDetailsResult.data?.find(bd => bd.id === details.id);
                    if (matchingBankDetail) {
                        buttonTextSpan.textContent = matchingBankDetail.name;
                        buttonTextSpan.setAttribute('data-bank-id', details.id);
                        console.log('P2P Analytics: Pre-populated details dropdown with:', matchingBankDetail.name, '(ID:', details.id, ')');
                    } else {
                        // If details.id doesn't match any bank detail, use the details data if it has a name property
                        // Otherwise just set the ID
                        if (details.name) {
                            buttonTextSpan.textContent = details.name;
                            buttonTextSpan.setAttribute('data-bank-id', details.id);
                            console.log('P2P Analytics: Pre-populated details dropdown with details.name:', details.name, '(ID:', details.id, ')');
                        } else {
                            buttonTextSpan.setAttribute('data-bank-id', details.id);
                            console.log('P2P Analytics: Set details ID but name not found:', details.id);
                        }
                    }
                }
                
                // Pre-populate commission value
                if (order.commission !== null && order.commission !== undefined) {
                    const commissionInput = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (commissionInput) {
                        commissionInput.value = order.commission;
                        console.log('P2P Analytics: Pre-populated commission value:', order.commission);
                    }
                }
                
                // Pre-populate commission type
                if (order.commissionType) {
                    const commissionTypeButton = commissionInputWrapper.querySelector('.p2p-analytics-suffix-text');
                    const commissionInput = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (commissionTypeButton) {
                        if (order.commissionType === COMMISSION_TYPE_MONEY) {
                            commissionTypeButton.textContent = '₽';
                            commissionTypeButton.setAttribute('data-commission-type', COMMISSION_TYPE_MONEY);
                            if (commissionInput) {
                                commissionInput.placeholder = 'Введите сумму в рублях';
                            }
                        } else {
                            commissionTypeButton.textContent = '%';
                            commissionTypeButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
                            if (commissionInput) {
                                commissionInput.placeholder = 'Введите процент';
                            }
                        }
                        console.log('P2P Analytics: Pre-populated commission type:', order.commissionType);
                    }
                }
            } else {
                console.log('P2P Analytics: Order does not exist or has no data');
            }
        }).catch(error => {
            console.error('P2P Analytics: Error checking order for form pre-population:', error);
        });
    }

    // Add separator before optional features
    const separator = createSeparator();
    formSection.appendChild(separator);

    // Screenshot checkbox removed (always capture)

    // Add check section content (without wrapper)
    const checkContent = createCheckContent();
    formSection.appendChild(checkContent);

    // Add event listeners for bank dropdown
    dropdownButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const isHidden = dropdownMenu.style.display === 'none';
        dropdownMenu.style.display = isHidden ? 'block' : 'none';
        dropdownButton.classList.toggle('p2p-analytics-button-active', isHidden);
    });

    document.addEventListener('click', (event) => {
        if (!formSection.contains(event.target) && dropdownMenu.style.display === 'block') {
            dropdownMenu.style.display = 'none';
            dropdownButton.classList.remove('p2p-analytics-button-active');
        }
    });

    return formSection;
}

function createCommissionInput() {
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'p2p-analytics-input-wrapper';

    const label = document.createElement('label');
    label.className = 'p2p-analytics-label';
    label.textContent = 'Комиссия';

    // Create input group container (input with integrated dropdown)
    const inputGroup = document.createElement('div');
    inputGroup.className = 'p2p-analytics-input-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'p2p-analytics-input p2p-analytics-commission-input';
    input.placeholder = 'Введите комиссию';

    // Create dropdown wrapper for the suffix
    const suffixWrapper = document.createElement('div');
    suffixWrapper.className = 'p2p-analytics-input-suffix';
    suffixWrapper.style.position = 'relative';

    const dropdownButton = document.createElement('button');
    dropdownButton.className = 'p2p-analytics-suffix-button';
    dropdownButton.type = 'button';
    
    const buttonTextSpan = document.createElement('span');
    buttonTextSpan.className = 'p2p-analytics-suffix-text';
    buttonTextSpan.textContent = '%';
    buttonTextSpan.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT); // Default to percent

    const dropdownArrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dropdownArrowSvg.setAttribute('width', '10');
    dropdownArrowSvg.setAttribute('height', '10');
    dropdownArrowSvg.setAttribute('viewBox', '0 0 12 12');
    dropdownArrowSvg.setAttribute('fill', 'currentColor');
    dropdownArrowSvg.style.marginLeft = '4px';
    dropdownArrowSvg.innerHTML = '<path d="M2.94141 4.41645C3.13999 4.21787 3.47075 4.21787 3.66934 4.41645L6.00007 6.74719L8.3308 4.41645C8.52938 4.21787 8.86014 4.21787 9.05873 4.41645C9.25731 4.61504 9.25731 4.9458 9.05873 5.14438L6.39206 7.81105C6.19348 8.00963 5.86272 8.00963 5.66413 7.81105L2.94141 5.14438C2.74283 4.9458 2.74283 4.61504 2.94141 4.41645Z"></path>';

    dropdownButton.appendChild(buttonTextSpan);
    dropdownButton.appendChild(dropdownArrowSvg);

    const dropdownMenu = document.createElement('div');
    dropdownMenu.className = 'p2p-analytics-suffix-menu';
    dropdownMenu.style.display = 'none';

    const commissionTypes = [
        { value: COMMISSION_TYPE_PERCENT, label: '%' },
        { value: COMMISSION_TYPE_MONEY, label: '₽' }
    ];

    commissionTypes.forEach(type => {
        const menuItemElement = document.createElement('div');
        menuItemElement.className = 'p2p-analytics-menu-item';
        menuItemElement.textContent = type.label;
        menuItemElement.onclick = (e) => {
            e.stopPropagation();
            buttonTextSpan.textContent = type.label;
            buttonTextSpan.setAttribute('data-commission-type', type.value); // Save API value
            
            // Update input placeholder based on selection
            if (type.value === COMMISSION_TYPE_MONEY) {
                input.placeholder = 'Введите сумму в рублях';
            } else {
                input.placeholder = 'Введите процент';
            }
            
            console.log(`${type.label} selected (${type.value})`);
            dropdownMenu.style.display = 'none';
            dropdownButton.classList.remove('p2p-analytics-suffix-button-active');
        };
        dropdownMenu.appendChild(menuItemElement);
    });

    suffixWrapper.appendChild(dropdownButton);
    suffixWrapper.appendChild(dropdownMenu);

    inputGroup.appendChild(input);
    inputGroup.appendChild(suffixWrapper);

    inputWrapper.appendChild(label);
    inputWrapper.appendChild(inputGroup);

    // Add event listeners for suffix dropdown
    dropdownButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const isHidden = dropdownMenu.style.display === 'none';
        dropdownMenu.style.display = isHidden ? 'block' : 'none';
        dropdownButton.classList.toggle('p2p-analytics-suffix-button-active', isHidden);
        
        // Update input group styling
        if (isHidden) {
            inputGroup.classList.add('p2p-analytics-input-group-active');
        } else {
            inputGroup.classList.remove('p2p-analytics-input-group-active');
        }
    });

    document.addEventListener('click', (event) => {
        if (!inputWrapper.contains(event.target) && dropdownMenu.style.display === 'block') {
            dropdownMenu.style.display = 'none';
            dropdownButton.classList.remove('p2p-analytics-suffix-button-active');
            inputGroup.classList.remove('p2p-analytics-input-group-active');
        }
    });

    return inputWrapper;
}

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'p2p-analytics-separator';
    return separator;
}

function createScreenshotCheckbox() {
    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'p2p-analytics-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'p2p-analytics-checkbox';
    checkbox.id = 'screenshot-checkbox';
    checkbox.checked = true; // Включен по умолчанию

    const label = document.createElement('label');
    label.className = 'p2p-analytics-checkbox-label';
    label.htmlFor = 'screenshot-checkbox';
    label.textContent = 'Скриншот';

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    return checkboxWrapper;
}

// generateRandomGmail, truncateToDecimals, extractNumber
// are all available globally from order_api.js

// Helper function to parse price from page (both buy and sell orders)
// Multiple strategies for reliability
function parsePriceFromPage() {
    try {
        console.log('P2P Analytics: Parsing price from page...');
        
        // Strategy 1: Find by title text (multilingual support)
        const summaryItems = document.querySelectorAll('.summary-item');
        for (const item of summaryItems) {
            const title = item.querySelector('.summary-item-title');
            const value = item.querySelector('.summary-item-value');
            
            if (title && value) {
                const titleText = title.textContent.trim().toLowerCase();
                // Support multiple languages: Price, Цена, Precio, etc.
                if (titleText === 'price' || titleText === 'цена' || titleText === 'precio' || titleText === 'prix') {
                    const priceText = value.textContent.trim();
                    console.log('P2P Analytics: Found price by title:', priceText);
                    const price = extractNumber(priceText);
                    if (price !== null) {
                        return truncateToDecimals(price, 2).toString();
                    }
                }
            }
        }
        
        // Strategy 2: Find by class and content pattern
        // Look for smaller RUB amount (price is usually smaller than total amount)
        const allValues = document.querySelectorAll('.summary-item-value');
        const rubValues = [];
        
        for (const value of allValues) {
            const text = value.textContent.trim();
            if (/RUB|₽|RUR/i.test(text) && !/USDT|BTC|ETH/i.test(text)) {
                const num = extractNumber(text);
                if (num !== null) {
                    rubValues.push({ element: value, number: num, text: text });
                }
            }
        }
        
        // Sort by number value - price is usually the smaller one
        if (rubValues.length > 0) {
            rubValues.sort((a, b) => a.number - b.number);
            console.log('P2P Analytics: Found price by RUB pattern:', rubValues[0].text);
            return truncateToDecimals(rubValues[0].number, 2).toString();
        }
        
        // Strategy 3: Find by position (second summary item is often price)
        if (summaryItems.length >= 2) {
            const secondItem = summaryItems[1];
            const value = secondItem.querySelector('.summary-item-value');
            if (value) {
                const text = value.textContent.trim();
                const num = extractNumber(text);
                if (num !== null) {
                    console.log('P2P Analytics: Found price by position:', text);
                    return truncateToDecimals(num, 2).toString();
                }
            }
        }
        
        console.warn('P2P Analytics: Could not find price on page');
        return '';
    } catch (error) {
        console.error('P2P Analytics: Error parsing price:', error);
        return '';
    }
}

// Helper function to parse quantity from page
// Multiple strategies for reliability
function parseQuantityFromPage() {
    try {
        console.log('P2P Analytics: Parsing quantity from page...');
        
        // Strategy 1: Find by title text (multilingual)
        const summaryItems = document.querySelectorAll('.summary-item');
        for (const item of summaryItems) {
            const title = item.querySelector('.summary-item-title');
            const value = item.querySelector('.summary-item-value');
            
            if (title && value) {
                const titleText = title.textContent.trim().toLowerCase();
                // Support multiple languages
                if (titleText.includes('quantity') || titleText.includes('количество') || 
                    titleText.includes('cantidad') || titleText.includes('quantité')) {
                    const quantityText = value.textContent.trim();
                    console.log('P2P Analytics: Found quantity by title:', quantityText);
                    const quantity = extractNumber(quantityText);
                    if (quantity !== null) {
                        return truncateToDecimals(quantity, 3).toString();
                    }
                }
            }
        }
        
        // Strategy 2: Find by crypto currency pattern (USDT, BTC, etc.)
        const allValues = document.querySelectorAll('.summary-item-value');
        for (const value of allValues) {
            const text = value.textContent.trim();
            // Look for crypto currencies
            if (/USDT|BTC|ETH|USDC|DAI/i.test(text)) {
                const quantity = extractNumber(text);
                if (quantity !== null) {
                    console.log('P2P Analytics: Found quantity by crypto pattern:', text);
                    return truncateToDecimals(quantity, 3).toString();
                }
            }
        }
        
        // Strategy 3: Find by position (third summary item is often quantity)
        if (summaryItems.length >= 3) {
            const thirdItem = summaryItems[2];
            const value = thirdItem.querySelector('.summary-item-value');
            if (value) {
                const text = value.textContent.trim();
                const num = extractNumber(text);
                if (num !== null) {
                    console.log('P2P Analytics: Found quantity by position:', text);
                    return truncateToDecimals(num, 3).toString();
                }
            }
        }
        
        console.warn('P2P Analytics: Could not find quantity on page');
        return '';
    } catch (error) {
        console.error('P2P Analytics: Error parsing quantity:', error);
        return '';
    }
}

// Helper function to parse amount from page
// Multiple strategies for reliability
function parseAmountFromPage() {
    try {
        console.log('P2P Analytics: Parsing amount from page...');
        
        // Strategy 1: Find by title text (multilingual)
        const summaryItems = document.querySelectorAll('.summary-item');
        for (const item of summaryItems) {
            const title = item.querySelector('.summary-item-title');
            const value = item.querySelector('.summary-item-value');
            
            if (title && value) {
                const titleText = title.textContent.trim().toLowerCase();
                // Support multiple languages: Receive, Получить, Pay, Платить
                if (titleText === 'receive' || titleText === 'получить' || titleText === 'recibir' ||
                    titleText === 'pay' || titleText === 'платить' || titleText === 'pagar') {
                    const amountText = value.textContent.trim();
                    console.log('P2P Analytics: Found amount by title:', amountText);
                    const amount = extractNumber(amountText);
                    if (amount !== null) {
                        return truncateToDecimals(amount, 2).toString();
                    }
                }
            }
        }
        
        // Strategy 2: Find by .pay class (this element usually has the total amount)
        const payValue = document.querySelector('.summary-item-value.pay');
        if (payValue) {
            const text = payValue.textContent.trim();
            console.log('P2P Analytics: Found amount by .pay class:', text);
            const amount = extractNumber(text);
            if (amount !== null) {
                return truncateToDecimals(amount, 2).toString();
            }
        }
        
        // Strategy 3: Find largest RUB amount (total is usually the largest)
        const allValues = document.querySelectorAll('.summary-item-value');
        const rubValues = [];
        
        for (const value of allValues) {
            const text = value.textContent.trim();
            if (/RUB|₽|RUR/i.test(text) && !/USDT|BTC|ETH/i.test(text)) {
                const num = extractNumber(text);
                if (num !== null) {
                    rubValues.push({ element: value, number: num, text: text });
                }
            }
        }
        
        // Sort by number value - amount is usually the larger one
        if (rubValues.length > 0) {
            rubValues.sort((a, b) => b.number - a.number);
            console.log('P2P Analytics: Found amount by largest RUB:', rubValues[0].text);
            return truncateToDecimals(rubValues[0].number, 2).toString();
        }
        
        // Strategy 4: Find by position (first summary item is often amount)
        if (summaryItems.length >= 1) {
            const firstItem = summaryItems[0];
            const value = firstItem.querySelector('.summary-item-value');
            if (value) {
                const text = value.textContent.trim();
                const num = extractNumber(text);
                if (num !== null) {
                    console.log('P2P Analytics: Found amount by position:', text);
                    return truncateToDecimals(num, 2).toString();
                }
            }
        }
        
        console.warn('P2P Analytics: Could not find amount on page');
        return '';
    } catch (error) {
        console.error('P2P Analytics: Error parsing amount:', error);
        return '';
    }
}

// checkEvotorCredentials is available globally from order_api.js

// Helper function to wait for summary items to be available and fill receipt inputs
// Returns true if all fields were filled successfully
function waitAndFillReceiptInputs(rateInput, quantityInput, costInput, maxRetries = 10, delay = 500) {
    let retryCount = 0;
    
    function tryFill() {
        // Check if summary items exist in DOM
        const summaryItems = document.querySelectorAll('.summary-item');
        const hasSummaryItems = summaryItems.length >= 3;
        
        console.log('P2P Analytics: Attempting to fill receipt inputs, retry:', retryCount, 'summary items found:', summaryItems.length);
        
        // Try to parse values
        const rateValue = parsePriceFromPage();
        const quantityValue = parseQuantityFromPage();
        const costValue = parseAmountFromPage();
        
        console.log('P2P Analytics: Parsed values - rate:', rateValue, 'quantity:', quantityValue, 'cost:', costValue);
        
        // Check if we got valid values
        const hasValidData = rateValue || quantityValue || costValue;
        
        if (hasValidData) {
            // Fill the inputs
            if (rateInput && rateValue) {
                rateInput.value = rateValue;
                console.log('P2P Analytics: Rate filled:', rateValue);
            }
            if (quantityInput && quantityValue) {
                quantityInput.value = quantityValue;
                console.log('P2P Analytics: Quantity filled:', quantityValue);
            }
            if (costInput && costValue) {
                costInput.value = costValue;
                console.log('P2P Analytics: Cost filled:', costValue);
            }
            return true;
        }
        
        // If no valid data and we haven't exceeded retries, try again
        retryCount++;
        if (retryCount < maxRetries) {
            console.log('P2P Analytics: No valid data found, retrying in', delay, 'ms...');
            setTimeout(tryFill, delay);
            return false;
        }
        
        console.warn('P2P Analytics: Max retries exceeded, could not fill receipt inputs');
        return false;
    }
    
    // Start the first attempt
    tryFill();
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

    // Main checkbox
    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'p2p-analytics-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'p2p-analytics-checkbox';
    checkbox.id = 'check-checkbox';

    const label = document.createElement('label');
    label.className = 'p2p-analytics-checkbox-label';
    label.htmlFor = 'check-checkbox';
    label.textContent = 'Чек';

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    // Warning message for missing evotor credentials
    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.display = 'none';
    warningMessage.textContent = 'Чтобы пробить чек, заполните анкету';

    // Success message for existing receipt
    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.display = 'none';
    successMessage.textContent = 'Чек пробит';

    // Conditional inputs container
    const conditionalInputs = document.createElement('div');
    conditionalInputs.className = 'p2p-analytics-conditional-inputs';
    conditionalInputs.style.display = 'none';

    // Create inputs and store references
    const contactInputWrapper = createInput('Контакт', 'contact-input', 'Введите контакт');
    const contactInput = contactInputWrapper.querySelector('#contact-input');
    conditionalInputs.appendChild(contactInputWrapper);

    const rateInputWrapper = createInput('Курс', 'rate-input', 'Введите курс');
    const rateInput = rateInputWrapper.querySelector('#rate-input');
    conditionalInputs.appendChild(rateInputWrapper);

    const quantityInputWrapper = createInput('Количество', 'quantity-input', 'Введите количество');
    const quantityInput = quantityInputWrapper.querySelector('#quantity-input');
    conditionalInputs.appendChild(quantityInputWrapper);

    const costInputWrapper = createInput('Стоимость', 'cost-input', 'Введите стоимость');
    const costInput = costInputWrapper.querySelector('#cost-input');
    conditionalInputs.appendChild(costInputWrapper);

    checkContent.appendChild(checkboxWrapper);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    // Flag to track if receipt already exists
    let receiptExists = false;

    // Check both order receipt and evotor credentials
    const orderId = getOrderIdFromUrl();
    const orderCheckPromise = orderId 
        ? checkOrderExists(orderId).catch(error => {
            console.error('P2P Analytics: Error checking order receipt:', error);
            return { success: false, exists: false };
        })
        : Promise.resolve({ success: false, exists: false });
    
    const credentialsCheckPromise = checkEvotorCredentials().catch(error => {
        console.error('P2P Analytics: Error checking evotor credentials:', error);
        return false;
    });

    // Wait for both checks to complete
    Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
        // Check if receipt exists
        if (orderResult.success && orderResult.exists && orderResult.data && orderResult.data.receipt) {
            // Receipt exists - mark checkbox as checked and show success message
            receiptExists = true;
            checkbox.checked = true;
            checkbox.disabled = true; // Disable checkbox since receipt is already created
            checkbox.classList.add('p2p-analytics-checkbox-disabled');
            successMessage.style.display = 'block';
            
            // Show receipt data in readonly inputs
            conditionalInputs.style.display = 'block';
            
            const receipt = orderResult.data.receipt;
            
            // Fill and disable contact input
            if (contactInput && receipt.contact) {
                contactInput.value = receipt.contact;
                contactInput.readOnly = true;
                contactInput.disabled = true;
                contactInput.classList.add('p2p-analytics-input-readonly');
            }
            
            // Fill and disable rate input
            if (rateInput && receipt.price !== null && receipt.price !== undefined) {
                rateInput.value = receipt.price;
                rateInput.readOnly = true;
                rateInput.disabled = true;
                rateInput.classList.add('p2p-analytics-input-readonly');
            }
            
            // Fill and disable quantity input
            if (quantityInput && receipt.amount !== null && receipt.amount !== undefined) {
                quantityInput.value = receipt.amount;
                quantityInput.readOnly = true;
                quantityInput.disabled = true;
                quantityInput.classList.add('p2p-analytics-input-readonly');
            }
            
            // Fill and disable cost input
            if (costInput && receipt.sum !== null && receipt.sum !== undefined) {
                costInput.value = receipt.sum;
                costInput.readOnly = true;
                costInput.disabled = true;
                costInput.classList.add('p2p-analytics-input-readonly');
            }
            
            console.log('P2P Analytics: Receipt already exists for this order, showing readonly data');
        } else if (!hasCredentials) {
            // No receipt and no credentials - disable and show warning
            checkbox.disabled = true;
            checkbox.classList.add('p2p-analytics-checkbox-disabled');
            warningMessage.style.display = 'block';
            console.log('P2P Analytics: Checkbox disabled - evotor credentials not filled');
        } else {
            // No receipt but credentials present - enable checkbox and check it by default
            checkbox.checked = true;
            conditionalInputs.style.display = 'block';
            
            // Ensure all inputs are editable (not readonly/disabled)
            if (contactInput) {
                contactInput.readOnly = false;
                contactInput.disabled = false;
                contactInput.classList.remove('p2p-analytics-input-readonly');
            }
            if (rateInput) {
                rateInput.readOnly = false;
                rateInput.disabled = false;
                rateInput.classList.remove('p2p-analytics-input-readonly');
            }
            if (quantityInput) {
                quantityInput.readOnly = false;
                quantityInput.disabled = false;
                quantityInput.classList.remove('p2p-analytics-input-readonly');
            }
            if (costInput) {
                costInput.readOnly = false;
                costInput.disabled = false;
                costInput.classList.remove('p2p-analytics-input-readonly');
            }
            
            // Auto-fill fields when checkbox is enabled
            console.log('P2P Analytics: Checkbox enabled and checked by default - evotor credentials are present');
            console.log('P2P Analytics: Auto-filling receipt fields...');
            
            // Fill contact with random Gmail
            if (contactInput) {
                contactInput.value = generateRandomGmail();
                console.log('P2P Analytics: Contact filled:', contactInput.value);
            }
            
            // Fill price, quantity, and cost with retry mechanism
            // This handles SPA pages where data might not be loaded immediately
            waitAndFillReceiptInputs(rateInput, quantityInput, costInput);
        }
    });

    return checkContent;
}

function createInput(labelText, inputId, placeholder) {
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'p2p-analytics-input-wrapper';

    const label = document.createElement('label');
    label.className = 'p2p-analytics-label';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'p2p-analytics-input';
    input.id = inputId;
    input.placeholder = placeholder;

    inputWrapper.appendChild(label);
    inputWrapper.appendChild(input);

    return inputWrapper;
}

function createSubmitButton() {
    const submitButton = document.createElement('button');
    submitButton.className = 'p2p-analytics-submit-button';
    submitButton.textContent = 'Отправить';
    
    // Add click event listener for form submission
    submitButton.addEventListener('click', (event) => {
        event.preventDefault();
        handleFormSubmission();
    });
    
    return submitButton;
}

// Create delete order button
function createDeleteOrderButton() {
    const deleteButton = document.createElement('button');
    deleteButton.className = 'p2p-analytics-delete-button';
    deleteButton.textContent = 'Удалить ордер';
    deleteButton.style.marginTop = '8px';
    deleteButton.style.display = 'none'; // Initially hidden

    // Check if order exists and show button if it does
    const orderId = getOrderIdFromUrl();
    if (orderId) {
        checkOrderExists(orderId).then(result => {
            if (result.success && result.exists) {
                deleteButton.style.display = 'block';
                console.log('P2P Analytics: Order exists, showing delete button');
            } else {
                console.log('P2P Analytics: Order does not exist, hiding delete button');
            }
        }).catch(error => {
            console.error('P2P Analytics: Error checking order existence:', error);
        });
    }

    deleteButton.addEventListener('click', async (event) => {
        event.preventDefault();

        const orderId = getOrderIdFromUrl();
        if (!orderId) {
            alert('Не удалось получить ID ордера из URL страницы');
            return;
        }

        const confirmed = confirm('Если вы допустили ошибку в ордере - не удаляйте его, а пробейте повторно, с корректными данными. Удаление ордера требуется только в случае, если был пробит ордер, не относящийся к деятельности ИП.');
        if (!confirmed) return;

        const originalText = deleteButton.textContent;
        deleteButton.textContent = 'Удаление...';
        deleteButton.disabled = true;

        try {
            const result = await deleteOrder(orderId);
            if (!result.success) {
                alert(`Ошибка при удалении ордера: ${result.error}`);
                return;
            }

            alert('Ордер успешно удален');
            // Reload the page to reflect the deletion
            setTimeout(() => {
                window.location.reload();
            }, 500);
        } catch (error) {
            console.error('Unexpected error deleting order:', error);
            alert(`Произошла ошибка при удалении ордера: ${error.message}`);
        } finally {
            deleteButton.textContent = originalText;
            deleteButton.disabled = false;
        }
    });

    return deleteButton;
}

// Global variables for widget
let observer = null;
let isInitializing = false; // Flag to prevent multiple initializations
let currentUrl = window.location.href; // Track current URL to detect changes
let urlWatchInterval = null; // Persistent URL watcher for SPA navigations

// Load widget collapsed state from storage
let widgetCollapsed = false;
try {
    const storedState = localStorage.getItem('p2p-analytics-widget-collapsed');
    widgetCollapsed = storedState === 'true';
} catch (e) {
    // Ignore localStorage errors
}

async function createFloatingWidget() {
    // Check if widget already exists
    const existingWidget = document.querySelector('.p2p-analytics-widget');
    if (existingWidget) {
        console.log('P2P Analytics: Widget already exists');
        return true;
    }
    
    // Double-check that we're not in the middle of creating a widget
    if (isInitializing) {
        console.log('P2P Analytics: Widget creation already in progress, skipping...');
        return false;
    }
    
    isInitializing = true;
    
    try {
        console.log('P2P Analytics: Creating floating widget...');
        
        // Create main widget container
        const widget = document.createElement('div');
        widget.className = 'p2p-analytics-widget';
        
        // Position widget on LEFT for merchant-admin pages, RIGHT otherwise
        if (isMerchantAdminPage()) {
            widget.classList.add('p2p-analytics-widget--left');
        }
        
        if (widgetCollapsed) {
            widget.classList.add('collapsed');
        }
        
        // Create toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'p2p-analytics-widget-toggle';
        toggleBtn.title = 'Свернуть/Развернуть панель';
        toggleBtn.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
            </svg>
        `;
        toggleBtn.addEventListener('click', () => {
            widgetCollapsed = !widgetCollapsed;
            widget.classList.toggle('collapsed', widgetCollapsed);
            // Save state to localStorage
            try {
                localStorage.setItem('p2p-analytics-widget-collapsed', widgetCollapsed.toString());
            } catch (e) {
                // Ignore localStorage errors
            }
        });
        
        // Create panel container
        const panel = document.createElement('div');
        panel.className = 'p2p-analytics-widget-panel';
        
        // Create header
        const header = document.createElement('div');
        header.className = 'p2p-analytics-widget-header';
        header.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            <span>P2P Analytics</span>
        `;
        
        // Create content container
        const content = document.createElement('div');
        content.className = 'p2p-analytics-widget-content';
        
        // Create the form menu
        const menuContainer = await createDropdownMenu();
        content.appendChild(menuContainer);
        
        // Assemble the panel
        panel.appendChild(header);
        panel.appendChild(content);
        
        // Assemble the widget
        widget.appendChild(toggleBtn);
        widget.appendChild(panel);
        
        // Append to body
        document.body.appendChild(widget);
        
        console.log('P2P Analytics: Floating widget created successfully!');
        
        return true;
    } catch (error) {
        console.error('P2P Analytics: Error creating widget:', error);
        return false;
    } finally {
        isInitializing = false;
    }
}

function cleanupResources() {
    console.log('P2P Analytics: Cleaning up resources...');
    
    // Disconnect observer
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    
    // Remove existing widget
    const existingWidget = document.querySelector('.p2p-analytics-widget');
    if (existingWidget) {
        existingWidget.remove();
    }
    
    // Reset flags
    isInitializing = false;
    // Reset ephemeral SELL name on navigation
    currentSellDisplayNameTemp = '';
    // Reset captured BUY original name on navigation
    originalBuyName = '';
}

function initializeMutationObserver() {
    if (observer) {
        observer.disconnect();
    }
    
    // Debounce mechanism to prevent too frequent calls
    let debounceTimer = null;
    
    observer = new MutationObserver(async (mutationsList, obs) => {
        // Clear previous timer
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        
        // Debounce the handler to prevent excessive calls
        debounceTimer = setTimeout(async () => {
            // Capture original BUY name and attempt to replace payer name when DOM mutates
            ensureOriginalBuyNameCaptured();
            applyDisplayNameIfNeeded();
            if (currentSellDisplayNameTemp) {
                // For BUY orders: replace seller's name in payment methods
                if (isBuyPage()) {
                    try { replaceCounterpartyNameInPaymentMethod(currentSellDisplayNameTemp); } catch (_) { /* noop */ }
                }
                
                // For SELL orders: replace buyer's name in chat and other places
                replaceSellerNameInDom(currentSellDisplayNameTemp);
            }
        }, 100); // 100ms debounce
    });

    // Start observing with more comprehensive options
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'] // Watch for class and style changes
    });
}

async function tryInsertWidget() {
    console.log('P2P Analytics: Attempting to create floating widget...');
    
    if (await createFloatingWidget()) {
        console.log('P2P Analytics: Floating widget created successfully!');
    } else {
        console.error('P2P Analytics: Failed to create floating widget');
    }
}

// --- Main Execution ---
async function initialize() {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('P2P Analytics: Already initializing, skipping...');
        return;
    }
    
    console.log('P2P Analytics: Initializing extension...');
    console.log('P2P Analytics: Current URL:', window.location.href);
    
    // Check if we're on the right page - should work for all orderList pages with order IDs on bybit.com
    const urlPattern = /bybit\.com.*\/orderList\/\d+/;
    const isCorrectPage = urlPattern.test(window.location.href);
    console.log('P2P Analytics: On correct page:', isCorrectPage);
    console.log('P2P Analytics: URL pattern test result:', window.location.href, '→', isCorrectPage);
    
    if (!isCorrectPage) {
        console.log('P2P Analytics: Not on order page, skipping initialization');
        cleanupResources(); // Clean up widget if navigating away
        return;
    }
    
    // Check if auth helper is loaded
    if (!window.P2PAuth) {
        console.error('P2P Analytics: Auth helper not loaded, retrying...');
        setTimeout(initialize, 1000);
        return;
    }
    
    console.log('P2P Analytics: Auth helper loaded successfully');
    
    // Check authentication status
    try {
        const isAuth = await window.P2PAuth.isAuthenticated();
        console.log('P2P Analytics: User authenticated:', isAuth);
        
        if (!isAuth) {
            console.log('P2P Analytics: User not authenticated, showing auth error');
            window.P2PAuth.showAuthError('Необходимо авторизоваться для работы с расширением. Нажмите на иконку расширения для входа в систему.');
        }
    } catch (error) {
        console.error('P2P Analytics: Error checking authentication:', error);
    }
    
    // Load display name and try to apply immediately (BUY only)
    await loadDisplayNameFromStorage();
    ensureOriginalBuyNameCaptured();
    applyDisplayNameIfNeeded();
    
    // Clean up any existing resources
    cleanupResources();
    
    // Initialize MutationObserver
    initializeMutationObserver();
    
    // Create floating widget
    await tryInsertWidget();
}

// Handle different loading states
function handleDocumentReady() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        // DOM is already loaded
        initialize();
    }
}

// Start the process
handleDocumentReady();
// Ensure URL watcher is running to catch SPA route changes that do not fire popstate/hashchange
function ensureUrlWatcher() {
    if (!urlWatchInterval) {
        urlWatchInterval = setInterval(() => {
            try {
                handleUrlChange();
            } catch (e) {
                // noop
            }
        }, 300);
    }
}
ensureUrlWatcher();
// Unified handler for URL changes (SPA-friendly)
function handleUrlChange() {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
        console.log('P2P Analytics: URL change detected, reinitializing...');
        currentUrl = newUrl;
        cleanupResources();
        setTimeout(() => initialize(), 200);
    }
}

// Also listen for page navigation in SPAs (back/forward)
window.addEventListener('popstate', handleUrlChange);

// Listen for hash changes (common in SPAs)
window.addEventListener('hashchange', handleUrlChange);

// Detect pushState/replaceState navigations (typical SPA route changes)
(function patchHistoryApiForUrlChanges() {
    try {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function() {
            const result = originalPushState.apply(this, arguments);
            handleUrlChange();
            return result;
        };

        history.replaceState = function() {
            const result = originalReplaceState.apply(this, arguments);
            handleUrlChange();
            return result;
        };
    } catch (e) {
        console.warn('P2P Analytics: Failed to patch History API for URL changes:', e);
    }
})();

// Clean up resources when leaving the page
window.addEventListener('beforeunload', () => {
    cleanupResources();
});

// Listen for auth changes and display name changes
if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'sync') {
            if (changes.authToken) {
                console.log('P2P Analytics: Auth token changed, reinitializing...');
                
                // If token was removed (user logged out)
                if (!changes.authToken.newValue && changes.authToken.oldValue) {
                    console.log('P2P Analytics: User logged out');
                    cleanupResources();
                    window.P2PAuth.showAuthError('Вы вышли из системы. Для работы с расширением необходимо авторизоваться заново.');
                }
                
                // If token was added (user logged in)
                if (changes.authToken.newValue && !changes.authToken.oldValue) {
                    console.log('P2P Analytics: User logged in, reinitializing...');
                    setTimeout(() => {
                        initialize();
                    }, 500);
                }
            }

            if (changes.displayName) {
                currentDisplayName = changes.displayName.newValue || '';
                console.log('P2P Analytics: Display name changed to:', currentDisplayName);
                applyDisplayNameIfNeeded();
            }
        }
    });
}

// Listen for one-time SELL name application from popup
try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.action === 'applySellName') {
            try {
                // if (!isSellPage()) {
                //     sendResponse({ success: false, error: 'Текущая страница не SELL' });
                //     return; 
                // }
                const name = (message.name || '').trim();
                if (!name) {
                    sendResponse({ success: false, error: 'Имя пустое' });
                    return;
                }
                currentSellDisplayNameTemp = name; // ephemeral, cleared on navigation
                
                // Apply replacement using multiple strategies
                let replaced = false;
                
                // For BUY orders: replace seller's name in payment methods
                if (isBuyPage()) {
                    replaced = replaceCounterpartyNameInPaymentMethod(name) || replaced;
                }
                
                // For SELL orders: replace buyer's name in chat and other places
                replaced = replaceSellerNameInDom(name) || replaced;
                
                // Even if not replaced immediately, keep ephemeral for future DOM mutations
                sendResponse({ success: true, replaced });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка применения имени' });
            }
            return true; // indicate async/sync response handled
        }
    });
} catch (e) {
    // ignore listener errors
}

// Debug function to manually test the extension
window.P2PAnalyticsDebug = {
    initialize: initialize,
    createWidget: createFloatingWidget,
    createMenu: createDropdownMenu,
    toggleWidget: () => {
        const widget = document.querySelector('.p2p-analytics-widget');
        if (widget) {
            widgetCollapsed = !widgetCollapsed;
            widget.classList.toggle('collapsed', widgetCollapsed);
            try {
                localStorage.setItem('p2p-analytics-widget-collapsed', widgetCollapsed.toString());
            } catch (e) { /* ignore */ }
            console.log('Debug: Widget collapsed:', widgetCollapsed);
        } else {
            console.log('Debug: Widget not found');
        }
    },
    testAuth: async () => {
        if (window.P2PAuth) {
            const isAuth = await window.P2PAuth.isAuthenticated();
            console.log('Debug: User authenticated:', isAuth);
            return isAuth;
        } else {
            console.log('Debug: P2PAuth not loaded');
            return false;
        }
    },
    testScreenshot: async () => {
        try {
            console.log('Debug: Testing screenshot capture...');
            const dataUrl = await captureScreenshot();
            console.log('Debug: Screenshot captured successfully, length:', dataUrl.length);
            return dataUrl;
        } catch (error) {
            console.error('Debug: Screenshot capture failed:', error);
            return null;
        }
    },
    downloadTestScreenshot: async () => {
        try {
            const dataUrl = await captureScreenshot();
            const downloadUrl = await downloadScreenshot(dataUrl, 'test');
            console.log('Debug: Test screenshot downloaded:', downloadUrl);
            return downloadUrl;
        } catch (error) {
            console.error('Debug: Test screenshot download failed:', error);
            return null;
        }
    },
    testParseOrderInfo: () => {
        const orderInfo = parseOrderInfo();
        console.log('Debug: Parsed order info:', orderInfo);
        return orderInfo;
    },
    testCollectFormData: () => {
        const formData = collectFormData();
        console.log('Debug: Collected form data:', formData);
        return formData;
    }
};

console.log('P2P Analytics: Debug functions available at window.P2PAnalyticsDebug');
console.log('P2P Analytics: Content script initialization complete');
