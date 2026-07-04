// P2P Analytics Content Script
console.log('P2P Analytics: Content script loaded');
console.log('P2P Analytics: Script load time:', new Date().toISOString());

// Exchange type constant for Bybit
const EXCHANGE_TYPE_BYBIT = 1;


// Commission type constants are already declared in order_api.js
// COMMISSION_TYPE_PERCENT and COMMISSION_TYPE_MONEY are available globally

// UI color constants
const GOLD_COLOR_RGB = 'rgb(247, 166, 0)'; // #F7A600
// --- НОВЫЙ СПИСОК БАНКОВ (Синхронизирован с БД) ---
const FIXED_BANKS = [
    { id: 1, name: 'Сбербанк' },
    { id: 2, name: 'Тинькофф' },
    { id: 3, name: 'Райффайзен' },
    { id: 4, name: 'ВТБ' },
    { id: 5, name: 'Альфа-Банк' },
    { id: 6, name: 'Газпромбанк' },
    { id: 7, name: 'Росбанк' },
    { id: 8, name: 'СБП' },
    { id: 9, name: 'Озон Банк' },
    { id: 10, name: 'Уралсиб' },
    { id: 11, name: 'Хайс' },
    { id: 12, name: 'Русский Стандарт' }
];
// Helper to detect if we're on merchant-admin page
function isMerchantAdminPage() {
    // Проверяем pathname, а не весь href — защита от совпадений в параметрах/хэше
    return /\/merchant-admin/i.test(window.location.pathname);
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
let currentSellRealNameTemp = '';
// Added: keep the original BUY page name to allow reset
let originalBuyName = '';
let originalOwnName = '';
let lastOrderIdForNameReset = null;
let originalCounterpartyNickname = '';
let originalCounterpartyRealName = '';
let ownNameRetryInterval = null;
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

    // Только .im-container-caption__info-verified
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
    } catch (e) { /* ignore */ }

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

function startOwnNameRetry(name, maxAttempts = 20, delayMs = 500) {
    // Останавливаем предыдущий retry, если был
    if (ownNameRetryInterval) {
        clearInterval(ownNameRetryInterval);
        ownNameRetryInterval = null;
    }

    let attempts = 0;
    ownNameRetryInterval = setInterval(() => {
        attempts++;

        // Если пользователь сбросил имя в процессе — останавливаемся
        if (!currentDisplayName || currentDisplayName !== name) {
            clearInterval(ownNameRetryInterval);
            ownNameRetryInterval = null;
            return;
        }

        const replaced = replaceOwnNameInPaymentMethod(name);

        if (replaced) {
            console.log('P2P Analytics: своё имя успешно применено, попытка', attempts);
            clearInterval(ownNameRetryInterval);
            ownNameRetryInterval = null;
            return;
        }

        if (attempts >= maxAttempts) {
            console.warn('P2P Analytics: не удалось применить своё имя за', maxAttempts, 'попыток');
            clearInterval(ownNameRetryInterval);
            ownNameRetryInterval = null;
        }
    }, delayMs);
}

function stopOwnNameRetry() {
    if (ownNameRetryInterval) {
        clearInterval(ownNameRetryInterval);
        ownNameRetryInterval = null;
    }
}

// New: Replace own name in payment method details (SELL order - your payment details)
function replaceOwnNameInPaymentMethod(name, root = document) {
    if (!name) return false;
    let replaced = false;

    try {
        const items = root.querySelectorAll('.order-detail__pay-info-item');
        items.forEach(item => {
            const spans = item.querySelectorAll('span.moly-text');
            if (spans.length < 2) return;

            const label = (spans[0].textContent || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            if (!/^(name|имя|фио)$/.test(label)) return;

            const valueSpan = spans[1];
            if (!valueSpan) return;

            // Берём только текстовые ноды (без SVG)
            let currentText = '';
            valueSpan.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    currentText += node.textContent;
                }
            });
            currentText = currentText.trim();

            // Захватываем оригинал ДО первой замены — нужно для мгновенного сброса
            if (!originalOwnName && currentText && currentText !== name) {
                originalOwnName = currentText;
            }

            if (currentText && currentText !== name) {
                // Меняем только первый текстовый нод
                valueSpan.childNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                        node.textContent = name;
                        replaced = true;
                    }
                });
                console.log('P2P Analytics: меняем своё имя:', currentText, '→', name);
            }
        });
    } catch (e) {
        console.warn('P2P Analytics: Failed to replace own name:', e);
    }

    return replaced;
}

