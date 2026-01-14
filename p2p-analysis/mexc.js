// P2P Analytics Content Script for MEXC
console.log('P2P Analytics MEXC: Content script loaded');
console.log('P2P Analytics MEXC: Script load time:', new Date().toISOString());
console.log('P2P Analytics MEXC: Current URL:', window.location.href);
console.log('P2P Analytics MEXC: Document ready state:', document.readyState);

// Exchange type constant for MEXC
const EXCHANGE_TYPE_MEXC = 3;

// Commission type constants are already declared in order_api.js
// COMMISSION_TYPE_PERCENT and COMMISSION_TYPE_MONEY are available globally

// UI color constants for MEXC
const MEXC_PRIMARY_COLOR = '#0B8E5A'; // MEXC green
const MEXC_GOLD_COLOR = '#F7A600';

// State variables
let observer = null;
let isInitializing = false;
let currentDisplayName = '';
let currentSellDisplayNameTemp = '';
let originalBuyName = '';
let currentUrl = window.location.href;
let urlWatchInterval = null;

// Load widget collapsed state from storage
let widgetCollapsed = false;
try {
    const storedState = localStorage.getItem('p2p-analytics-mexc-widget-collapsed');
    widgetCollapsed = storedState === 'true';
} catch (e) {
    // Ignore localStorage errors
}

// Helper functions
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
    // MEXC specific: check for "Buy USDT" or "Sell USDT" or similar
    // Multiple detection methods for maximum reliability
    
    const BUY_TOKENS = [
        'buy', 'купить', 'compra', 'acheter', 'comprar', 'kaufen', 'покупка', 'купити', 'mua', 'beli', 'شراء', '购买', '買入', '購入', 'zakup'
    ];
    const SELL_TOKENS = [
        'sell', 'продать', 'venta', 'vendre', 'venda', 'verkauf', 'продажа', 'продати', 'ban', 'jual', 'sat', 'satis', 'بيع', '出售', '賣出', '売却', 'sprzedaz'
    ];
    
    // Method 1: Check for .sell__UN0aC class (based on HTML structure)
    const sellClassEl = document.querySelector('.orderInfoStates_sell__UN0aC');
    if (sellClassEl) {
        console.log('P2P Analytics MEXC: Detected SELL via .orderInfoStates_sell__UN0aC class');
        return 'sell';
    }
    
    // Method 2: Check page title or header
    const pageHeaders = document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="header"]');
    for (const header of pageHeaders) {
        const text = normalizeText(header.textContent);
        const hasBuyToken = BUY_TOKENS.some(t => text.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => text.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics MEXC: Detected BUY via header:', header.textContent);
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics MEXC: Detected SELL via header:', header.textContent);
            return 'sell';
        }
    }
    
    // Method 3: Check order info section
    const orderInfoElements = document.querySelectorAll('[class*="orderInfo"], [class*="order-info"]');
    for (const el of orderInfoElements) {
        const text = normalizeText(el.textContent);
        const hasBuyToken = BUY_TOKENS.some(t => text.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => text.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics MEXC: Detected BUY via order info');
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics MEXC: Detected SELL via order info');
            return 'sell';
        }
    }
    
    // Method 4: Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const typeParam = urlParams.get('type');
    if (typeParam) {
        const normalizedType = normalizeText(typeParam);
        const hasBuyToken = BUY_TOKENS.some(t => normalizedType.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => normalizedType.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics MEXC: Detected BUY via URL parameter');
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics MEXC: Detected SELL via URL parameter');
            return 'sell';
        }
    }

    console.warn('P2P Analytics MEXC: Could not determine order type - all methods failed');
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

// Display name management
async function loadDisplayNameFromStorage() {
    try {
        const res = await chrome.storage.sync.get(['displayName']);
        currentDisplayName = res.displayName || '';
        return currentDisplayName;
    } catch (e) {
        console.warn('P2P Analytics MEXC: Failed to load display name:', e);
        currentDisplayName = '';
        return '';
    }
}

// Helper function to wait for order ID to appear in DOM
async function waitForOrderIdInDOM(maxAttempts = 20, delayMs = 300) {
    console.log('P2P Analytics MEXC: Waiting for order ID to appear in DOM...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`P2P Analytics MEXC: Attempt ${attempt}/${maxAttempts} to find order ID in DOM`);
        
        // Try URL parameter first (most reliable for MEXC)
        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('id');
        if (orderId && /^\w{15,30}$/.test(orderId)) {
            console.log('P2P Analytics MEXC: ✓ Order ID found in URL:', orderId);
            return String(orderId);
        }
        
        // Try to find in page elements
        const orderIdElements = document.querySelectorAll('[class*="orderNumber"], [class*="order-number"], [class*="orderId"], [class*="order-id"]');
        for (const el of orderIdElements) {
            const text = el.textContent || '';
            const match = text.match(/\b([a-zA-Z0-9]{15,30})\b/);
            if (match) {
                const potentialId = match[1];
                console.log('P2P Analytics MEXC: ✓ Order ID found in DOM via element:', potentialId);
                return String(potentialId);
            }
        }
        
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    console.warn('P2P Analytics MEXC: ⚠ Order ID not found in DOM after', maxAttempts, 'attempts');
    return null;
}

// Get order ID from page HTML (MEXC shows it in URL parameter)
// IMPORTANT: orderId MUST always remain a string to preserve precision
function getOrderIdFromUrl() {
    console.log('P2P Analytics MEXC: Attempting to extract order ID from page...');
    console.log('P2P Analytics MEXC: DOM ready state:', document.readyState);
    console.log('P2P Analytics MEXC: Current URL:', window.location.href);
    
    // Method 1: Extract from URL parameter (most reliable for MEXC)
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('id');
        
        if (orderId && /^\w{15,30}$/.test(orderId)) {
            console.log('P2P Analytics MEXC: ✓ Found valid order ID in URL parameter:', orderId);
            return String(orderId);
        }
    } catch (e) {
        console.error('P2P Analytics MEXC: Method 1 (URL parameter) exception:', e);
    }
    
    // Method 2: Look for order ID in page elements
    try {
        console.log('P2P Analytics MEXC: Method 2 - Searching in page elements...');
        const orderIdElements = document.querySelectorAll('[class*="orderNumber"], [class*="order-number"], [class*="orderId"], [class*="order-id"]');
        
        for (const el of orderIdElements) {
            const text = el.textContent || '';
            console.log('P2P Analytics MEXC: Checking element text:', text);
            
            // Look for alphanumeric ID (15-30 characters)
            const match = text.match(/\b([a-zA-Z0-9]{15,30})\b/);
            if (match) {
                const orderId = match[1];
                console.log('P2P Analytics MEXC: ✓ Found order ID via element search:', orderId);
                return String(orderId);
            }
        }
    } catch (e) {
        console.error('P2P Analytics MEXC: Method 2 (element search) exception:', e);
    }
    
    console.error('P2P Analytics MEXC: ✗ Could not extract order ID from HTML - all methods failed');
    return null;
}

