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
    submitBtn.style.cssText = `
        width: 100%;
        padding: 12px;
        background-color: ${MEXC_PRIMARY_COLOR};
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        margin-bottom: 12px;
        transition: background-color 0.2s;
    `;

    submitBtn.addEventListener('mouseenter', () => {
        submitBtn.style.backgroundColor = '#096F48';
    });

    submitBtn.addEventListener('mouseleave', () => {
        submitBtn.style.backgroundColor = MEXC_PRIMARY_COLOR;
    });

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
    deleteBtn.style.cssText = `
        width: 100%;
        padding: 12px;
        background-color: #E94359;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        margin-bottom: 16px;
        transition: background-color 0.2s;
        display: none;
    `;

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

    deleteBtn.addEventListener('mouseenter', () => {
        deleteBtn.style.backgroundColor = '#D93850';
    });

    deleteBtn.addEventListener('mouseleave', () => {
        deleteBtn.style.backgroundColor = '#E94359';
    });

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
    const wrapper = document.createElement('div');
    wrapper.className = 'p2p-analytics-commission-wrapper';
    wrapper.style.cssText = `
        position: relative;
        margin-top: 12px;
    `;

    const inputGroup = document.createElement('div');
    inputGroup.style.cssText = `
        display: flex;
        align-items: center;
        border: 1px solid var(--elevation-3, #E5E7EB);
        border-radius: 4px;
        overflow: hidden;
        background: var(--bg-l0, white);
    `;

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.placeholder = 'Введите процент';
    input.className = 'p2p-analytics-commission-input';
    input.style.cssText = `
        flex: 1;
        padding: 10px 12px;
        border: none;
        outline: none;
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        background: var(--bg-l0, white);
    `;

    const suffixButton = document.createElement('button');
    suffixButton.className = 'p2p-analytics-suffix-text';
    suffixButton.textContent = '%';
    suffixButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
    suffixButton.style.cssText = `
        padding: 10px 16px;
        background: var(--elevation-3, #F3F4F6);
        border: none;
        border-left: 1px solid var(--elevation-3, #E5E7EB);
        cursor: pointer;
        font-size: 14px;
        color: var(--text-primary, #6B7280);
        min-width: 50px;
        transition: background-color 0.2s;
    `;

    suffixButton.addEventListener('mouseenter', () => {
        suffixButton.style.backgroundColor = 'var(--elevation-3, #E5E7EB)';
    });

    suffixButton.addEventListener('mouseleave', () => {
        suffixButton.style.backgroundColor = 'var(--elevation-3, #F3F4F6)';
    });

    const commissionMenu = document.createElement('div');
    commissionMenu.className = 'p2p-analytics-commission-menu';
    commissionMenu.style.cssText = `
        display: none;
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 4px;
        background: var(--bg-l0, white);
        border: 1px solid var(--elevation-3, #E5E7EB);
        border-radius: 4px;
        box-shadow: var(--shadow-s2-down, 0 4px 12px rgba(0, 0, 0, 0.15));
        z-index: 1000;
        min-width: 120px;
    `;

    const percentOption = document.createElement('div');
    percentOption.className = 'p2p-analytics-commission-menu-item';
    percentOption.textContent = '% (Процент)';
    percentOption.style.cssText = `
        padding: 10px 16px;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        transition: background-color 0.2s;
    `;

    const moneyOption = document.createElement('div');
    moneyOption.className = 'p2p-analytics-commission-menu-item';
    moneyOption.textContent = '₽ (Рубли)';
    moneyOption.style.cssText = `
        padding: 10px 16px;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        transition: background-color 0.2s;
    `;

    [percentOption, moneyOption].forEach(option => {
        option.addEventListener('mouseenter', () => {
            option.style.backgroundColor = 'var(--elevation-3, #F3F4F6)';
        });
        option.addEventListener('mouseleave', () => {
            option.style.backgroundColor = 'var(--bg-l0, white)';
        });
    });

    percentOption.onclick = (e) => {
        e.stopPropagation();
        suffixButton.textContent = '%';
        suffixButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
        input.placeholder = 'Введите процент';
        commissionMenu.style.display = 'none';
    };

    moneyOption.onclick = (e) => {
        e.stopPropagation();
        suffixButton.textContent = '₽';
        suffixButton.setAttribute('data-commission-type', COMMISSION_TYPE_MONEY);
        input.placeholder = 'Введите сумму в рублях';
        commissionMenu.style.display = 'none';
    };

    commissionMenu.appendChild(percentOption);
    commissionMenu.appendChild(moneyOption);

    suffixButton.onclick = (e) => {
        e.stopPropagation();
        const isVisible = commissionMenu.style.display === 'block';
        commissionMenu.style.display = isVisible ? 'none' : 'block';
    };

    document.addEventListener('click', () => {
        commissionMenu.style.display = 'none';
    });

    inputGroup.appendChild(input);
    inputGroup.appendChild(suffixButton);
    wrapper.appendChild(inputGroup);
    wrapper.appendChild(commissionMenu);

    return wrapper;
}