// New: Replace counterparty name in payment method details (works for both BUY and SELL)
function replaceCounterpartyNameInPaymentMethod(name, root = document) {
    if (!name) return false;
    
    // --- ГЛАВНОЕ ИСПРАВЛЕНИЕ ---
    // Если мы на странице SELL (Продажа), то блок оплаты (#fiat-otc-order__payment)
    // содержит НАШИ реквизиты (куда нам платят). Там НЕТ имени контрагента.
    // Поэтому мы просто выходим и ничего там не ищем. Это защитит твое имя у друга.
    if (isSellPage()) {
        return false;
    }

    let replaced = false;
    
    try {
        const paymentSection = root.querySelector('#fiat-otc-order__payment');
        if (!paymentSection) return false;
        
        // Helper isInMyAccountSection (оставляем для надежности, если логика isSellPage вдруг сбойнет)
        function isInMyAccountSection(element) {
             let current = element;
             while (current && current !== paymentSection) {
                 let prevSibling = current.previousElementSibling;
                 while (prevSibling) {
                     const text = (prevSibling.textContent || '').trim();
                     const normalized = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
                     if (/мой\s+аккаунт\s+получени|my\s+receiv.*account|my\s+account/i.test(normalized) && text.length < 200) return true;
                     prevSibling = prevSibling.previousElementSibling;
                 }
                 current = current.parentElement;
             }
             return false;
        }
        
        const allRows = paymentSection.querySelectorAll('div[style*="display: flex"]');
        
        allRows.forEach(row => {
            if (isInMyAccountSection(row)) return;
            
            const children = Array.from(row.children);
            if (children.length < 2) return;
            const labelElement = children[0];
            const valueContainer = children[1];
            if (!labelElement || !valueContainer) return;
            
            const labelText = (labelElement.textContent || '').trim().toLowerCase();
            const normalizedLabel = labelText.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            
            // Игнор банка
            if (/bank|банк|branch|отделение|method|метод/i.test(normalizedLabel)) return;

            // Защита на BUY странице (твое имя как плательщика)
            if (isBuyPage()) {
                 if (/payer|sender|плательщик|отправитель|real\s+name|верифицирован|account\s+holder/i.test(normalizedLabel)) return;
            }

            const isNameField = /фамилия.*имя|full.*name|\bname\b|nombre|nome|nom|имя\s+и\s+фамилия/i.test(normalizedLabel);
            if (!isNameField) return;
            
            let valueElement = valueContainer.querySelector('.moly-space-item-first, [class*="space-item-first"]');
            if (!valueElement) {
                const valueDivs = valueContainer.querySelectorAll('div');
                for (const div of valueDivs) {
                    const text = (div.textContent || '').trim();
                    if (text && text.length > 0 && !div.querySelector('i, svg')) {
                        valueElement = div;
                        break;
                    }
                }
            }
            if (!valueElement) return;

            // Защита от золотого текста на BUY
            if (isBuyPage()) {
                const styleAttr = valueElement.getAttribute('style') || '';
                const cs = window.getComputedStyle(valueElement);
                const isGold = cs.color === GOLD_COLOR_RGB || /#f7a600/i.test(styleAttr) || /var\(--bds-brand-700-normal/.test(styleAttr);
                if (isGold) return; 
            }

            const current = (valueElement.textContent || '').trim();
            if (/^[A-Z]{2,3}$/.test(current)) return;
            
            const isPlaceholder = !current || /реквизиты\s+указаны|details\s+specified/i.test(current);
            if (isPlaceholder || (current.length > 0 && current !== name)) {
                valueElement.textContent = name;
                replaced = true;
            }
        });
    } catch (e) { /* noop */ }
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
const getOrderIdFromUrl = () => {
    const url = window.location.href;
    console.log('P2P Analytics: Extracting order ID from URL:', url);
    
    // Use regex to extract order ID from orderList URL pattern
    const orderIdMatch = url.match(/\/orderList\/(\d+)/);
    
    if (orderIdMatch && orderIdMatch[1]) {
        // Ensure orderId is always returned as a string
        const orderId = String(orderIdMatch[1]);
        console.log('P2P Analytics: Extracted order ID:', orderId, 'Type:', typeof orderId);
        return orderId;
    }
    
    console.error('P2P Analytics: Could not extract valid order ID from URL:', url);
    return null;
};

// Wrapper for checkOrderExists with Bybit exchange type
checkOrderExists = async (orderId) => {
    return window.P2POrderAPI.checkOrderExists(orderId, EXCHANGE_TYPE_BYBIT);
};

// Wrapper for deleteOrder with Bybit exchange type
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
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для загрузки скриншота');
            return {
                success: false,
                error: 'Не авторизован'
            };
        }

        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const result = await window.P2PAuth.uploadScreenshot(blob, `${orderId}.png`);
        
        return result;
    } catch (error) {
        console.error('Error uploading screenshot:', error);
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

// Added: Reset display name to original default and clear storage
async function resetBuyDisplayName() {
    try {
        stopOwnNameRetry(); 

        await chrome.storage.sync.set({ displayName: '' });
        currentDisplayName = '';

        if (isBuyPage()) {
             if (!originalBuyName) {
                originalBuyName = detectOriginalBuyName(document) || '';
            }
            if (originalBuyName) {
                replaceBuyTipsName(originalBuyName);
                replacePayerNameInDom(originalBuyName);
            }
        }

        if (isSellPage() && originalOwnName) {
             replaceOwnNameInPaymentMethod(originalOwnName);
        }

        // Сбрасываем оригинал, чтобы следующее применение нового имени снова захватило актуальный оригинал
        originalOwnName = '';

        alert('Имя сброшено к исходному');
    } catch (e) {
        console.error('P2P Analytics: Failed to reset name:', e);
        alert('Не удалось сбросить имя: ' + (e?.message || e));
    }
}

// Function to parse order date and type from DOM
function parseOrderInfo() {
    const orderInfo = {};
    
    // Дата — ищем поле "Order Time"
    const rawDate = findPayInfoValue(/order\s+time/i);
    if (rawDate) {
        const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
            orderInfo.createdAt = new Date(dateMatch[1]).toISOString();
            console.log('P2P Analytics: Parsed order date:', orderInfo.createdAt);
        }
    }
    
    // Тип — ищем в заголовке блока .order-detail__order-info
    const typeSpans = document.querySelectorAll('.order-detail__order-info .moly-text');
    for (const span of typeSpans) {
        const text = normalizeText(span.textContent);
        if (/продаж|sell/i.test(text)) { orderInfo.type = 'SELL'; break; }
        if (/покупк|buy/i.test(text)) { orderInfo.type = 'BUY'; break; }
    }
    
    if (!orderInfo.type) {
        orderInfo.type = detectOrderType().toUpperCase();
    }
    
    console.log('P2P Analytics: Parsed order info:', orderInfo);
    return orderInfo;
}