// Async wrapper that waits for DOM to load before extracting order ID
async function getOrderId() {
    console.log('P2P Analytics MEXC: getOrderId() called - will wait for DOM to load');
    
    // First, wait for order ID to appear in DOM
    const orderIdFromDOM = await waitForOrderIdInDOM();
    if (orderIdFromDOM) {
        console.log('P2P Analytics MEXC: ✓ Successfully got order ID from DOM:', orderIdFromDOM);
        return orderIdFromDOM;
    }
    
    // If still not found, try immediate parsing
    const orderIdImmediate = getOrderIdFromUrl();
    if (orderIdImmediate) {
        console.log('P2P Analytics MEXC: ✓ Successfully got order ID from immediate parsing:', orderIdImmediate);
        return orderIdImmediate;
    }
    
    console.error('P2P Analytics MEXC: ✗ Failed to get order ID from both DOM wait and immediate parsing');
    return null;
}

// fetchBankDetails is available globally from order_api.js

// ============================================
// Screenshot Functions
// ============================================

/**
 * Capture screenshot of the current page
 * @returns {Promise<string>} - Data URL of the screenshot
 */
const captureScreenshot = async () => {
    try {
        console.log('P2P Analytics MEXC: Requesting screenshot from background script...');
        
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'captureScreenshot' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('P2P Analytics MEXC: Runtime error:', chrome.runtime.lastError);
                        reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
                    } else if (response && response.success) {
                        console.log('P2P Analytics MEXC: Screenshot captured successfully');
                        resolve(response.dataUrl);
                    } else {
                        const errorMsg = response?.error || 'Failed to capture screenshot';
                        console.error('P2P Analytics MEXC: Screenshot capture failed:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                }
            );
        });
    } catch (error) {
        console.error('P2P Analytics MEXC: Error in captureScreenshot function:', error);
        throw error;
    }
};

/**
 * Upload screenshot from data URL to server
 * @param {string} dataUrl - Data URL of the screenshot
 * @param {string} orderId - Order ID for filename
 * @returns {Promise<{success: boolean, error?: string}>}
 */
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
        const result = await window.P2PAuth.uploadScreenshot(blob, `mexc_${orderId}.png`);
        
        return result;
    } catch (error) {
        console.error('P2P Analytics MEXC: Error uploading screenshot:', error);
        
        // Show error to user
        window.P2PAuth.showAuthError(error.message);
        
        return {
            success: false,
            error: error.message
        };
    }
};

// ============================================
// API Wrappers
// ============================================