async function createUnifiedFormSection() {
    const formSection = document.createElement('div');
    formSection.className = 'p2p-analytics-form-section';
    formSection.style.cssText = `
        padding: 20px;
        background: var(--bg-l0, #ffffff);
        border-radius: 8px;
        box-shadow: var(--shadow-s1-down, 0px 2px 12px 0px rgba(0, 0, 0, .06));
    `;

    // Add submit button
    formSection.appendChild(createSubmitButton());

    // Add delete button
    formSection.appendChild(createDeleteOrderButton());

    // Add requisites title
    const requisitesTitle = document.createElement('h3');
    requisitesTitle.className = 'p2p-analytics-form-title';
    requisitesTitle.textContent = 'Реквизиты';
    requisitesTitle.style.cssText = `
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary, #1F2937);
    `;
    formSection.appendChild(requisitesTitle);

    // Create bank dropdown wrapper
    const buttonMenuWrapper = document.createElement('div');
    buttonMenuWrapper.style.position = 'relative';
    buttonMenuWrapper.style.width = '100%';

    const dropdownButton = document.createElement('button');
    dropdownButton.className = 'p2p-analytics-button';
    dropdownButton.style.cssText = `
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-l0, white);
        border: 1px solid var(--elevation-3, #E5E7EB);
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: border-color 0.2s;
    `;
    
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
    dropdownMenu.style.cssText = `
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: 4px;
        background: var(--bg-l0, white);
        border: 1px solid var(--elevation-3, #E5E7EB);
        border-radius: 4px;
        box-shadow: var(--shadow-s2-down, 0 4px 12px rgba(0, 0, 0, 0.15));
        max-height: 200px;
        overflow-y: auto;
        z-index: 1000;
    `;

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
            menuItem.style.cssText = `
                padding: 10px 16px;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-primary, #1F2937);
                transition: background-color 0.2s;
            `;

            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.backgroundColor = 'var(--elevation-3, #F3F4F6)';
            });

            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.backgroundColor = 'var(--bg-l0, white)';
            });

            menuItem.onclick = (e) => {
                e.stopPropagation();
                buttonTextSpan.textContent = bankDetail.name;
                buttonTextSpan.setAttribute('data-bank-id', bankDetail.id);
                dropdownMenu.style.display = 'none';
                dropdownButton.classList.remove('p2p-analytics-button-active');
            };
            dropdownMenu.appendChild(menuItem);
        });
    } else {
        buttonTextSpan.textContent = 'Ошибка загрузки банков';
        const errorItem = document.createElement('div');
        errorItem.textContent = 'Не удалось загрузить список банков';
        errorItem.style.cssText = `
            padding: 10px 16px;
            color: #E94359;
            font-size: 14px;
        `;
        dropdownMenu.appendChild(errorItem);
    }

    dropdownButton.onclick = (e) => {
        e.stopPropagation();
        const isVisible = dropdownMenu.style.display === 'block';
        dropdownMenu.style.display = isVisible ? 'none' : 'block';
        dropdownButton.style.borderColor = isVisible ? '#E5E7EB' : MEXC_PRIMARY_COLOR;
    };

    document.addEventListener('click', () => {
        dropdownMenu.style.display = 'none';
        dropdownButton.style.borderColor = '#E5E7EB';
    });

    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);
    formSection.appendChild(buttonMenuWrapper);

    // Add commission label and input
    const commissionLabel = document.createElement('label');
    commissionLabel.className = 'p2p-analytics-label';
    commissionLabel.textContent = 'Комиссия';
    commissionLabel.style.cssText = `
        display: block;
        margin-top: 12px;
        margin-bottom: 6px;
        font-size: 12px;
        color: var(--text-primary, #6B7280);
        font-weight: 500;
    `;
    formSection.appendChild(commissionLabel);

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
    dropdownContainer.style.cssText = `
        margin: 20px 0 0 0;
        padding: 0;
        background: transparent;
        width: 100%;
        box-sizing: border-box;
    `;

    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics MEXC: Dropdown menu created successfully');
    return dropdownContainer;
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
    separator.style.cssText = `
        height: 1px;
        background: var(--elevation-3, #EBEEF5);
        margin: 16px 0;
    `;
    return separator;
}