// Function to collect form data
function collectFormData() {
    const formData = {};
    
    const cleanAndParseFloat = (value, decimals = 2) => {
        if (!value && value !== 0) return null;
        if (typeof value === 'number') {
            const factor = Math.pow(10, decimals);
            return Math.trunc(parseFloat(value.toFixed(10)) * factor) / factor;
        }
        let clean = value.toString().replace(/\s|&nbsp;|\u00A0/g, '').trim();
        clean = clean.replace(/[^\d.,]/g, '');
        if (!clean) return null;
        if (clean.includes(',') && clean.includes('.')) {
            clean = clean.replace(/,/g, '');
        } else if (clean.includes(',')) {
            clean = clean.replace(',', '.');
        }
        const num = parseFloat(clean);
        if (isNaN(num)) return null;
        const factor = Math.pow(10, decimals);
        return Math.trunc(parseFloat(num.toFixed(10)) * factor) / factor;
    };
    
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    const selectedBankId = bankButton ? bankButton.getAttribute('data-bank-id') : null;
    formData.bank = bankButton ? bankButton.textContent : null;
    formData.bankId = selectedBankId ? parseInt(selectedBankId) : null;
    
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    formData.commission = commissionInput ? (cleanAndParseFloat(commissionInput.value, 2) || 0) : 0;
    formData.commissionType = commissionType ? commissionType.getAttribute('data-commission-type') || COMMISSION_TYPE_PERCENT : COMMISSION_TYPE_PERCENT;
    
    formData.screenshot = true;

    const editCheckbox = document.querySelector('#edit-checkbox');
    formData.manualEdit = editCheckbox ? editCheckbox.checked : false;
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    const contactInput = document.querySelector('#contact-input');
    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');

    let finalPrice    = cleanAndParseFloat(rateInput ? rateInput.value : '', 2);
    let finalQuantity = cleanAndParseFloat(quantityInput ? quantityInput.value : '', 3);
    let finalAmount   = cleanAndParseFloat(costInput ? costInput.value : '', 2);

    if (!finalPrice) {
        console.log('P2P Analytics: Price missing in input, parsing from page...');
        finalPrice = cleanAndParseFloat(parsePriceFromPage(), 2);
    }
    if (!finalQuantity) {
        console.log('P2P Analytics: Quantity missing in input, parsing from page...');
        finalQuantity = cleanAndParseFloat(parseQuantityFromPage(), 3);
    }
    if (!finalAmount) {
        console.log('P2P Analytics: Amount missing in input, parsing from page...');
        finalAmount = cleanAndParseFloat(parseAmountFromPage(), 2);
    }

    formData.price = finalPrice;
    formData.quantity = finalQuantity;
    formData.amount = finalAmount;

    if (formData.hasReceipt) {
        console.log('P2P Analytics: Collecting receipt data...');
        let validQtyForReceipt = finalQuantity;
        if (validQtyForReceipt !== null) {
            validQtyForReceipt = Math.floor(validQtyForReceipt * 1000) / 1000;
        }
        const receiptData = {
            contact: contactInput ? contactInput.value.trim() : '',
            price: finalPrice,
            amount: validQtyForReceipt,
            sum: finalAmount,
        };
        const hasValidData = receiptData.contact || receiptData.price !== null || receiptData.amount !== null || receiptData.sum !== null;
        formData.receipt = hasValidData ? receiptData : null;
    } else {
        formData.receipt = null;
    }
    
    const orderInfo = parseOrderInfo();
    formData.createdAt = orderInfo.createdAt;
    formData.type = orderInfo.type;
    
    console.log('P2P Analytics: Collected Data ->', { 
        price: formData.price, 
        qty: formData.quantity, 
        amount: formData.amount,
        hasReceipt: formData.hasReceipt 
    });
    
    return formData;
}