// Wrapper for checkOrderExists with MEXC exchange type using string ID endpoint
checkOrderExists = async (orderId) => {
    try {
        const authData = await window.P2PAuth.getAuthData();
        if (!authData || !authData.token) {
            return {
                success: false,
                error: 'Not authenticated'
            };
        }

        const url = `${window.P2PAuth.API_BASE_URL}/api/order/by-string-id?stringOrderId=${encodeURIComponent(orderId)}&exchangeType=${EXCHANGE_TYPE_MEXC}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authData.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
            return {
                success: true,
                exists: !!data,
                data: data || null
            };
        } else if (response.status === 404) {
            return {
                success: true,
                exists: false,
                data: null
            };
        } else {
            const errorData = await response.json().catch(() => ({}));
            return {
                success: false,
                error: errorData.message || `HTTP ${response.status}`
            };
        }
    } catch (error) {
        console.error('P2P Analytics MEXC: Error checking order:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

// Custom saveOrder for MEXC - server returns string ID instead of JSON
saveOrder = async (orderData) => {
    try {
        // Check if user is authenticated
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для сохранения заказа');
            return {
                success: false,
                error: 'Не авторизован'
            };
        }

        // Ensure stringOrderId is always a string
        if (orderData.stringOrderId) {
            orderData.stringOrderId = String(orderData.stringOrderId);
        }

        const response = await window.P2PAuth.makeAuthenticatedRequest(
            `${window.P2PAuth.API_BASE_URL}/api/order`,
            {
                method: 'POST',
                body: JSON.stringify(orderData)
            }
        );

        // Server returns plain string (order ID), not JSON
        const orderId = await response.text();
        
        return {
            success: true,
            orderId: orderId,
            message: 'Order saved successfully'
        };
    } catch (error) {
        console.error('P2P Analytics MEXC: Error saving order:', error);
        
        // Show error to user
        window.P2PAuth.showAuthError(error.message);
        
        return {
            success: false,
            error: error.message
        };
    }
};

// Wrapper for deleteOrder with MEXC exchange type - override global
deleteOrder = async (orderId) => {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_MEXC);
};

// UI creation functions
function createSubmitButton() {
    const submitBtn = document.createElement('button');
    submitBtn.className = 'p2p-analytics-submit-button';
    submitBtn.textContent = 'Сохранить заказ';

    submitBtn.onclick = async () => {
        const formData = collectFormData();
        
        // Validate required fields
        if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
            showNotification('Пожалуйста, выберите банк', 'error');
            return;
        }
        
        // Validate price, quantity, and amount - must not be 0 or null
        if (!formData.price || formData.price === 0) {
            showNotification('Ошибка: курс не может быть 0 или пустым', 'error');
            return;
        }
        
        if (!formData.quantity || formData.quantity === 0) {
            showNotification('Ошибка: количество не может быть 0 или пустым', 'error');
            return;
        }
        
        if (!formData.amount || formData.amount === 0) {
            showNotification('Ошибка: сумма не может быть 0 или пустой', 'error');
            return;
        }
        
        // createdAt now always uses current time if not found on page, so no validation needed
        
        if (!formData.type || formData.type === 'UNKNOWN') {
            showNotification('Не удалось определить тип заказа (покупка/продажа)', 'error');
            return;
        }
        
        // Wait for DOM to load and get order ID from HTML
        console.log('P2P Analytics MEXC: Getting order ID before submitting...');
        const orderId = await getOrderId();
        console.log('P2P Analytics MEXC: Order ID for submission:', orderId);
        
        if (!orderId) {
            showNotification('Ошибка: не найден ID заказа в HTML страницы', 'error');
            return;
        }

        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для отправки заказа');
            return;
        }

        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Отправка...';

        // Variable to store screenshot data URL
        let screenshotDataUrl = null;

        try {
            // Step 1: Capture screenshot
            submitBtn.textContent = 'Создание скриншота...';
            console.log('P2P Analytics MEXC: Capturing screenshot...');
            
            try {
                screenshotDataUrl = await captureScreenshot();
                console.log('P2P Analytics MEXC: Screenshot captured successfully');
            } catch (error) {
                console.error('P2P Analytics MEXC: Error capturing screenshot:', error);
                showNotification('Предупреждение: не удалось создать скриншот', 'error');
                // Continue with order submission even if screenshot fails
            }

            // Step 2: Check if order has existing receipt
            let existingReceipt = null;
            try {
                const existingOrderResult = await checkOrderExists(orderId);
                if (existingOrderResult.success && existingOrderResult.exists && 
                    existingOrderResult.data && existingOrderResult.data.receipt) {
                    existingReceipt = existingOrderResult.data.receipt;
                }
            } catch (error) {
                console.warn('P2P Analytics MEXC: Could not check existing order receipt:', error);
            }

            // Step 3: Prepare and save order data
            submitBtn.textContent = 'Сохранение заказа...';
            // IMPORTANT: Keep orderId as string to preserve precision
            // Numbers are sent as-is (JavaScript number type), Java should use Double or BigDecimal
            const orderData = {
                stringOrderId: String(orderId), // MEXC uses string order ID
                details: { id: formData.bankId },
                commission: formData.commission,
                commissionType: formData.commissionType,
                price: formData.price,      // курс (цена за единицу), до 8 знаков после запятой
                amount: formData.amount,     // стоимость в рублях (из costInput), до 8 знаков после запятой
                quantity: formData.quantity, // количество криптовалюты, до 8 знаков после запятой
                receipt: existingReceipt ? existingReceipt : (formData.hasReceipt ? formData.receipt : null),
                createdAt: formData.createdAt,
                type: formData.type,
                exchangeType: EXCHANGE_TYPE_MEXC // MEXC
            };

            const result = await saveOrder(orderData);

            if (result.success) {
                // Step 4: Upload screenshot if available
                if (screenshotDataUrl) {
                    submitBtn.textContent = 'Загрузка скриншота...';
                    console.log('P2P Analytics MEXC: Uploading screenshot...');
                    
                    try {
                        const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
                        
                        if (uploadResult.success) {
                            console.log('P2P Analytics MEXC: Screenshot uploaded successfully');
                        } else {
                            console.error('P2P Analytics MEXC: Error uploading screenshot:', uploadResult.error);
                            showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                        }
                    } catch (error) {
                        console.error('P2P Analytics MEXC: Error uploading screenshot:', error);
                        showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                    }
                }

                showNotification('Заказ успешно сохранён!', 'success');
                
                const deleteButton = document.querySelector('.p2p-analytics-delete-button');
                if (deleteButton) {
                    deleteButton.style.display = 'block';
                }
            } else {
                showNotification(`Ошибка: ${result.error}`, 'error');
            }
        } catch (error) {
            showNotification(`Ошибка: ${error.message}`, 'error');
        } finally {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        }
    };

    return submitBtn;
}

function createDeleteOrderButton() {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'p2p-analytics-delete-button';
    deleteBtn.textContent = 'Удалить заказ';
    deleteBtn.style.display = 'none'; // Initially hidden

    // Check if order exists and show button (async)
    (async () => {
        console.log('P2P Analytics MEXC: Checking if order exists for delete button...');
        const orderId = await getOrderId();
        console.log('P2P Analytics MEXC: Got order ID for delete button check:', orderId);
        
        if (orderId) {
            checkOrderExists(orderId).then(result => {
                if (result.success && result.exists) {
                    deleteBtn.style.display = 'block';
                    console.log('P2P Analytics MEXC: Order exists, showing delete button');
                }
            }).catch(error => {
                console.error('P2P Analytics MEXC: Error checking order existence:', error);
            });
        }
    })();

    deleteBtn.onclick = async () => {
        console.log('P2P Analytics MEXC: Delete button clicked, getting order ID...');
        const orderId = await getOrderId();
        console.log('P2P Analytics MEXC: Order ID for deletion:', orderId);
        
        if (!orderId) {
            showNotification('Ошибка: не найден ID заказа в HTML страницы', 'error');
            return;
        }

        const confirmed = confirm('Если вы допустили ошибку в ордере - не удаляйте его, а пробейте повторно, с корректными данными. Удаление ордера требуется только в случае, если был пробит ордер, не относящийся к деятельности ИП.');
        if (!confirmed) return;

        deleteBtn.disabled = true;
        const originalText = deleteBtn.textContent;
        deleteBtn.textContent = 'Удаление...';

        try {
            const result = await deleteOrder(orderId);
            
            if (result.success) {
                showNotification('Заказ успешно удалён!', 'success');
                
                // Reset form
                setTimeout(() => {
                    const detailsButton = document.querySelector('.p2p-analytics-button-text');
                    if (detailsButton) {
                        detailsButton.textContent = 'Выберите банк';
                        detailsButton.removeAttribute('data-bank-id');
                    }
                    
                    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
                    if (commissionInput) {
                        commissionInput.value = '';
                    }
                    
                    const receiptCheckbox = document.querySelector('#check-checkbox');
                    if (receiptCheckbox && !receiptCheckbox.disabled) {
                        receiptCheckbox.checked = false;
                        receiptCheckbox.dispatchEvent(new Event('change'));
                    }
                    
                    deleteBtn.style.display = 'none';
                }, 500);
            } else {
                showNotification(`Ошибка: ${result.error}`, 'error');
            }
        } catch (error) {
            showNotification(`Ошибка: ${error.message}`, 'error');
        } finally {
            deleteBtn.textContent = originalText;
            deleteBtn.disabled = false;
        }
    };

    return deleteBtn;
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
    input.name = `p2p-mexc-commission-${Date.now()}`; // Unique name to prevent autocomplete
    input.placeholder = 'Введите комиссию';
    input.autocomplete = 'new-password'; // Trick to disable autocomplete
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-lpignore', 'true'); // Ignore LastPass
    input.setAttribute('data-form-type', 'other'); // Prevent form detection

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

async function createUnifiedFormSection() {
    const formSection = document.createElement('div');
    formSection.className = 'p2p-analytics-form-section';

    // Add submit button
    formSection.appendChild(createSubmitButton());

    // Add delete button
    formSection.appendChild(createDeleteOrderButton());

    // Add requisites title
    const requisitesTitle = document.createElement('h3');
    requisitesTitle.className = 'p2p-analytics-form-title';
    requisitesTitle.textContent = 'Реквизиты';
    formSection.appendChild(requisitesTitle);

    // Create bank dropdown wrapper
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

    // Fetch bank details
    console.log('P2P Analytics MEXC: Fetching bank details...');
    const bankDetailsResult = await fetchBankDetails();
    
    if (bankDetailsResult.success && bankDetailsResult.data.length > 0) {
        buttonTextSpan.textContent = 'Выберите банк';
        console.log('P2P Analytics MEXC: Bank details loaded:', bankDetailsResult.data.length);
        
        bankDetailsResult.data.forEach(bankDetail => {
            const menuItem = document.createElement('div');
            menuItem.className = 'p2p-analytics-menu-item';
            menuItem.textContent = bankDetail.name;
            menuItem.setAttribute('data-bank-id', bankDetail.id);

            menuItem.onclick = (e) => {
                e.stopPropagation();
                buttonTextSpan.textContent = bankDetail.name;
                buttonTextSpan.setAttribute('data-bank-id', bankDetail.id);
                console.log(`${bankDetail.name} (ID: ${bankDetail.id}) selected`);
                dropdownMenu.style.display = 'none';
                dropdownButton.classList.remove('p2p-analytics-button-active');
            };
            dropdownMenu.appendChild(menuItem);
        });
    } else {
        buttonTextSpan.textContent = 'Ошибка загрузки банков';
        console.error('P2P Analytics MEXC: Failed to load bank details:', bankDetailsResult.error);
        
        const errorItem = document.createElement('div');
        errorItem.className = 'p2p-analytics-menu-item';
        errorItem.textContent = 'Не удалось загрузить список банков';
        errorItem.style.color = '#ff6b6b';
        errorItem.style.cursor = 'default';
        dropdownMenu.appendChild(errorItem);
    }

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

    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);
    formSection.appendChild(buttonMenuWrapper);

    // Add commission input with dropdown
    const commissionInputWrapper = createCommissionInput();
    formSection.appendChild(commissionInputWrapper);

    // Add separator
    const separator = createSeparator();
    formSection.appendChild(separator);

    // Add check section
    const checkContent = createCheckContent();
    formSection.appendChild(checkContent);

    // Pre-populate if order exists (async)
    (async () => {
        console.log('P2P Analytics MEXC: Getting order ID for pre-population...');
        const orderId = await getOrderId();
        console.log('P2P Analytics MEXC: Order ID for pre-population:', orderId);
        
        if (orderId) {
            checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                console.log('P2P Analytics MEXC: Order exists, pre-populating:', order);
                
                if (order.details) {
                    const matchingBank = bankDetailsResult.data?.find(bd => bd.id === order.details.id);
                    if (matchingBank) {
                        buttonTextSpan.textContent = matchingBank.name;
                        buttonTextSpan.setAttribute('data-bank-id', order.details.id);
                    }
                }
                
                if (order.commission !== null && order.commission !== undefined) {
                    const commissionInput = formSection.querySelector('.p2p-analytics-commission-input');
                    if (commissionInput) {
                        commissionInput.value = order.commission;
                    }
                }
                
                if (order.commissionType) {
                    const commissionTypeButton = formSection.querySelector('.p2p-analytics-suffix-text');
                    const commissionInput = formSection.querySelector('.p2p-analytics-commission-input');
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
                    }
                }
            }
        }).catch(error => {
            console.error('P2P Analytics MEXC: Error checking order:', error);
        });
        }
    })();

    return formSection;
}

async function createDropdownMenu() {
    console.log('P2P Analytics MEXC: Creating dropdown menu...');
    
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'p2p-analytics-dropdown-container';

    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics MEXC: Dropdown menu created successfully');
    return dropdownContainer;
}

// Create floating widget similar to Bybit
async function createFloatingWidget() {
    // Check if widget already exists
    const existingWidget = document.querySelector('.p2p-analytics-widget--mexc');
    if (existingWidget) {
        console.log('P2P Analytics MEXC: Widget already exists');
        return true;
    }
    
    // Double-check that we're not in the middle of creating a widget
    if (isInitializing) {
        console.log('P2P Analytics MEXC: Widget creation already in progress, skipping...');
        return false;
    }
    
    isInitializing = true;
    
    try {
        console.log('P2P Analytics MEXC: Creating floating widget...');
        
        // Create main widget container
        const widget = document.createElement('div');
        widget.className = 'p2p-analytics-widget p2p-analytics-widget--mexc';
        
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
                localStorage.setItem('p2p-analytics-mexc-widget-collapsed', widgetCollapsed.toString());
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
        
        console.log('P2P Analytics MEXC: Floating widget created successfully!');
        
        return true;
    } catch (error) {
        console.error('P2P Analytics MEXC: Error creating widget:', error);
        return false;
    } finally {
        isInitializing = false;
    }
}

function cleanupResources() {
    console.log('P2P Analytics MEXC: Cleaning up resources...');
    
    // Disconnect observer
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    
    // Remove existing widget
    const existingWidget = document.querySelector('.p2p-analytics-widget--mexc');
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

// parseNumberOrNull, generateRandomGmail, truncateToDecimals are available globally from order_api.js

/**
 * MEXC-specific number extraction - handles European decimal format (comma as decimal separator)
 * MEXC always uses comma as decimal separator (e.g., "45,977" = 45.977)
 * @param {string} text - Text containing number
 * @returns {number|null}
 */
function extractNumberMEXC(text) {
    if (!text) return null;
    
    // Remove all spaces (including non-breaking spaces) and currency labels
    const cleaned = text
        .replace(/\s+/g, '')
        .replace(/\u00A0/g, '')
        .replace(/USDT|BTC|ETH|RUB|USD|EUR/gi, '');
    
    // Match number with possible separators
    const match = cleaned.match(/[\d.,]+/);
    if (!match) return null;
    
    let numberStr = match[0];
    
    // MEXC uses European format:
    // - Space or period as thousands separator (e.g., "4 000" or "4.000")
    // - Comma as decimal separator (e.g., "45,977")
    
    // Count occurrences of each separator
    const commaCount = (numberStr.match(/,/g) || []).length;
    const periodCount = (numberStr.match(/\./g) || []).length;
    
    console.log('P2P Analytics MEXC [extractNumberMEXC] input:', text, '→ numberStr:', numberStr, '→ commas:', commaCount, 'periods:', periodCount);
    
    if (commaCount > 0 && periodCount > 0) {
        // Both separators present - European format: period = thousands, comma = decimal
        // Example: "1.234,56" → 1234.56
        numberStr = numberStr.replace(/\./g, '').replace(/,/g, '.');
    } else if (commaCount > 0) {
        // Only comma present - it's ALWAYS the decimal separator in MEXC (European format)
        // Example: "45,977" → 45.977, "457,317" → 457.317
        numberStr = numberStr.replace(/,/g, '.');
    } else if (periodCount > 1) {
        // Multiple periods - they are thousands separators (European style)
        // Example: "1.234.567" → 1234567
        numberStr = numberStr.replace(/\./g, '');
    }
    // If only one period - assume it's decimal separator (already correct format)
    
    console.log('P2P Analytics MEXC [extractNumberMEXC] after replacement:', numberStr);
    
    const num = parseFloat(numberStr);
    const result = isFinite(num) ? num : null;
    console.log('P2P Analytics MEXC [extractNumberMEXC] final result:', result);
    return result;
}

// Parse order info from MEXC page
function parseOrderInfo() {
    const orderInfo = {};
    
    // Try to find order date
    let dateFound = false;
    try {
        // Look for date in time elements or timestamps
        const timeElements = document.querySelectorAll('time, [class*="time"], [class*="date"]');
        for (const el of timeElements) {
            const text = el.textContent || '';
            // Try different date formats
            const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
            if (dateMatch) {
                const parsedDate = new Date(dateMatch[1]);
                orderInfo.createdAt = parsedDate.toISOString();
                console.log('P2P Analytics MEXC: Parsed order date from page:', orderInfo.createdAt);
                dateFound = true;
                break;
            }
        }
    } catch (e) {
        console.warn('P2P Analytics MEXC: Error parsing date:', e);
    }
    
    // If date not found, use current time
    if (!dateFound) {
        orderInfo.createdAt = new Date().toISOString();
        console.log('P2P Analytics MEXC: Using current time as order date:', orderInfo.createdAt);
    }
    
    // Determine order type from page
    orderInfo.type = detectOrderType().toUpperCase();
    console.log('P2P Analytics MEXC: Order type:', orderInfo.type);
    
    return orderInfo;
}

// Parse price from MEXC page based on provided HTML structure
function parsePriceFromPage() {
    try {
        console.log('P2P Analytics MEXC: Parsing price from page...');
        
        // Strategy: Find all <p> tags and look for one containing "Цена" or "Price"
        // Then get the value from the sibling element
        const allParagraphs = document.querySelectorAll('p');
        
        for (const p of allParagraphs) {
            const text = normalizeText(p.textContent || '');
            
            // Check if this paragraph contains "price" in any language
            if (/цена|price|precio|prix|preço|preis/i.test(text)) {
                // Try to find the value in the parent container
                const container = p.parentElement;
                if (!container) continue;
                
                // Look for a span that contains numbers (the price value)
                const spans = container.querySelectorAll('span');
                for (const span of spans) {
                    const spanText = span.textContent.trim();
                    // Skip if it's the currency label
                    if (/^(RUB|USD|EUR|USDT)$/i.test(spanText)) continue;
                    
                    const price = extractNumberMEXC(spanText);
                    if (price !== null && price > 0) {
                        console.log('P2P Analytics MEXC: Found price:', price);
                        return price.toString();
                    }
                }
            }
        }
        
        console.warn('P2P Analytics MEXC: Could not find price');
        return '';
    } catch (error) {
        console.error('P2P Analytics MEXC: Error parsing price:', error);
        return '';
    }
}

// Parse quantity from MEXC page based on provided HTML structure
function parseQuantityFromPage() {
    try {
        console.log('P2P Analytics MEXC: Parsing quantity from page...');
        
        // Strategy: Find all <p> tags and look for one containing "Количество" or "Quantity"
        // Then get the value from the sibling element
        const allParagraphs = document.querySelectorAll('p');
        
        for (const p of allParagraphs) {
            const text = normalizeText(p.textContent || '');
            
            // Check if this paragraph contains "quantity" or "amount" in any language
            if (/количество|quantity|cantidad|quantité|quantidade|menge|amount/i.test(text)) {
                // Try to find the value in the parent container
                const container = p.parentElement;
                if (!container) continue;
                
                // Look for a span that contains numbers and USDT (the quantity value)
                const spans = container.querySelectorAll('span');
                for (const span of spans) {
                    const spanText = span.textContent.trim();
                    // Skip if it's just the currency label
                    if (/^(USDT|BTC|ETH)$/i.test(spanText)) continue;
                    
                    // Look for spans containing USDT (crypto quantity)
                    if (/USDT|BTC|ETH/i.test(spanText)) {
                        console.log('P2P Analytics MEXC [parseQuantityFromPage] processing span:', spanText);
                        const quantity = extractNumberMEXC(spanText);
                        if (quantity !== null && quantity > 0) {
                            // Don't truncate quantity - keep full precision
                            const stringResult = quantity.toString();
                            console.log('P2P Analytics MEXC [parseQuantityFromPage] quantity:', quantity, '→ string:', stringResult);
                            return stringResult;
                        }
                    }
                }
            }
        }
        
        console.warn('P2P Analytics MEXC: Could not find quantity');
        return '';
    } catch (error) {
        console.error('P2P Analytics MEXC: Error parsing quantity:', error);
        return '';
    }
}

// Parse amount from MEXC page based on provided HTML structure
function parseAmountFromPage() {
    try {
        console.log('P2P Analytics MEXC: Parsing amount from page...');
        
        // Strategy: Find all <p> tags and look for one containing "Сумма" or "Amount"
        // Then get the value from the sibling element
        const allParagraphs = document.querySelectorAll('p');
        
        for (const p of allParagraphs) {
            const text = normalizeText(p.textContent || '');
            
            // Check if this paragraph contains "amount" or "sum" in any language
            // Important: we want the FIAT amount (RUB), not crypto quantity
            if (/сумма|amount|suma|montant|betrag|total/i.test(text) && !/количество|quantity/i.test(text)) {
                // Try to find the value in the parent container
                const container = p.parentElement;
                if (!container) continue;
                
                // Look for a span that contains numbers and RUB (the fiat amount)
                const spans = container.querySelectorAll('span');
                for (const span of spans) {
                    const spanText = span.textContent.trim();
                    // Skip if it's just the currency label
                    if (/^(RUB|USD|EUR)$/i.test(spanText)) continue;
                    
                    // Look for spans containing RUB or other fiat currency
                    if (/RUB|USD|EUR/i.test(spanText)) {
                        const amount = extractNumberMEXC(spanText);
                        if (amount !== null && amount > 0) {
                            console.log('P2P Analytics MEXC: Found amount:', amount);
                            return amount.toString();
                        }
                    }
                }
            }
        }
        
        console.warn('P2P Analytics MEXC: Could not find amount');
        return '';
    } catch (error) {
        console.error('P2P Analytics MEXC: Error parsing amount:', error);
        return '';
    }
}

// checkEvotorCredentials is available globally from order_api.js

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'p2p-analytics-separator';
    return separator;
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
    input.name = `p2p-mexc-${inputId}-${Date.now()}`; // Unique name to prevent autocomplete
    input.placeholder = placeholder;
    input.autocomplete = 'new-password'; // Trick to disable autocomplete
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-lpignore', 'true'); // Ignore LastPass
    input.setAttribute('data-form-type', 'other'); // Prevent form detection

    inputWrapper.appendChild(label);
    inputWrapper.appendChild(input);

    return inputWrapper;
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

    // MEXC специфично: всегда показываем поля Курс, Количество и Стоимость
    const permanentInputs = document.createElement('div');
    permanentInputs.className = 'p2p-analytics-permanent-inputs';

    const rateInputWrapper = createInput('Курс', 'rate-input', 'Введите курс');
    const rateInput = rateInputWrapper.querySelector('#rate-input');
    permanentInputs.appendChild(rateInputWrapper);

    const quantityInputWrapper = createInput('Количество', 'quantity-input', 'Введите количество');
    const quantityInput = quantityInputWrapper.querySelector('#quantity-input');
    permanentInputs.appendChild(quantityInputWrapper);

    const costInputWrapper = createInput('Стоимость', 'cost-input', 'Введите стоимость');
    const costInput = costInputWrapper.querySelector('#cost-input');
    permanentInputs.appendChild(costInputWrapper);

    checkContent.appendChild(permanentInputs);

    // Separator before checkbox
    const separator = createSeparator();
    checkContent.appendChild(separator);

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

    // Conditional inputs container (только для контакта)
    const conditionalInputs = document.createElement('div');
    conditionalInputs.className = 'p2p-analytics-conditional-inputs';
    conditionalInputs.style.display = 'none';

    const contactInputWrapper = createInput('Контакт', 'contact-input', 'Введите контакт');
    const contactInput = contactInputWrapper.querySelector('#contact-input');

    conditionalInputs.appendChild(contactInputWrapper);
    
    checkContent.appendChild(checkboxWrapper);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    let receiptExists = false;

    // Check order receipt and evotor credentials (async)
    (async () => {
        console.log('P2P Analytics MEXC: Getting order ID for receipt check...');
        const orderId = await getOrderId();
        console.log('P2P Analytics MEXC: Order ID for receipt check:', orderId);
        
        const orderCheckPromise = orderId 
            ? checkOrderExists(orderId).catch(() => ({ success: false, exists: false }))
            : Promise.resolve({ success: false, exists: false });
        
        const credentialsCheckPromise = checkEvotorCredentials().catch(() => false);

        Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
            // Всегда заполняем постоянные поля из страницы или существующего ордера
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                
                // Заполняем постоянные поля из ордера (если есть)
                if (rateInput && order.price !== null && order.price !== undefined) {
                    rateInput.value = order.price;
                    console.log('P2P Analytics MEXC [Pre-populate] Set price from order:', order.price);
                } else {
                    const priceFromPage = parsePriceFromPage();
                    rateInput.value = priceFromPage;
                    console.log('P2P Analytics MEXC [Pre-populate] Set price from page:', priceFromPage);
                }
                
                // Заполняем quantityInput из order.quantity или со страницы
                if (quantityInput) {
                    if (order.quantity !== null && order.quantity !== undefined) {
                        quantityInput.value = order.quantity;
                        console.log('P2P Analytics MEXC [Pre-populate] Set quantity from order.quantity:', order.quantity);
                    } else {
                        const quantityFromPage = parseQuantityFromPage();
                        quantityInput.value = quantityFromPage;
                        console.log('P2P Analytics MEXC [Pre-populate] Set quantity from page:', quantityFromPage);
                    }
                }
                
                // Заполняем costInput из order.amount (стоимость в рублях) или со страницы
                if (costInput) {
                    if (order.amount !== null && order.amount !== undefined) {
                        costInput.value = order.amount;
                        console.log('P2P Analytics MEXC [Pre-populate] Set cost from order.amount:', order.amount);
                    } else {
                        const amountFromPage = parseAmountFromPage();
                        costInput.value = amountFromPage;
                        console.log('P2P Analytics MEXC [Pre-populate] Set cost from page:', amountFromPage);
                    }
                }
            } else {
                // Заполняем из страницы
                const priceFromPage = parsePriceFromPage();
                rateInput.value = priceFromPage;
                console.log('P2P Analytics MEXC [Pre-populate] Set price from page (no order):', priceFromPage);
                
                const quantityFromPage = parseQuantityFromPage();
                quantityInput.value = quantityFromPage;
                console.log('P2P Analytics MEXC [Pre-populate] Set quantity from page (no order):', quantityFromPage);
                
                // Заполняем costInput со страницы
                if (costInput) {
                    const amountFromPage = parseAmountFromPage();
                    costInput.value = amountFromPage;
                    console.log('P2P Analytics MEXC [Pre-populate] Set cost from page (no order):', amountFromPage);
                }
            }
            
            // Обработка чека
            if (orderResult.success && orderResult.exists && orderResult.data && orderResult.data.receipt) {
                receiptExists = true;
                checkbox.checked = true;
                checkbox.disabled = true;
                successMessage.style.display = 'block';
                conditionalInputs.style.display = 'block';
                
                const receipt = orderResult.data.receipt;
                
                if (contactInput && receipt.contact) {
                    contactInput.value = receipt.contact;
                    contactInput.readOnly = true;
                    contactInput.disabled = true;
                    contactInput.classList.add('p2p-analytics-input-readonly');
                }
                
                // costInput уже заполнен из order.amount выше, не блокируем его
            } else if (!hasCredentials) {
                checkbox.disabled = true;
                warningMessage.style.display = 'block';
            } else {
                // Ничего не делаем - чекбокс не отмечен, условные поля скрыты
            }
        });
    })();

    checkbox.addEventListener('change', () => {
        if (!receiptExists) {
            conditionalInputs.style.display = checkbox.checked ? 'block' : 'none';
            
            if (checkbox.checked) {
                if (contactInput) contactInput.value = generateRandomGmail();
            }
        }
    });

    return checkContent;
}

// Function to collect form data
function collectFormData() {
    const formData = {};
    
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    const selectedBankId = bankButton ? bankButton.getAttribute('data-bank-id') : null;
    
    formData.bank = bankButton ? bankButton.textContent : null;
    formData.bankId = selectedBankId ? parseInt(selectedBankId) : null;
    
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    formData.commission = commissionInput ? parseFloat(commissionInput.value) : null;
    formData.commissionType = commissionType ? commissionType.getAttribute('data-commission-type') || COMMISSION_TYPE_PERCENT : COMMISSION_TYPE_PERCENT;
    
    formData.screenshot = true;
    
    // MEXC специфично: всегда берем price, amount и quantity из постоянных полей
    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');
    
    const rateInputValue = rateInput ? rateInput.value : null;
    const quantityInputValue = quantityInput ? quantityInput.value : null;
    const costInputValue = costInput ? costInput.value : null;
    
    console.log('P2P Analytics MEXC [collectFormData] rateInput.value:', rateInputValue);
    console.log('P2P Analytics MEXC [collectFormData] quantityInput.value:', quantityInputValue);
    console.log('P2P Analytics MEXC [collectFormData] costInput.value:', costInputValue);
    
    formData.price = parseNumberOrNull(rateInputValue);
    formData.amount = parseNumberOrNull(costInputValue);  // amount = стоимость в рублях (из costInput)
    formData.quantity = parseNumberOrNull(quantityInputValue);  // quantity = количество криптовалюты
    
    console.log('P2P Analytics MEXC [collectFormData] parsed price:', formData.price);
    console.log('P2P Analytics MEXC [collectFormData] parsed amount:', formData.amount);
    console.log('P2P Analytics MEXC [collectFormData] parsed quantity:', formData.quantity);
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    if (formData.hasReceipt) {
        const contactInput = document.querySelector('#contact-input');
        
        formData.receipt = {
            contact: contactInput ? contactInput.value : '',
            price: formData.price,    // курс
            amount: formData.quantity, // количество криптовалюты
            sum: formData.amount,      // стоимость в рублях (уже взято из costInput выше)
        };
    }
    
    const orderInfo = parseOrderInfo();
    formData.createdAt = orderInfo.createdAt;
    formData.type = orderInfo.type;
    
    return formData;
}

// Notification system
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `p2p-analytics-notification p2p-analytics-notification--${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('p2p-analytics-notification--hide');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// Add animation styles (will be called after DOM ready)
function addStyles() {
    // Check if styles already added
    if (document.getElementById('p2p-analytics-mexc-styles')) {
        return;
    }
    
    const style = document.createElement('style');
    style.id = 'p2p-analytics-mexc-styles';
    style.textContent = `
        .p2p-analytics-notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            color: white;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 10001;
            font-size: 12px;
            animation: p2p-mexc-slideIn 0.3s ease-out;
        }
        
        .p2p-analytics-notification--success {
            background: #0B8E5A;
        }
        
        .p2p-analytics-notification--error {
            background: #E94359;
        }
        
        .p2p-analytics-notification--hide {
            animation: p2p-mexc-slideOut 0.3s ease-out forwards;
        }
        
        @keyframes p2p-mexc-slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        @keyframes p2p-mexc-slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(100%);
                opacity: 0;
            }
        }
    `;
    
    if (document.head) {
        document.head.appendChild(style);
        console.log('P2P Analytics MEXC: Styles added');
    } else {
        console.warn('P2P Analytics MEXC: document.head not available yet');
    }
}


// Mutation observer
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
            // Check if widget exists, create if not
            const existingWidget = document.querySelector('.p2p-analytics-widget--mexc');
            if (!existingWidget && !isInitializing) {
                console.log('P2P Analytics MEXC: MutationObserver - widget not found, creating...');
                await createFloatingWidget();
            }
        }, 100);
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
    });
}