function createInput(labelText, inputId, placeholder) {
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'p2p-analytics-input-wrapper';
    inputWrapper.style.cssText = `
        margin-bottom: 12px;
    `;

    const label = document.createElement('label');
    label.className = 'p2p-analytics-label';
    label.textContent = labelText;
    label.style.cssText = `
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        color: var(--text-primary, #6B7280);
        font-weight: 500;
    `;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'p2p-analytics-input';
    input.id = inputId;
    input.placeholder = placeholder;
    input.style.cssText = `
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--elevation-3, #E5E7EB);
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        background: var(--bg-l0, white);
        outline: none;
        transition: border-color 0.2s;
        box-sizing: border-box;
    `;

    input.addEventListener('focus', () => {
        input.style.borderColor = MEXC_PRIMARY_COLOR;
    });

    input.addEventListener('blur', () => {
        input.style.borderColor = '#E5E7EB';
    });

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
    permanentInputs.style.cssText = `
        margin-bottom: 16px;
    `;

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
    checkboxWrapper.style.cssText = `
        display: flex;
        align-items: center;
        margin-bottom: 12px;
    `;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'p2p-analytics-checkbox';
    checkbox.id = 'check-checkbox';
    checkbox.style.cssText = `
        width: 16px;
        height: 16px;
        cursor: pointer;
        margin-right: 8px;
    `;

    const label = document.createElement('label');
    label.className = 'p2p-analytics-checkbox-label';
    label.htmlFor = 'check-checkbox';
    label.textContent = 'Чек';
    label.style.cssText = `
        font-size: 14px;
        color: var(--text-primary, #1F2937);
        cursor: pointer;
        user-select: none;
    `;

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    // Warning message
    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.cssText = `
        display: none;
        padding: 8px 12px;
        background: var(--web-color-functional-tint-orange-smooth, #FEF3CD);
        color: var(--web-color-functional-warning, #92400E);
        border-radius: 4px;
        font-size: 12px;
        margin-bottom: 12px;
    `;
    warningMessage.textContent = 'Чтобы пробить чек, заполните анкету';

    // Success message
    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.cssText = `
        display: none;
        padding: 8px 12px;
        background: #D1FAE5;
        color: #065F46;
        border-radius: 4px;
        font-size: 12px;
        margin-bottom: 12px;
    `;
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
    notification.className = 'p2p-analytics-notification';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#10B981' : '#E94359'};
        color: white;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        font-size: 14px;
        animation: slideIn 0.3s ease-out;
    `;
    
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
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
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(100%);
                opacity: 0;
            }
        }
        
        .p2p-analytics-commission-menu::-webkit-scrollbar {
            width: 6px;
        }
        
        .p2p-analytics-commission-menu::-webkit-scrollbar-thumb {
            background: #D1D5DB;
            border-radius: 3px;
        }
        
        .p2p-analytics-menu::-webkit-scrollbar {
            width: 6px;
        }
        
        .p2p-analytics-menu::-webkit-scrollbar-thumb {
            background: #D1D5DB;
            border-radius: 3px;
        }
        
        .p2p-analytics-input-readonly {
            background-color: #F3F4F6 !important;
            cursor: not-allowed !important;
        }
        
        .p2p-analytics-checkbox-disabled {
            cursor: not-allowed !important;
            opacity: 0.6;
        }
    `;
    
    if (document.head) {
        document.head.appendChild(style);
        console.log('P2P Analytics MEXC: Styles added');
    } else {
        console.warn('P2P Analytics MEXC: document.head not available yet');
    }
}