// Function to handle form submission
async function handleFormSubmission() {
    const formData = collectFormData();
    
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
    
    const orderId = getOrderIdFromUrl();
    if (!orderId) {
        alert('Не удалось получить ID заказа из URL страницы');
        return;
    }

    const isAuth = await window.P2PAuth.isAuthenticated();
    if (!isAuth) {
        window.P2PAuth.showAuthError('Необходимо авторизоваться для отправки заказа');
        return;
    }

    const submitButton = document.querySelector('.p2p-analytics-submit-button');
    const originalText = submitButton.textContent;
    submitButton.textContent = 'Отправка...';
    submitButton.disabled = true;
    
    let screenshotDataUrl = null;
    
    try {
        submitButton.textContent = 'Создание скриншота...';
        console.log('P2P Analytics: Capturing screenshot...');
        
        try {
            screenshotDataUrl = await captureScreenshot();
            console.log('P2P Analytics: Screenshot captured successfully');
        } catch (error) {
            console.error('P2P Analytics: Error capturing screenshot:', error);
        }

        let existingReceipt = null;
        try {
            const existingOrderResult = await checkOrderExists(orderId);
            if (existingOrderResult.success && existingOrderResult.exists && existingOrderResult.data && existingOrderResult.data.receipt) {
                existingReceipt = existingOrderResult.data.receipt;
            }
        } catch (error) {
            console.warn('P2P Analytics: Could not check existing order receipt:', error);
        }

        let receiptValue = null;
        if (existingReceipt) {
            receiptValue = existingReceipt;
            console.log('P2P Analytics: Using EXISTING receipt');
        } else if (formData.hasReceipt && formData.receipt) {
            receiptValue = formData.receipt;
            console.log('P2P Analytics: Using NEW receipt from form');
        } else {
            console.log('P2P Analytics: No receipt will be sent (null)');
        }
        
        const orderData = {
            orderId: String(orderId),
            details: { id: formData.bankId },
            commission: formData.commission,
            commissionType: formData.commissionType,
            screenshotName: `${orderId}.png`,
            receipt: receiptValue,
            createdAt: formData.createdAt,
            type: formData.type,
            exchangeType: EXCHANGE_TYPE_BYBIT,
            
            price: formData.price,       
            quantity: formData.quantity, 
            amount: formData.amount,
            manualEdit: formData.manualEdit 
        };
        
        console.log('P2P Analytics: Order data prepared:', orderData);
        
        submitButton.textContent = 'Сохранение заказа...';
        const result = await saveOrder(orderData);
        
        if (!result.success) {
            alert(`Ошибка при сохранении заказа: ${result.error}`);
            console.error('Error saving order:', result.error);
            return;
        }
        
        console.log('Order saved successfully:', result);
        
        if (screenshotDataUrl) {
            submitButton.textContent = 'Загрузка скриншота...';
            try {
                const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
                if (!uploadResult.success) {
                    console.error('Error uploading screenshot:', uploadResult.error);
                }
            } catch (error) {
                console.error('Error uploading screenshot:', error);
            }
        }
        
        alert(`Ордер успешно сохранен! ID: ${result.orderId}.`);
        
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

function resetForm() {
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    if (bankButton) {
        bankButton.textContent = 'Выберите банк';
        bankButton.removeAttribute('data-bank-id');
    }
    
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    if (commissionInput) {
        commissionInput.value = '';
        commissionInput.placeholder = 'Введите комиссию';
    }
    
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    if (commissionType) {
        commissionType.textContent = '%';
        commissionType.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
    }
    
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

    console.log('P2P Analytics: Creating unified form section...');
    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics: Dropdown menu created successfully');
    return dropdownContainer;
}

async function createUnifiedFormSection() {
    const formSection = document.createElement('div');
    formSection.className = 'p2p-analytics-form-section';

    formSection.appendChild(createSubmitButton());

    const deleteButton = createDeleteOrderButton();
    formSection.appendChild(deleteButton);

    const requisitesTitle = document.createElement('h3');
    requisitesTitle.className = 'p2p-analytics-form-title';
    requisitesTitle.textContent = 'Реквизиты';
    formSection.appendChild(requisitesTitle);

    const buttonMenuWrapper = document.createElement('div');
    buttonMenuWrapper.style.position = 'relative';
    buttonMenuWrapper.style.width = '100%';

    const dropdownButton = document.createElement('button');
    dropdownButton.className = 'p2p-analytics-button';
    
    const buttonTextSpan = document.createElement('span');
    buttonTextSpan.className = 'p2p-analytics-button-text';
    buttonTextSpan.textContent = 'Выберите банк';

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

    console.log('P2P Analytics: Using FIXED bank list');
    
    FIXED_BANKS.forEach(bankDetail => {
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

    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);

    formSection.appendChild(buttonMenuWrapper);

    const commissionInputWrapper = createCommissionInput();
    formSection.appendChild(commissionInputWrapper);
    
    const orderId = getOrderIdFromUrl();
    if (orderId) {
        checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                console.log('P2P Analytics: Order exists, pre-populating form fields:', order);
                
                if (order.details) {
                    const details = order.details;
                    const matchingBankDetail = FIXED_BANKS.find(bd => bd.id === details.id);
                    
                    if (matchingBankDetail) {
                        buttonTextSpan.textContent = matchingBankDetail.name;
                        buttonTextSpan.setAttribute('data-bank-id', details.id);
                    } else {
                         if (details.name) {
                             buttonTextSpan.textContent = details.name;
                         } else {
                             buttonTextSpan.textContent = "Неизвестный банк";
                         }
                        buttonTextSpan.setAttribute('data-bank-id', details.id);
                    }
                }
                
                if (order.commission !== null && order.commission !== undefined) {
                    const commissionInput = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (commissionInput) {
                        commissionInput.value = order.commission;
                    }
                }
                
                if (order.commissionType) {
                    const commissionTypeButton = commissionInputWrapper.querySelector('.p2p-analytics-suffix-text');
                    const commissionInput = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (commissionTypeButton) {
                        if (order.commissionType === COMMISSION_TYPE_MONEY) {
                            commissionTypeButton.textContent = '₽';
                            commissionTypeButton.setAttribute('data-commission-type', COMMISSION_TYPE_MONEY);
                            if (commissionInput) commissionInput.placeholder = 'Введите сумму в рублях';
                        } else {
                            commissionTypeButton.textContent = '%';
                            commissionTypeButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
                            if (commissionInput) commissionInput.placeholder = 'Введите процент';
                        }
                    }
                }
            }
        }).catch(error => {
            console.error('P2P Analytics: Error checking order for form pre-population:', error);
        });
    }

    const separator = createSeparator();
    formSection.appendChild(separator);

    const checkContent = createCheckContent();
    formSection.appendChild(checkContent);

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

    const inputGroup = document.createElement('div');
    inputGroup.className = 'p2p-analytics-input-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'p2p-analytics-input p2p-analytics-commission-input';
    input.placeholder = 'Введите комиссию';

    const suffixWrapper = document.createElement('div');
    suffixWrapper.className = 'p2p-analytics-input-suffix';
    suffixWrapper.style.position = 'relative';

    const dropdownButton = document.createElement('button');
    dropdownButton.className = 'p2p-analytics-suffix-button';
    dropdownButton.type = 'button';
    
    const buttonTextSpan = document.createElement('span');
    buttonTextSpan.className = 'p2p-analytics-suffix-text';
    buttonTextSpan.textContent = '%';
    buttonTextSpan.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT); 

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
            buttonTextSpan.setAttribute('data-commission-type', type.value); 
            
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

    dropdownButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const isHidden = dropdownMenu.style.display === 'none';
        dropdownMenu.style.display = isHidden ? 'block' : 'none';
        dropdownButton.classList.toggle('p2p-analytics-suffix-button-active', isHidden);
        
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
    checkbox.checked = true;

    const label = document.createElement('label');
    label.className = 'p2p-analytics-checkbox-label';
    label.htmlFor = 'screenshot-checkbox';
    label.textContent = 'Скриншот';

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    return checkboxWrapper;
}