// Initialize
async function initialize() {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('P2P Analytics MEXC: Already initializing, skipping...');
        return false;
    }
    
    console.log('P2P Analytics MEXC: Initializing extension...');
    console.log('P2P Analytics MEXC: Current URL:', window.location.href);
    
    // Check if we're on MEXC order page
    const urlPattern = /mexc\.com.*\/buy-crypto\/order-processing/;
    const isCorrectPage = urlPattern.test(window.location.href);
    
    // Exclude fiat-order-list page (list of all orders)
    const isListPage = /\/fiat-order-list/.test(window.location.href);
    console.log('P2P Analytics MEXC: On correct page:', isCorrectPage);
    console.log('P2P Analytics MEXC: Is list page (should skip):', isListPage);
    
    if (!isCorrectPage || isListPage) {
        console.log('P2P Analytics MEXC: Not on individual order page, skipping initialization');
        cleanupResources(); // Clean up widget if navigating away
        return false;
    }
    
    // Check if auth helper is loaded
    if (!window.P2PAuth) {
        console.error('P2P Analytics MEXC: Auth helper not loaded, retrying...');
        setTimeout(initialize, 1000);
        return false;
    }
    
    console.log('P2P Analytics MEXC: Auth helper loaded successfully');
    
    // Check authentication status
    try {
        const isAuth = await window.P2PAuth.isAuthenticated();
        console.log('P2P Analytics MEXC: User authenticated:', isAuth);
        
        if (!isAuth) {
            console.log('P2P Analytics MEXC: User not authenticated, showing auth error');
            window.P2PAuth.showAuthError('Необходимо авторизоваться для работы с расширением. Нажмите на иконку расширения для входа в систему.');
        }
    } catch (error) {
        console.error('P2P Analytics MEXC: Error checking authentication:', error);
    }
    
    // Load display name
    await loadDisplayNameFromStorage();
    
    // Clean up any existing resources
    cleanupResources();
    
    // Initialize mutation observer
    initializeMutationObserver();
    
    // Create floating widget
    const widgetCreated = await createFloatingWidget();
    
    if (widgetCreated) {
        console.log('P2P Analytics MEXC: Initialization successful');
        return true;
    }
    
    console.log('P2P Analytics MEXC: Widget not created yet, will retry');
    return false;
}