// Find the best insertion point and chat position info
function findInsertionPoint() {
    // Find the chat to get its position
    const chatSelectors = [
        '.desktop-order-chatroom',
        '[class*="orderImRight"]'
    ];
    
    let chatElement = null;
    for (const selector of chatSelectors) {
        chatElement = document.querySelector(selector);
        if (chatElement && chatElement.offsetHeight > 0) {
            console.log('P2P Analytics MEXC: Found chat element:', selector);
            break;
        }
    }
    
    // Find the content container to insert after
    const contentSelectors = [
        '.page_orderStatusContent__n28k5',
        '[class*="orderStatusContent"]'
    ];
    
    for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && element.offsetHeight > 0) {
            console.log('P2P Analytics MEXC: Found content container:', selector);
            return { 
                element, 
                chatElement,
                strategy: 'after-content-aligned-to-chat' 
            };
        }
    }
    
    return null;
}

// Insert menu after target element
async function insertMenuAfterTarget() {
    // MEXC specific: insert AFTER content block, aligned to chat column
    const insertionPoint = findInsertionPoint();
    
    if (!insertionPoint) {
        console.log('P2P Analytics MEXC: No suitable insertion point found');
        // Debug: log all major containers
        const containers = document.querySelectorAll('[class*="page_"], [class*="order"]');
        console.log('P2P Analytics MEXC: Found containers:', containers.length);
        containers.forEach((el, i) => {
            console.log(`Container ${i}:`, el.className, 'visible:', el.offsetHeight > 0);
        });
        return false;
    }
    
    const targetDiv = insertionPoint.element;
    const chatElement = insertionPoint.chatElement;
    console.log('P2P Analytics MEXC: Using insertion strategy:', insertionPoint.strategy);
    console.log('P2P Analytics MEXC: Target element height:', targetDiv.offsetHeight);

    // Check if menu already exists
    const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
    if (existingMenus.length > 0) {
        console.log('P2P Analytics MEXC: Menu already exists');
        for (let i = 1; i < existingMenus.length; i++) {
            existingMenus[i].remove();
        }
        return true;
    }
    
    if (isInitializing) {
        console.log('P2P Analytics MEXC: Menu creation already in progress');
        return false;
    }
    
    isInitializing = true;
    
    try {
        console.log('P2P Analytics MEXC: Creating dropdown menu...');
        const menuContainer = await createDropdownMenu();
        
        // Get chat position to align our container exactly under chat
        if (chatElement) {
            const chatRect = chatElement.getBoundingClientRect();
            const parentRect = targetDiv.parentNode.getBoundingClientRect();
            
            // Calculate right margin (distance from chat right edge to parent right edge)
            const marginRight = parentRect.right - chatRect.right;
            
            console.log('P2P Analytics MEXC: Chat width:', chatRect.width);
            console.log('P2P Analytics MEXC: Chat right:', chatRect.right);
            console.log('P2P Analytics MEXC: Parent right:', parentRect.right);
            console.log('P2P Analytics MEXC: Margin right:', marginRight);
            
            // Set container width same as chat, use same margins
            menuContainer.style.width = chatRect.width + 'px';
            menuContainer.style.maxWidth = chatRect.width + 'px';
            menuContainer.style.marginLeft = 'auto';
            menuContainer.style.marginRight = marginRight + 'px';
        }
        
        // Insert after the content container
        targetDiv.parentNode.insertBefore(menuContainer, targetDiv.nextSibling);
        console.log('P2P Analytics MEXC: Menu inserted after content, aligned to chat!');
        console.log('P2P Analytics MEXC: Menu element:', menuContainer);
        
        return true;
    } catch (error) {
        console.error('P2P Analytics MEXC: Error creating menu:', error);
        console.error('P2P Analytics MEXC: Error stack:', error.stack);
        return false;
    } finally {
        isInitializing = false;
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
            const insertionPoint = findInsertionPoint();
            
            if (insertionPoint) {
                const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
                if (existingMenus.length === 0) {
                    console.log('P2P Analytics MEXC: MutationObserver found insertion point via strategy:', insertionPoint.strategy);
                    if (await insertMenuAfterTarget()) {
                        console.log('P2P Analytics MEXC: Menu inserted via MutationObserver!');
                    }
                } else {
                    // Remove duplicates
                    for (let i = 1; i < existingMenus.length; i++) {
                        console.log('P2P Analytics MEXC: Removing duplicate menu via MutationObserver');
                        existingMenus[i].remove();
                    }
                }
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
        return false;
    }
    
    // Check if auth helper is loaded
    if (!window.P2PAuth) {
        console.error('P2P Analytics MEXC: Auth helper not loaded');
        return false;
    }
    
    console.log('P2P Analytics MEXC: Auth helper loaded successfully');
    
    // Check authentication
    const authData = await window.P2PAuth.getAuthData();
    if (!authData || !authData.token) {
        console.log('P2P Analytics MEXC: Not authenticated, skipping initialization');
        return false;
    }
    
    console.log('P2P Analytics MEXC: Authenticated, proceeding with initialization');
    
    // Load display name
    await loadDisplayNameFromStorage();
    
    // Initialize mutation observer
    initializeMutationObserver();
    
    // Try to insert menu immediately
    const menuInserted = await insertMenuAfterTarget();
    
    if (menuInserted) {
        console.log('P2P Analytics MEXC: Initialization successful');
        return true;
    }
    
    console.log('P2P Analytics MEXC: Menu not inserted yet, will retry');
    return false;
}

// Retry mechanism for initialization
let initRetryCount = 0;
const maxInitRetries = 10;

async function tryInitialize() {
    const success = await initialize();
    
    if (!success && initRetryCount < maxInitRetries) {
        initRetryCount++;
        console.log(`P2P Analytics MEXC: Retry ${initRetryCount}/${maxInitRetries}...`);
        setTimeout(tryInitialize, 1000);
    } else if (success) {
        console.log('P2P Analytics MEXC: Successfully initialized');
    } else {
        console.log('P2P Analytics MEXC: Max retries reached, giving up');
    }
}

// Wait for DOM ready and auth
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('P2P Analytics MEXC: DOM content loaded');
        addStyles(); // Add styles as soon as DOM is ready
        setTimeout(tryInitialize, 500);
    });
} else {
    console.log('P2P Analytics MEXC: DOM already loaded');
    addStyles(); // Add styles immediately if DOM already ready
    setTimeout(tryInitialize, 500);
}

// Handle URL changes (SPA navigation)
let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        console.log('P2P Analytics MEXC: URL changed to:', url);
        // Reset retry counter on URL change
        initRetryCount = 0;
        // Disconnect existing observer if any
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        setTimeout(tryInitialize, 1000);
    }
}).observe(document, { subtree: true, childList: true });

console.log('P2P Analytics MEXC: Script initialization complete');