function findPayInfoValue(labelText) {
    const items = document.querySelectorAll('.order-detail__pay-info-item');
    for (const item of items) {
        const spans = item.querySelectorAll('span.moly-text');
        if (spans.length < 2) continue;
        
        const label = spans[0].textContent.trim();
        if (labelText.test ? labelText.test(label) : label === labelText) {
            const valueSpan = spans[1];
            let text = '';
            for (const node of valueSpan.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent;
                } else if (node.tagName === 'SVG' || (node.tagName && node.tagName.toLowerCase() === 'svg')) {
                    break;
                }
            }
            return text.trim();
        }
    }
    return '';
}

function parsePriceFromPage() {
    try {
        const raw = findPayInfoValue(/^(цена|price)$/i);
        console.log('P2P Analytics: RAW price from DOM:', raw);
        if (raw) {
            const price = extractNumber(raw);
            if (price !== null) return price.toString();
        }
        console.warn('P2P Analytics: Could not find price');
        return '';
    } catch (e) {
        console.error('P2P Analytics: Error parsing price:', e);
        return '';
    }
}

function parseQuantityFromPage() {
    try {
        console.log('P2P Analytics: Parsing quantity from page...');
        
        const summaryItems = document.querySelectorAll('.summary-item');
        for (const item of summaryItems) {
            const title = item.querySelector('.summary-item-title');
            const value = item.querySelector('.summary-item-value');
            if (title && value) {
                const titleText = title.textContent.trim().toLowerCase();
                if (titleText.includes('quantity') || titleText.includes('количество') || 
                    titleText.includes('cantidad') || titleText.includes('quantité')) {
                    const quantityText = value.textContent.trim();
                    console.log('P2P Analytics: Found quantity by .summary-item title:', quantityText);
                    const quantity = extractNumber(quantityText);
                    if (quantity !== null) return truncateToDecimals(quantity, 3).toString();
                }
            }
        }
        
        const payInfoItems = document.querySelectorAll('.order-detail__pay-info-item');
        for (const item of payInfoItems) {
            const spans = item.querySelectorAll('span');
            if (spans.length >= 2) {
                const labelText = spans[0].textContent.trim().toLowerCase();
                if (labelText.includes('quantity') || labelText.includes('количество') ||
                    labelText.includes('total quantity')) {
                    const valueText = spans[1].textContent.trim();
                    console.log('P2P Analytics: Found quantity by .order-detail__pay-info-item:', valueText);
                    const quantity = extractNumber(valueText);
                    if (quantity !== null) return truncateToDecimals(quantity, 3).toString();
                }
            }
        }

        const payInfo = document.querySelector('.order-detail__pay-info');
        if (payInfo) {
            const allSpans = payInfo.querySelectorAll('span');
            for (const span of allSpans) {
                const text = span.textContent.trim();
                if (/USDT|BTC|ETH|USDC/i.test(text) && /[\d,.]/.test(text)) {
                    const quantity = extractNumber(text);
                    if (quantity !== null) {
                        console.log('P2P Analytics: Found quantity by crypto pattern in pay-info:', text);
                        return truncateToDecimals(quantity, 3).toString();
                    }
                }
            }
        }

        const allValues = document.querySelectorAll('.summary-item-value');
        for (const value of allValues) {
            const text = value.textContent.trim();
            if (/USDT|BTC|ETH|USDC|DAI/i.test(text)) {
                const quantity = extractNumber(text);
                if (quantity !== null) {
                    console.log('P2P Analytics: Found quantity by crypto pattern:', text);
                    return truncateToDecimals(quantity, 3).toString();
                }
            }
        }
        
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
function parseAmountFromPage() {
    try {
        const raw = findPayInfoValue(/сумма\s+в\s+фиате|fiat\s+amount/i);
        console.log('P2P Analytics: RAW amount from DOM:', raw);
        if (raw) {
            const amount = extractNumber(raw);
            if (amount !== null) return amount.toString();
        }
        console.warn('P2P Analytics: Could not find amount');
        return '';
    } catch (e) {
        console.error('P2P Analytics: Error parsing amount:', e);
        return '';
    }
}

function waitAndFillReceiptInputs(rateInput, quantityInput, costInput, maxRetries = 10, delay = 500) {
    let retryCount = 0;
    
    function tryFill() {
        const summaryItems = document.querySelectorAll('.summary-item');
        const hasSummaryItems = summaryItems.length >= 3;
        
        console.log('P2P Analytics: Attempting to fill receipt inputs, retry:', retryCount, 'summary items found:', summaryItems.length);
        
        const rateValue = parsePriceFromPage();
        const quantityValue = parseQuantityFromPage();
        const costValue = parseAmountFromPage();
        
        console.log('P2P Analytics: Parsed values - rate:', rateValue, 'quantity:', quantityValue, 'cost:', costValue);
        
        const hasValidData = rateValue || quantityValue || costValue;
        
        if (hasValidData) {
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
        
        retryCount++;
        if (retryCount < maxRetries) {
            console.log('P2P Analytics: No valid data found, retrying in', delay, 'ms...');
            setTimeout(tryFill, delay);
            return false;
        }
        
        console.warn('P2P Analytics: Max retries exceeded, could not fill receipt inputs');
        return false;
    }
    
    tryFill();
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

    // ── Чекбокс ЧЕК ──────────────────────────────────────────────────────────
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

    // ── Чекбокс РЕДАКТИРОВАНИЕ ────────────────────────────────────────────────
    const editCheckboxWrapper = document.createElement('div');
    editCheckboxWrapper.className = 'p2p-analytics-checkbox-wrapper';
    editCheckboxWrapper.style.marginTop = '4px';

    const editCheckbox = document.createElement('input');
    editCheckbox.type = 'checkbox';
    editCheckbox.className = 'p2p-analytics-checkbox';
    editCheckbox.id = 'edit-checkbox';
    editCheckbox.checked = false;

    const editLabel = document.createElement('label');
    editLabel.className = 'p2p-analytics-checkbox-label';
    editLabel.htmlFor = 'edit-checkbox';
    editLabel.textContent = 'Редактирование';

    editCheckboxWrapper.appendChild(editCheckbox);
    editCheckboxWrapper.appendChild(editLabel);

    // ── Сообщения ─────────────────────────────────────────────────────────────
    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.display = 'none';
    warningMessage.textContent = 'Чтобы пробить чек, заполните анкету';

    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.display = 'none';
    successMessage.textContent = 'Чек пробит';

    // ── Поля ввода ────────────────────────────────────────────────────────────
    const conditionalInputs = document.createElement('div');
    conditionalInputs.className = 'p2p-analytics-conditional-inputs';
    conditionalInputs.style.display = 'none';

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
    checkContent.appendChild(editCheckboxWrapper);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    // ── Хелперы блокировки/разблокировки ─────────────────────────────────────
    function lockFinancialFields() {
        [rateInput, quantityInput, costInput].forEach(input => {
            if (!input) return;
            input.readOnly = true;
            input.disabled = true;
            input.classList.add('p2p-analytics-input-readonly');
            input.style.removeProperty('background-color');
            input.style.removeProperty('border');
            input.style.removeProperty('box-shadow');
            input.style.removeProperty('color');
        });
    }

    function unlockFinancialFields() {
        [rateInput, quantityInput, costInput].forEach(input => {
            if (!input) return;
            input.readOnly = false;
            input.disabled = false;
            input.classList.remove('p2p-analytics-input-readonly');
            input.style.backgroundColor = '#fffbe6';
            input.style.color = '';
            input.style.border = '1px solid #f7a600';
            input.style.boxShadow = '0 0 0 2px rgba(247,166,0,0.15)';
        });
    }

    // ── Обработчик чекбокса РЕДАКТИРОВАНИЕ ───────────────────────────────────
    editCheckbox.addEventListener('change', () => {
        if (editCheckbox.checked) {
            unlockFinancialFields();
        } else {
            lockFinancialFields();
            waitAndFillReceiptInputs(rateInput, quantityInput, costInput);
        }
    });

    // ── Обработчик чекбокса ЧЕК ──────────────────────────────────────────────
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
            conditionalInputs.style.display = 'block';
        } else {
            conditionalInputs.style.display = 'none';
        }
    });

    let receiptExists = false;

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

    Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {

        if (orderResult.success && orderResult.exists && orderResult.data && orderResult.data.receipt) {
            // ── Чек уже пробит — всё только для чтения ───────────────────────
            receiptExists = true;
            checkbox.checked = true;
            checkbox.disabled = true;
            checkbox.classList.add('p2p-analytics-checkbox-disabled');

            editCheckbox.disabled = true;
            editCheckbox.classList.add('p2p-analytics-checkbox-disabled');

            successMessage.style.display = 'block';
            conditionalInputs.style.display = 'block';
            conditionalInputs.style.opacity = '0.7';
            conditionalInputs.style.pointerEvents = 'none';
            conditionalInputs.style.filter = 'grayscale(100%)';

            const receipt = orderResult.data.receipt;

            const lockStyle = (input) => {
                input.style.backgroundColor = '#333';
                input.style.color = '#aaa';
                input.style.border = '1px solid #444';
            };

            if (contactInput) {
                contactInput.value = receipt.contact || '';
                contactInput.readOnly = true;
                contactInput.disabled = true;
                contactInput.classList.add('p2p-analytics-input-readonly');
                lockStyle(contactInput);
            }
            if (rateInput) {
                rateInput.value = (receipt.price !== null && receipt.price !== undefined) ? receipt.price : '';
                rateInput.readOnly = true;
                rateInput.disabled = true;
                rateInput.classList.add('p2p-analytics-input-readonly');
                lockStyle(rateInput);
            }
            if (quantityInput) {
                quantityInput.value = (receipt.amount !== null && receipt.amount !== undefined) ? receipt.amount : '';
                quantityInput.readOnly = true;
                quantityInput.disabled = true;
                quantityInput.classList.add('p2p-analytics-input-readonly');
                lockStyle(quantityInput);
            }
            if (costInput) {
                costInput.value = (receipt.sum !== null && receipt.sum !== undefined) ? receipt.sum : '';
                costInput.readOnly = true;
                costInput.disabled = true;
                costInput.classList.add('p2p-analytics-input-readonly');
                lockStyle(costInput);
            }

            console.log('P2P Analytics: Receipt already exists, showing readonly data');

        } else if (!hasCredentials) {
            // ── Нет учётных данных Эвотор ─────────────────────────────────────
            checkbox.disabled = true;
            checkbox.classList.add('p2p-analytics-checkbox-disabled');
            editCheckbox.disabled = true;
            editCheckbox.classList.add('p2p-analytics-checkbox-disabled');
            warningMessage.style.display = 'block';
            console.log('P2P Analytics: Checkbox disabled - evotor credentials not filled');

        } else {
            // ── Нормальный режим ──────────────────────────────────────────────
            checkbox.checked = true;
            editCheckbox.checked = false;
            conditionalInputs.style.display = 'block';

            // Восстанавливаем isManual из БД
            if (orderResult.success && orderResult.exists && orderResult.data && orderResult.data.isManual) {
                editCheckbox.checked = true;
                unlockFinancialFields();
                // Данные из БД приоритетнее страницы
                if (rateInput && orderResult.data.price) rateInput.value = orderResult.data.price;
                if (quantityInput && orderResult.data.quantity) quantityInput.value = orderResult.data.quantity;
                if (costInput && orderResult.data.amount) costInput.value = orderResult.data.amount;
                console.log('P2P Analytics: Restored manualEdit=true from DB');
            } else {
                lockFinancialFields();
                waitAndFillReceiptInputs(rateInput, quantityInput, costInput);
            }

            // Контакт всегда доступен
            if (contactInput) {
                contactInput.readOnly = false;
                contactInput.disabled = false;
                contactInput.classList.remove('p2p-analytics-input-readonly');
                contactInput.value = generateRandomGmail();
            }

            console.log('P2P Analytics: Normal mode — check ON, edit restored from DB');
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
    
    submitButton.addEventListener('click', (event) => {
        event.preventDefault();
        handleFormSubmission();
    });
    
    return submitButton;
}

function createDeleteOrderButton() {
    const deleteButton = document.createElement('button');
    deleteButton.className = 'p2p-analytics-delete-button';
    deleteButton.textContent = 'Удалить ордер';
    deleteButton.style.marginTop = '8px';
    deleteButton.style.display = 'none';

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
let isInitializing = false;
let currentUrl = window.location.href;
let urlWatchInterval = null; 

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

    const urlPattern = /bybit\.com.*\/orderList\/\d+/;
    const isCorrectPage = urlPattern.test(window.location.href) || isMerchantAdminPage();
    if (!isCorrectPage) return false;

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
    // Reset ephemeral SELL real name (Verified) on navigation
    currentSellRealNameTemp = '';
    originalCounterpartyNickname = '';
    originalCounterpartyRealName = '';
    // Reset captured BUY original name on navigation
    originalBuyName = '';
    // Reset captured own name in SELL payment details on navigation
    originalOwnName = '';
}

// --- Updated Observer ---
function initializeMutationObserver() {
    if (observer) {
        observer.disconnect();
    }
    
    let debounceTimer = null;
    
    observer = new MutationObserver(async (mutationsList, obs) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        
        debounceTimer = setTimeout(async () => {
            // 1. Existing name replacement logic
            ensureOriginalBuyNameCaptured();
            applyDisplayNameIfNeeded();
            
            

            if (currentSellRealNameTemp) {
                document.querySelectorAll('.im-container-caption__info-verified').forEach(el => {
                    const nameContainer = el.querySelector('.moly-space-item.moly-space-item-last');
                    if (nameContainer && nameContainer.textContent.trim() !== currentSellRealNameTemp) {
                        nameContainer.textContent = currentSellRealNameTemp;
                    }
                });
                document.querySelectorAll('.chat-info__real-name').forEach(el => {
                    if (el.textContent.trim() !== currentSellRealNameTemp) {
                        el.textContent = currentSellRealNameTemp;
                    }
                });
            }

            // 2. Try to inject widget if chat appeared
            await createFloatingWidget();

        }, 100);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
    });
}
// --- Main Execution ---
async function initialize() {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('P2P Analytics: Already initializing, skipping...');
        return;
    }
    
    isInitializing = true; // Set lock

    try {
        console.log('P2P Analytics: Initializing extension...');
        console.log('P2P Analytics: Current URL:', window.location.href);
        
        // Check if we're on the right page
        const urlPattern = /bybit\.com.*\/orderList\/\d+/;
        const isCorrectPage = urlPattern.test(window.location.href) || isMerchantAdminPage();
        
        if (!isCorrectPage) {
            console.log('P2P Analytics: Not on order page, skipping initialization');
            cleanupResources();
            return;
        }
        
        // Check if auth helper is loaded
        if (!window.P2PAuth) {
            console.error('P2P Analytics: Auth helper not loaded, retrying...');
            setTimeout(() => {
                isInitializing = false;
                initialize();
            }, 1000);
            return;
        }
        
        // Check authentication status
        const isAuth = await window.P2PAuth.isAuthenticated();
        console.log('P2P Analytics: User authenticated:', isAuth);
        
        // ВАЖНО: Если не авторизован - прерываем инициализацию виджета
        if (!isAuth) {
            console.log('P2P Analytics: User not authenticated. Widget will NOT be shown.');
            cleanupResources(); // Убираем виджет если он был
            // Можно показать уведомление через window.P2PAuth.showAuthError, но виджет не рисуем
            return;
        }

        // Load display name logic
        // Load display name logic
        await loadDisplayNameFromStorage();
        ensureOriginalBuyNameCaptured();
        applyDisplayNameIfNeeded();

        // Если своё имя задано и мы на SELL — запускаем retry на случай если вкладыш реквизитов ещё не отрисован
        // Если своё имя задано — запускаем retry (без привязки к isSellPage — на BUY элемент просто не найдётся)
        if (currentDisplayName) {
            startOwnNameRetry(currentDisplayName);
        }
                
        // Initialize MutationObserver
        initializeMutationObserver();
        
        // Immediate attempt to inject widget
        await createFloatingWidget();

    } catch (error) {
        console.error('P2P Analytics: Initialization error:', error);
    } finally {
        isInitializing = false; // Release lock
    }
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

// Ensure URL watcher is running to catch SPA route changes
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

// Also listen for page navigation in SPAs
window.addEventListener('popstate', handleUrlChange);
window.addEventListener('hashchange', handleUrlChange);

// Patch History API
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
        console.warn('P2P Analytics: Failed to patch History API:', e);
    }
})();