// --- Main Execution ---

// Handle different loading states
function handleDocumentReady() {
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('P2P Analytics MEXC: DOM content loaded');
            addStyles();
            initialize();
    });
} else {
        // DOM is already loaded
    console.log('P2P Analytics MEXC: DOM already loaded');
        addStyles();
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
        console.log('P2P Analytics MEXC: URL change detected, reinitializing...');
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
        console.warn('P2P Analytics MEXC: Failed to patch History API for URL changes:', e);
    }
})();

// Clean up resources when leaving the page
window.addEventListener('beforeunload', () => {
    cleanupResources();
});

// Listen for auth changes
if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'sync') {
            if (changes.authToken) {
                console.log('P2P Analytics MEXC: Auth token changed, reinitializing...');
                
                // If token was removed (user logged out)
                if (!changes.authToken.newValue && changes.authToken.oldValue) {
                    console.log('P2P Analytics MEXC: User logged out');
                    cleanupResources();
                    window.P2PAuth.showAuthError('Вы вышли из системы. Для работы с расширением необходимо авторизоваться заново.');
                }
                
                // If token was added (user logged in)
                if (changes.authToken.newValue && !changes.authToken.oldValue) {
                    console.log('P2P Analytics MEXC: User logged in, reinitializing...');
                    setTimeout(() => {
                        initialize();
                    }, 500);
                }
            }

            if (changes.displayName) {
                currentDisplayName = changes.displayName.newValue || '';
                console.log('P2P Analytics MEXC: Display name changed to:', currentDisplayName);
            }
        }
    });
}

// Debug function to manually test the extension
window.P2PAnalyticsMEXCDebug = {
    initialize: initialize,
    createWidget: createFloatingWidget,
    cleanupResources: cleanupResources,
    toggleWidget: () => {
        const widget = document.querySelector('.p2p-analytics-widget--mexc');
        if (widget) {
            widgetCollapsed = !widgetCollapsed;
            widget.classList.toggle('collapsed', widgetCollapsed);
            try {
                localStorage.setItem('p2p-analytics-mexc-widget-collapsed', widgetCollapsed.toString());
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
    }
};

console.log('P2P Analytics MEXC: Debug functions available at window.P2PAnalyticsMEXCDebug');
console.log('P2P Analytics MEXC: Script initialization complete');