// Clean up resources when leaving the page
window.addEventListener('beforeunload', () => {
    cleanupResources();
});

// Listen for auth/storage changes
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
                
                if (currentDisplayName) {
                    // Если имя УСТАНОВЛЕНО - применяем его немедленно
                    applyDisplayNameIfNeeded();
                } else {
                    // Если имя СБРОШЕНО (пустая строка) - восстанавливаем оригиналы немедленно
                    console.log('P2P Analytics: Name reset detected, restoring originals...');
                    
                    if (isBuyPage() && originalBuyName) {
                        replaceBuyTipsName(originalBuyName);
                        replacePayerNameInDom(originalBuyName);
                    }
                    
                    if (isSellPage() && originalOwnName) {
                        // Принудительно возвращаем сохраненное оригинальное имя
                        replaceOwnNameInPaymentMethod(originalOwnName);
                    }
                }
            }
        }
    });
}

// Listen for one-time SELL name application from popup
try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
        // Применить никнейм
        if (message && message.action === 'applySellName') {
            try {
                const name = (message.name || '').trim();
                if (!name) {
                    sendResponse({ success: false, error: 'Имя пустое' });
                    return;
                }

                let replaced = false;

                // Точный селектор никнейма в шапке чата
                document.querySelectorAll('.chat-info-details__nickname').forEach(el => {
                    // Захватываем оригинал ДО первой замены
                    if (!originalCounterpartyNickname) {
                        originalCounterpartyNickname = el.textContent.trim();
                    }
                    if (el.textContent.trim() !== name) {
                        console.log('P2P Analytics: меняем никнейм:', el.textContent.trim(), '→', name);
                        el.textContent = name;
                        replaced = true;
                    }
                });

                sendResponse({ success: true, replaced });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка' });
            }
            return true;
        }

        // Применить имя (Verified)
        if (message && message.action === 'applyRealName') {
            try {
                const name = (message.name || '').trim();
                if (!name) {
                    sendResponse({ success: false, error: 'Имя пустое' });
                    return;
                }
                currentSellRealNameTemp = name;

                let replaced = false;

                document.querySelectorAll('.im-container-caption__info-verified').forEach(el => {
                    const nameContainer = el.querySelector('.moly-space-item.moly-space-item-last');
                    if (nameContainer) {
                        // Захватываем оригинал ДО первой замены
                        if (!originalCounterpartyRealName) {
                            originalCounterpartyRealName = nameContainer.textContent.trim();
                        }
                        if (nameContainer.textContent.trim() !== name) {
                            console.log('P2P Analytics: меняем Verified имя:', nameContainer.textContent.trim(), '→', name);
                            nameContainer.textContent = name;
                            replaced = true;
                        }
                    }
                });

                document.querySelectorAll('.chat-info__real-name').forEach(el => {
                    // Захватываем оригинал ДО первой замены (если ещё не захвачен из verified-блока)
                    if (!originalCounterpartyRealName) {
                        originalCounterpartyRealName = el.textContent.trim();
                    }
                    if (el.textContent.trim() !== name) {
                        el.textContent = name;
                        replaced = true;
                    }
                });

                sendResponse({ success: true, replaced });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка' });
            }
            return true;
        }

        // Применить своё имя (Name в реквизитах на SELL)
        if (message && message.action === 'applyMyName') {
            try {
                const name = (message.name || '').trim();
                currentDisplayName = name;

                let replaced = false;
                if (name) {
                    replaced = replaceOwnNameInPaymentMethod(name);
                    if (!replaced) {
                        // Поле ещё не отрисовалось — пробуем повторно с интервалом
                        startOwnNameRetry(name);
                    }
                } else {
                    stopOwnNameRetry();
                }

                sendResponse({ success: true, replaced });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка' });
            }
            return true;
        }

        // Сбросить замены имён контрагента (никнейм + имя) — восстанавливаем оригиналы без перезагрузки
        if (message && message.action === 'resetCounterpartyNames') {
            try {
                // Восстанавливаем никнейм
                if (originalCounterpartyNickname) {
                    document.querySelectorAll('.chat-info-details__nickname').forEach(el => {
                        el.textContent = originalCounterpartyNickname;
                    });
                }

                // Восстанавливаем имя (Verified / real-name)
                if (originalCounterpartyRealName) {
                    document.querySelectorAll('.im-container-caption__info-verified').forEach(el => {
                        const nameContainer = el.querySelector('.moly-space-item.moly-space-item-last');
                        if (nameContainer) {
                            nameContainer.textContent = originalCounterpartyRealName;
                        }
                    });
                    document.querySelectorAll('.chat-info__real-name').forEach(el => {
                        el.textContent = originalCounterpartyRealName;
                    });
                }

                // Очищаем временные переменные, чтобы MutationObserver больше не переписывал DOM
                currentSellDisplayNameTemp = '';
                currentSellRealNameTemp = '';
                originalCounterpartyNickname = '';
                originalCounterpartyRealName = '';

                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка' });
            }
            return true;
        }

        // Сбросить своё имя (BUY + SELL) — вызывает существующую resetBuyDisplayName()
        if (message && message.action === 'resetBuyName') {
            try {
                resetBuyDisplayName();
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false, error: e?.message || 'Ошибка' });
            }
            return true;
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