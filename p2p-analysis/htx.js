// P2P Analytics Content Script for HTX
console.log('P2P Analytics HTX: Content script loaded');
console.log('P2P Analytics HTX: Script load time:', new Date().toISOString());
console.log('P2P Analytics HTX: Current URL:', window.location.href);
console.log('P2P Analytics HTX: Document ready state:', document.readyState);

// Exchange type constant for HTX
const EXCHANGE_TYPE_HTX = 2;

// Commission type constants are already declared in order_api.js
// COMMISSION_TYPE_PERCENT and COMMISSION_TYPE_MONEY are available globally

// UI color constants for HTX
const HTX_PRIMARY_COLOR = '#0173E5'; // HTX blue
const HTX_GOLD_COLOR = '#F7A600';

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
    // HTX specific: check for "Buy USDT" or "Sell USDT" or similar
    // Multiple detection methods for maximum reliability
    
    const BUY_TOKENS = [
        'buy', 'купить', 'compra', 'acheter', 'comprar', 'kaufen', 'покупка', 'купити', 'mua', 'beli', 'شراء', '购买', '買入', '購入', 'zakup'
    ];
    const SELL_TOKENS = [
        'sell', 'продать', 'venta', 'vendre', 'venda', 'verkauf', 'продажа', 'продати', 'ban', 'jual', 'sat', 'satis', 'بيع', '出售', '賣出', '売却', 'sprzedaz'
    ];
    
    // Method 1: Check for dedicated .buy / .sell class elements (most reliable)
    const buyClassEl = document.querySelector('.buy');
    const sellClassEl = document.querySelector('.sell');
    
    if (buyClassEl && !sellClassEl) {
        console.log('P2P Analytics HTX: Detected BUY via .buy class:', buyClassEl.textContent);
        return 'buy';
    }
    if (sellClassEl && !buyClassEl) {
        console.log('P2P Analytics HTX: Detected SELL via .sell class:', sellClassEl.textContent);
        return 'sell';
    }
    
    // Method 2: Check .l-trade-title span (main title)
    const titleEl = document.querySelector('.l-trade-title .font16.text-space.font-bold.font-black');
    if (titleEl) {
        const titleText = normalizeText(titleEl.textContent);
        console.log('P2P Analytics HTX: Checking title:', titleEl.textContent);
        
        const hasBuyToken = BUY_TOKENS.some(t => titleText.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => titleText.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics HTX: Detected BUY via title');
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics HTX: Detected SELL via title');
            return 'sell';
        }
    }
    
    // Method 3: Check .direction p element (contains "Купить/Продать USDT")
    const directionEl = document.querySelector('.baseInfo .direction');
    if (directionEl) {
        const directionText = normalizeText(directionEl.textContent);
        console.log('P2P Analytics HTX: Checking direction:', directionEl.textContent);
        
        const hasBuyToken = BUY_TOKENS.some(t => directionText.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => directionText.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics HTX: Detected BUY via direction');
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics HTX: Detected SELL via direction');
            return 'sell';
        }
    }
    
    // Method 4: Check any element with .l-trade-title class
    const allTitleElements = document.querySelectorAll('.l-trade-title, .l-trade-title *');
    for (const el of allTitleElements) {
        const text = normalizeText(el.textContent);
        const hasBuyToken = BUY_TOKENS.some(t => text.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => text.includes(t));
        
        if (hasBuyToken && !hasSellToken) {
            console.log('P2P Analytics HTX: Detected BUY via fallback search:', el.className, '→', el.textContent);
            return 'buy';
        }
        if (hasSellToken && !hasBuyToken) {
            console.log('P2P Analytics HTX: Detected SELL via fallback search:', el.className, '→', el.textContent);
            return 'sell';
        }
    }

    console.warn('P2P Analytics HTX: Could not determine order type - all methods failed');
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
        console.warn('P2P Analytics HTX: Failed to load display name:', e);
        currentDisplayName = '';
        return '';
    }
}

// Helper function to wait for order ID to appear in DOM
async function waitForOrderIdInDOM(maxAttempts = 20, delayMs = 300) {
    console.log('P2P Analytics HTX: Waiting for order ID to appear in DOM...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`P2P Analytics HTX: Attempt ${attempt}/${maxAttempts} to find order ID in DOM`);
        
        // Try specific selectors first (most reliable)
        const selectors = [
            '.l-trade-title .pay-code-wrap .btnCopy[data-clipboard-text]',
            '.pay-code-wrap .btnCopy[data-clipboard-text]',
            '.l-trade-title .btnCopy[data-clipboard-text]',
            '.btnCopy[data-clipboard-text]' // fallback to any btnCopy
        ];
        
        for (const selector of selectors) {
            const copyButton = document.querySelector(selector);
            if (copyButton) {
                const orderId = copyButton.getAttribute('data-clipboard-text');
                if (orderId && /^\d{15,25}$/.test(orderId)) {
                    console.log('P2P Analytics HTX: ✓ Order ID found in DOM via', selector, ':', orderId);
                    return String(orderId);
                }
            }
        }
        
        // Also try text search in .l-trade-title
        const titleSection = document.querySelector('.l-trade-title');
        if (titleSection) {
            const allText = titleSection.textContent || '';
            const orderIdMatch = allText.match(/\b(\d{15,25})\b/);
            if (orderIdMatch) {
                const orderId = orderIdMatch[1];
                console.log('P2P Analytics HTX: ✓ Order ID found in DOM via text search:', orderId);
                return String(orderId);
            }
        }
        
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    console.warn('P2P Analytics HTX: ⚠ Order ID not found in DOM after', maxAttempts, 'attempts');
    return null;
}

// Get order ID from page HTML (HTX shows it in multiple places)
// IMPORTANT: orderId MUST always remain a string to preserve precision for large numbers
// Numbers like 1334714309250740224 exceed JavaScript's MAX_SAFE_INTEGER
function getOrderIdFromUrl() {
    console.log('P2P Analytics HTX: Attempting to extract order ID from page...');
    console.log('P2P Analytics HTX: DOM ready state:', document.readyState);
    console.log('P2P Analytics HTX: Current URL:', window.location.href);
    
    // Method 1: Look for .btnCopy with data-clipboard-text in .l-trade-title (most reliable and specific)
    // This is the primary location where order ID is shown with copy button
    // Example: <span class="btnCopy" data-clipboard-text="1334714309250740224">1334714309250740224</span>
    try {
        // Try multiple specific selectors for the order ID button
        const selectors = [
            '.l-trade-title .pay-code-wrap .btnCopy[data-clipboard-text]',
            '.pay-code-wrap .btnCopy[data-clipboard-text]',
            '.l-trade-title .btnCopy[data-clipboard-text]'
        ];
        
        for (const selector of selectors) {
            const copyButton = document.querySelector(selector);
            console.log('P2P Analytics HTX: Checking selector:', selector, '-> Found:', !!copyButton);
            
            if (copyButton) {
                const orderId = copyButton.getAttribute('data-clipboard-text');
                console.log('P2P Analytics HTX: data-clipboard-text value:', orderId);
                
                // Validate that it looks like an order ID (long numeric string)
                if (orderId && /^\d{15,25}$/.test(orderId)) {
                    console.log('P2P Analytics HTX: ✓ Found valid order ID via', selector, ':', orderId);
                    return String(orderId);
                } else {
                    console.log('P2P Analytics HTX: ✗ Invalid order ID format:', orderId);
                }
            }
        }
        
        // Last attempt: try all .btnCopy elements and validate each one
        console.log('P2P Analytics HTX: Trying all .btnCopy elements...');
        const copyButtons = document.querySelectorAll('.btnCopy[data-clipboard-text]');
        console.log('P2P Analytics HTX: Found', copyButtons.length, '.btnCopy elements');
        
        for (const btn of copyButtons) {
            const orderId = btn.getAttribute('data-clipboard-text');
            console.log('P2P Analytics HTX: Checking .btnCopy element, data-clipboard-text:', orderId);
            
            // Validate that it looks like an order ID (long numeric string)
            if (orderId && /^\d{15,25}$/.test(orderId)) {
                console.log('P2P Analytics HTX: ✓ Found valid order ID via .btnCopy:', orderId);
                return String(orderId);
            }
        }
    } catch (e) {
        console.error('P2P Analytics HTX: Method 1 (.btnCopy) exception:', e);
    }
    
    // Method 2: Look for "Номер" text followed by order ID in .l-trade-title
    try {
        console.log('P2P Analytics HTX: Method 2 - Searching for "Номер" text...');
        const titleSection = document.querySelector('.l-trade-title');
        
        if (titleSection) {
            const allText = titleSection.textContent || '';
            console.log('P2P Analytics HTX: .l-trade-title text content:', allText.substring(0, 200));
            
            // Look for "Номер ：" or similar followed by the order ID
            if (allText.includes('Номер') || allText.includes('номер')) {
                // Try to match with Chinese colon or regular colon
                const orderIdMatch = allText.match(/(?:Номер|номер)\s*[：:]\s*(\d{15,25})/i);
                if (orderIdMatch) {
                    const orderId = orderIdMatch[1];
                    console.log('P2P Analytics HTX: ✓ Found order ID via "Номер" text:', orderId);
                    return String(orderId);
                }
                
                // Also try without colon (in case format changes)
                const simpleMatch = allText.match(/(?:Номер|номер)\s*(\d{15,25})/i);
                if (simpleMatch) {
                    const orderId = simpleMatch[1];
                    console.log('P2P Analytics HTX: ✓ Found order ID via "Номер" text (no colon):', orderId);
                    return String(orderId);
                }
            }
        } else {
            console.log('P2P Analytics HTX: .l-trade-title not found');
        }
    } catch (e) {
        console.error('P2P Analytics HTX: Method 2 (Номер in .l-trade-title) exception:', e);
    }
    
    // Method 3: Search for any long numeric string in key areas - prioritize before URL
    try {
        console.log('P2P Analytics HTX: Method 3 - Searching in key areas...');
        const targetSelectors = [
            '.l-trade-title',
            '.l-trade-detail', 
            '.mobile-trade-info'
        ];
        
        for (const selector of targetSelectors) {
            const container = document.querySelector(selector);
            if (container) {
                const allText = container.textContent || '';
                console.log('P2P Analytics HTX: Checking', selector, '- text length:', allText.length);
                
                // Look for 15-25 digit numbers
                const orderIdMatch = allText.match(/\b(\d{15,25})\b/);
                if (orderIdMatch) {
                    const orderId = orderIdMatch[1];
                    console.log('P2P Analytics HTX: ✓ Found order ID via text search in', selector, ':', orderId);
                    return String(orderId);
                }
            } else {
                console.log('P2P Analytics HTX: Selector not found:', selector);
            }
        }
    } catch (e) {
        console.error('P2P Analytics HTX: Method 3 (text search) exception:', e);
    }
    
    console.error('P2P Analytics HTX: ✗ Could not extract order ID from HTML - all methods failed');
    console.log('P2P Analytics HTX: Available .l-trade-title elements:', document.querySelectorAll('.l-trade-title').length);
    console.log('P2P Analytics HTX: Available .btnCopy elements:', document.querySelectorAll('.btnCopy').length);
    console.log('P2P Analytics HTX: Page HTML sample:', document.body.innerHTML.substring(0, 500));
    
    return null;
}

// Async wrapper that waits for DOM to load before extracting order ID
async function getOrderId() {
    console.log('P2P Analytics HTX: getOrderId() called - will wait for DOM to load');
    
    // First, wait for order ID to appear in DOM
    const orderIdFromDOM = await waitForOrderIdInDOM();
    if (orderIdFromDOM) {
        console.log('P2P Analytics HTX: ✓ Successfully got order ID from DOM:', orderIdFromDOM);
        return orderIdFromDOM;
    }
    
    // If still not found, try immediate parsing
    const orderIdImmediate = getOrderIdFromUrl();
    if (orderIdImmediate) {
        console.log('P2P Analytics HTX: ✓ Successfully got order ID from immediate parsing:', orderIdImmediate);
        return orderIdImmediate;
    }
    
    console.error('P2P Analytics HTX: ✗ Failed to get order ID from both DOM wait and immediate parsing');
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
        console.log('P2P Analytics HTX: Requesting screenshot from background script...');
        
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'captureScreenshot' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('P2P Analytics HTX: Runtime error:', chrome.runtime.lastError);
                        reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
                    } else if (response && response.success) {
                        console.log('P2P Analytics HTX: Screenshot captured successfully');
                        resolve(response.dataUrl);
                    } else {
                        const errorMsg = response?.error || 'Failed to capture screenshot';
                        console.error('P2P Analytics HTX: Screenshot capture failed:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                }
            );
        });
    } catch (error) {
        console.error('P2P Analytics HTX: Error in captureScreenshot function:', error);
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
        const result = await window.P2PAuth.uploadScreenshot(blob, `htx_${orderId}.png`);
        
        return result;
    } catch (error) {
        console.error('P2P Analytics HTX: Error uploading screenshot:', error);
        
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

// Wrapper for checkOrderExists with HTX exchange type - override global
checkOrderExists = async (orderId) => {
    return window.P2POrderAPI.checkOrderExists(orderId, EXCHANGE_TYPE_HTX);
};

// saveOrder is available globally from order_api.js

// Wrapper for deleteOrder with HTX exchange type - override global
deleteOrder = async (orderId) => {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_HTX);
};

// UI creation functions
function createSubmitButton() {
    const submitBtn = document.createElement('button');
    submitBtn.className = 'p2p-analytics-submit-button';
    submitBtn.textContent = 'Сохранить заказ';
    submitBtn.style.cssText = `
        width: 100%;
        padding: 12px;
        background-color: ${HTX_PRIMARY_COLOR};
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
        submitBtn.style.backgroundColor = '#0165CC';
    });

    submitBtn.addEventListener('mouseleave', () => {
        submitBtn.style.backgroundColor = HTX_PRIMARY_COLOR;
    });

    submitBtn.onclick = async () => {
        const formData = collectFormData();
        
        // Validate required fields
        if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
            showNotification('Пожалуйста, выберите банк', 'error');
            return;
        }
        
        // createdAt now always uses current time if not found on page, so no validation needed
        
        if (!formData.type || formData.type === 'UNKNOWN') {
            showNotification('Не удалось определить тип заказа (покупка/продажа)', 'error');
            return;
        }
        
        // Wait for DOM to load and get order ID from HTML
        console.log('P2P Analytics HTX: Getting order ID before submitting...');
        const orderId = await getOrderId();
        console.log('P2P Analytics HTX: Order ID for submission:', orderId);
        
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
            console.log('P2P Analytics HTX: Capturing screenshot...');
            
            try {
                screenshotDataUrl = await captureScreenshot();
                console.log('P2P Analytics HTX: Screenshot captured successfully');
            } catch (error) {
                console.error('P2P Analytics HTX: Error capturing screenshot:', error);
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
                console.warn('P2P Analytics HTX: Could not check existing order receipt:', error);
            }

            // Step 3: Prepare and save order data
            submitBtn.textContent = 'Сохранение заказа...';
            // IMPORTANT: Keep orderId as string to preserve precision for large numbers
            const orderData = {
                orderId: String(orderId), // Explicitly convert to string to prevent precision loss
                details: { id: formData.bankId },
                commission: formData.commission,
                commissionType: formData.commissionType,
                receipt: existingReceipt ? existingReceipt : (formData.hasReceipt ? formData.receipt : null),
                createdAt: formData.createdAt,
                type: formData.type,
                exchangeType: EXCHANGE_TYPE_HTX // HTX
            };

            const result = await saveOrder(orderData);

            if (result.success) {
                // Step 4: Upload screenshot if available
                if (screenshotDataUrl) {
                    submitBtn.textContent = 'Загрузка скриншота...';
                    console.log('P2P Analytics HTX: Uploading screenshot...');
                    
                    try {
                        const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
                        
                        if (uploadResult.success) {
                            console.log('P2P Analytics HTX: Screenshot uploaded successfully');
                        } else {
                            console.error('P2P Analytics HTX: Error uploading screenshot:', uploadResult.error);
                            showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                        }
                    } catch (error) {
                        console.error('P2P Analytics HTX: Error uploading screenshot:', error);
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
        console.log('P2P Analytics HTX: Checking if order exists for delete button...');
        const orderId = await getOrderId();
        console.log('P2P Analytics HTX: Got order ID for delete button check:', orderId);
        
        if (orderId) {
            checkOrderExists(orderId).then(result => {
                if (result.success && result.exists) {
                    deleteBtn.style.display = 'block';
                    console.log('P2P Analytics HTX: Order exists, showing delete button');
                }
            }).catch(error => {
                console.error('P2P Analytics HTX: Error checking order existence:', error);
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
        console.log('P2P Analytics HTX: Delete button clicked, getting order ID...');
        const orderId = await getOrderId();
        console.log('P2P Analytics HTX: Order ID for deletion:', orderId);
        
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
        border: 1px solid #E5E7EB;
        border-radius: 4px;
        overflow: hidden;
        background: white;
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
        color: #1F2937;
    `;

    const suffixButton = document.createElement('button');
    suffixButton.className = 'p2p-analytics-suffix-text';
    suffixButton.textContent = '%';
    suffixButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
    suffixButton.style.cssText = `
        padding: 10px 16px;
        background: #F3F4F6;
        border: none;
        border-left: 1px solid #E5E7EB;
        cursor: pointer;
        font-size: 14px;
        color: #6B7280;
        min-width: 50px;
        transition: background-color 0.2s;
    `;

    suffixButton.addEventListener('mouseenter', () => {
        suffixButton.style.backgroundColor = '#E5E7EB';
    });

    suffixButton.addEventListener('mouseleave', () => {
        suffixButton.style.backgroundColor = '#F3F4F6';
    });

    const commissionMenu = document.createElement('div');
    commissionMenu.className = 'p2p-analytics-commission-menu';
    commissionMenu.style.cssText = `
        display: none;
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 4px;
        background: white;
        border: 1px solid #E5E7EB;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
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
        color: #1F2937;
        transition: background-color 0.2s;
    `;

    const moneyOption = document.createElement('div');
    moneyOption.className = 'p2p-analytics-commission-menu-item';
    moneyOption.textContent = '₽ (Рубли)';
    moneyOption.style.cssText = `
        padding: 10px 16px;
        cursor: pointer;
        font-size: 14px;
        color: #1F2937;
        transition: background-color 0.2s;
    `;

    [percentOption, moneyOption].forEach(option => {
        option.addEventListener('mouseenter', () => {
            option.style.backgroundColor = '#F3F4F6';
        });
        option.addEventListener('mouseleave', () => {
            option.style.backgroundColor = 'white';
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
        background: white;
        border-radius: 4px;
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
        color: #1F2937;
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
        background: white;
        border: 1px solid #E5E7EB;
        border-radius: 4px;
        font-size: 14px;
        color: #1F2937;
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
        background: white;
        border: 1px solid #E5E7EB;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        max-height: 200px;
        overflow-y: auto;
        z-index: 1000;
    `;

    // Fetch bank details
    console.log('P2P Analytics HTX: Fetching bank details...');
    const bankDetailsResult = await fetchBankDetails();
    
    if (bankDetailsResult.success && bankDetailsResult.data.length > 0) {
        buttonTextSpan.textContent = 'Выберите банк';
        console.log('P2P Analytics HTX: Bank details loaded:', bankDetailsResult.data.length);
        
        bankDetailsResult.data.forEach(bankDetail => {
            const menuItem = document.createElement('div');
            menuItem.className = 'p2p-analytics-menu-item';
            menuItem.textContent = bankDetail.name;
            menuItem.setAttribute('data-bank-id', bankDetail.id);
            menuItem.style.cssText = `
                padding: 10px 16px;
                cursor: pointer;
                font-size: 14px;
                color: #1F2937;
                transition: background-color 0.2s;
            `;

            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.backgroundColor = '#F3F4F6';
            });

            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.backgroundColor = 'white';
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
        dropdownButton.style.borderColor = isVisible ? '#E5E7EB' : HTX_PRIMARY_COLOR;
    };

    document.addEventListener('click', () => {
        dropdownMenu.style.display = 'none';
        dropdownButton.style.borderColor = '#E5E7EB';
    });

    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);
    formSection.appendChild(buttonMenuWrapper);

    // Add commission input
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
        console.log('P2P Analytics HTX: Getting order ID for pre-population...');
        const orderId = await getOrderId();
        console.log('P2P Analytics HTX: Order ID for pre-population:', orderId);
        
        if (orderId) {
            checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                console.log('P2P Analytics HTX: Order exists, pre-populating:', order);
                
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
            console.error('P2P Analytics HTX: Error checking order:', error);
        });
        }
    })();

    return formSection;
}

async function createDropdownMenu() {
    console.log('P2P Analytics HTX: Creating dropdown menu...');
    
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'p2p-analytics-dropdown-container';
    dropdownContainer.style.cssText = `
        margin: 16px 0;
        background: #F8FAFD;
        border-radius: 4px;
        border: 1px solid #EBEEF5;
    `;

    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics HTX: Dropdown menu created successfully');
    return dropdownContainer;
}

// parseNumberOrNull, generateRandomGmail, truncateToDecimals, extractNumber
// are all available globally from order_api.js

// Parse order info from HTX page
function parseOrderInfo() {
    const orderInfo = {};
    
    // Try to find order date - HTX shows it in various places
    let dateFound = false;
    try {
        // Look for date in order details
        const dateElements = document.querySelectorAll('.font-gray.flex-y-center.font12, .l-trade-title .font-gray');
        for (const el of dateElements) {
            const text = el.textContent || '';
            const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
            if (dateMatch) {
                const parsedDate = new Date(dateMatch[1]);
                orderInfo.createdAt = parsedDate.toISOString();
                console.log('P2P Analytics HTX: Parsed order date from page:', orderInfo.createdAt);
                dateFound = true;
                break;
            }
        }
    } catch (e) {
        console.warn('P2P Analytics HTX: Error parsing date:', e);
    }
    
    // If date not found, use current time
    if (!dateFound) {
        orderInfo.createdAt = new Date().toISOString();
        console.log('P2P Analytics HTX: Using current time as order date:', orderInfo.createdAt);
    }
    
    // Determine order type from page
    orderInfo.type = detectOrderType().toUpperCase();
    console.log('P2P Analytics HTX: Order type:', orderInfo.type);
    
    return orderInfo;
}

// Parse price from HTX page
function parsePriceFromPage() {
    try {
        console.log('P2P Analytics HTX: Parsing price from page...');
        
        // HTX shows price in .l-trade-coin section
        const priceElements = document.querySelectorAll('.coin-item');
        for (const item of priceElements) {
            const label = item.querySelector('.font12');
            if (label && /unit\s+price|цена|курс/i.test(label.textContent)) {
                const value = item.querySelector('.font-base.font16, .font16');
                if (value) {
                    const priceText = value.textContent.trim();
                    console.log('P2P Analytics HTX: Found price:', priceText);
                    const price = extractNumber(priceText);
                    if (price !== null) {
                        return price.toString();
                    }
                }
            }
        }
        
        console.warn('P2P Analytics HTX: Could not find price');
        return '';
    } catch (error) {
        console.error('P2P Analytics HTX: Error parsing price:', error);
        return '';
    }
}

// Parse quantity from HTX page
function parseQuantityFromPage() {
    try {
        console.log('P2P Analytics HTX: Parsing quantity from page...');
        
        const amountElements = document.querySelectorAll('.coin-item');
        for (const item of amountElements) {
            const label = item.querySelector('.font12');
            const value = item.querySelector('.font-base.font16, .font16');
            
            if (label && value) {
                const labelText = label.textContent.trim();
                const valueText = value.textContent.trim();
                
                // Look for crypto amount (USDT, BTC, etc.)
                if (/USDT|BTC|ETH|USDC/i.test(valueText)) {
                    console.log('P2P Analytics HTX: Found quantity:', valueText);
                    const quantity = extractNumber(valueText);
                    if (quantity !== null) {
                        return quantity.toString();
                    }
                }
            }
        }
        
        console.warn('P2P Analytics HTX: Could not find quantity');
        return '';
    } catch (error) {
        console.error('P2P Analytics HTX: Error parsing quantity:', error);
        return '';
    }
}

// Parse amount from HTX page
function parseAmountFromPage() {
    try {
        console.log('P2P Analytics HTX: Parsing amount from page...');
        
        const amountElements = document.querySelectorAll('.coin-item');
        for (const item of amountElements) {
            const label = item.querySelector('.font12');
            const value = item.querySelector('.font-blue.font16, .main-price');
            
            if (label && value) {
                const labelText = label.textContent.trim();
                const valueText = value.textContent.trim();
                
                // Look for fiat amount (RUB, USD, etc.)
                if (/amount|сумма|количество/i.test(labelText) && /RUB|USD|EUR/i.test(valueText)) {
                    console.log('P2P Analytics HTX: Found amount:', valueText);
                    const amount = extractNumber(valueText);
                    if (amount !== null) {
                        return amount.toString();
                    }
                }
            }
        }
        
        console.warn('P2P Analytics HTX: Could not find amount');
        return '';
    } catch (error) {
        console.error('P2P Analytics HTX: Error parsing amount:', error);
        return '';
    }
}

// checkEvotorCredentials is available globally from order_api.js

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'p2p-analytics-separator';
    separator.style.cssText = `
        height: 1px;
        background: #EBEEF5;
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
        color: #6B7280;
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
        border: 1px solid #E5E7EB;
        border-radius: 4px;
        font-size: 14px;
        color: #1F2937;
        outline: none;
        transition: border-color 0.2s;
        box-sizing: border-box;
    `;

    input.addEventListener('focus', () => {
        input.style.borderColor = HTX_PRIMARY_COLOR;
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
        color: #1F2937;
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
        background: #FEF3CD;
        color: #92400E;
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

    // Conditional inputs container
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
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    let receiptExists = false;

    // Check order receipt and evotor credentials (async)
    (async () => {
        console.log('P2P Analytics HTX: Getting order ID for receipt check...');
        const orderId = await getOrderId();
        console.log('P2P Analytics HTX: Order ID for receipt check:', orderId);
        
        const orderCheckPromise = orderId 
            ? checkOrderExists(orderId).catch(() => ({ success: false, exists: false }))
            : Promise.resolve({ success: false, exists: false });
        
        const credentialsCheckPromise = checkEvotorCredentials().catch(() => false);

        Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
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
            
            if (rateInput && receipt.price !== null && receipt.price !== undefined) {
                rateInput.value = receipt.price;
                rateInput.readOnly = true;
                rateInput.disabled = true;
                rateInput.classList.add('p2p-analytics-input-readonly');
            }
            
            if (quantityInput && receipt.amount !== null && receipt.amount !== undefined) {
                quantityInput.value = receipt.amount;
                quantityInput.readOnly = true;
                quantityInput.disabled = true;
                quantityInput.classList.add('p2p-analytics-input-readonly');
            }
            
            if (costInput && receipt.sum !== null && receipt.sum !== undefined) {
                costInput.value = receipt.sum;
                costInput.readOnly = true;
                costInput.disabled = true;
                costInput.classList.add('p2p-analytics-input-readonly');
            }
        } else if (!hasCredentials) {
            checkbox.disabled = true;
            warningMessage.style.display = 'block';
        } else {
            checkbox.checked = true;
            conditionalInputs.style.display = 'block';
            
            if (contactInput) contactInput.value = generateRandomGmail();
            if (rateInput) rateInput.value = parsePriceFromPage();
            if (quantityInput) quantityInput.value = parseQuantityFromPage();
            if (costInput) costInput.value = parseAmountFromPage();
        }
        });
    })();

    checkbox.addEventListener('change', () => {
        if (!receiptExists) {
            conditionalInputs.style.display = checkbox.checked ? 'block' : 'none';
            
            if (checkbox.checked) {
                if (contactInput) contactInput.value = generateRandomGmail();
                if (rateInput) rateInput.value = parsePriceFromPage();
                if (quantityInput) quantityInput.value = parseQuantityFromPage();
                if (costInput) costInput.value = parseAmountFromPage();
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
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    // Query receipt input elements (needed for both receipt and general form data)
    const contactInput = document.querySelector('#contact-input');
    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');
    
    if (formData.hasReceipt) {
        formData.receipt = {
            contact: contactInput ? contactInput.value : '',
            price: parseNumberOrNull(rateInput ? rateInput.value : null),
            amount: parseNumberOrNull(quantityInput ? quantityInput.value : null),
            sum: parseNumberOrNull(costInput ? costInput.value : null),
        };
    }
    
    const orderInfo = parseOrderInfo();
    formData.createdAt = orderInfo.createdAt;
    formData.type = orderInfo.type;

    formData.quantity = parseNumberOrNull(quantityInput ? quantityInput.value : null);
    formData.price = parseNumberOrNull(rateInput ? rateInput.value : null);
    formData.amount = parseNumberOrNull(costInput ? costInput.value : null);
    
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
    if (document.getElementById('p2p-analytics-htx-styles')) {
        return;
    }
    
    const style = document.createElement('style');
    style.id = 'p2p-analytics-htx-styles';
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
        console.log('P2P Analytics HTX: Styles added');
    } else {
        console.warn('P2P Analytics HTX: document.head not available yet');
    }
}

// Insert menu after target element
async function insertMenuAfterTarget() {
    // HTX specific selector: insert AFTER .l-trade-detail (order info block)
    // This places the extension UI below the order details but above the chat
    const targetSelectors = [
        '.l-trade-detail', // Order details section (primary target)
        '.l-trade-coin',   // Coin info section
        '.l-trade-status', // Status section
        '.l-trade-payment' // Payment section
    ];
    
    let targetDiv = null;
    let foundSelector = null;
    for (const selector of targetSelectors) {
        targetDiv = document.querySelector(selector);
        if (targetDiv) {
            foundSelector = selector;
            console.log('P2P Analytics HTX: Found target element:', selector);
            break;
        }
    }
    
    if (!targetDiv) {
        console.log('P2P Analytics HTX: Target element not found, trying all selectors...');
        // Debug: log all major containers
        const containers = document.querySelectorAll('.l-trade, .l-trade-detail, .l-trade-coin, .l-trade-status, [class*="l-trade"]');
        console.log('P2P Analytics HTX: Found containers:', containers.length);
        containers.forEach((el, i) => {
            console.log(`Container ${i}:`, el.className, 'visible:', el.offsetHeight > 0);
        });
        return false;
    }
    
    console.log('P2P Analytics HTX: Using target:', foundSelector, 'height:', targetDiv.offsetHeight);

    // Check if menu already exists
    const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
    if (existingMenus.length > 0) {
        console.log('P2P Analytics HTX: Menu already exists');
        for (let i = 1; i < existingMenus.length; i++) {
            existingMenus[i].remove();
        }
        return true;
    }
    
    if (isInitializing) {
        console.log('P2P Analytics HTX: Menu creation already in progress');
        return false;
    }
    
    isInitializing = true;
    
    try {
        console.log('P2P Analytics HTX: Creating dropdown menu...');
        const menuContainer = await createDropdownMenu();
        
        console.log('P2P Analytics HTX: Target element:', targetDiv);
        console.log('P2P Analytics HTX: Target parent:', targetDiv.parentNode);
        console.log('P2P Analytics HTX: Target next sibling:', targetDiv.nextSibling);
        
        // Insert after chat box or appropriate container
        targetDiv.parentNode.insertBefore(menuContainer, targetDiv.nextSibling);
        console.log('P2P Analytics HTX: Menu successfully inserted!');
        console.log('P2P Analytics HTX: Menu element:', menuContainer);
        
        return true;
    } catch (error) {
        console.error('P2P Analytics HTX: Error creating menu:', error);
        console.error('P2P Analytics HTX: Error stack:', error.stack);
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
            const targetSelectors = [
                '.l-trade-detail',
                '.l-trade-coin',
                '.l-trade-status',
                '.l-trade-payment'
            ];
            
            let targetDiv = null;
            let foundSelector = null;
            for (const selector of targetSelectors) {
                targetDiv = document.querySelector(selector);
                if (targetDiv) {
                    foundSelector = selector;
                    break;
                }
            }
            
            if (targetDiv) {
                const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
                if (existingMenus.length === 0) {
                    console.log('P2P Analytics HTX: MutationObserver found target:', foundSelector);
                    if (await insertMenuAfterTarget()) {
                        console.log('P2P Analytics HTX: Menu inserted via MutationObserver!');
                    }
                } else {
                    // Remove duplicates
                    for (let i = 1; i < existingMenus.length; i++) {
                        console.log('P2P Analytics HTX: Removing duplicate menu via MutationObserver');
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
        console.log('P2P Analytics HTX: Already initializing, skipping...');
        return false;
    }
    
    console.log('P2P Analytics HTX: Initializing extension...');
    console.log('P2P Analytics HTX: Current URL:', window.location.href);
    
    // Check if we're on HTX order page (htx.com or htx.com.gt)
    const urlPattern = /htx\.com(\.gt)?.*\/fiat-crypto\/tradeInfo/;
    const isCorrectPage = urlPattern.test(window.location.href);
    console.log('P2P Analytics HTX: On correct page:', isCorrectPage);
    
    if (!isCorrectPage) {
        console.log('P2P Analytics HTX: Not on order page, skipping initialization');
        return false;
    }
    
    // Check if auth helper is loaded
    if (!window.P2PAuth) {
        console.error('P2P Analytics HTX: Auth helper not loaded');
        return false;
    }
    
    console.log('P2P Analytics HTX: Auth helper loaded successfully');
    
    // Check authentication
    const authData = await window.P2PAuth.getAuthData();
    if (!authData || !authData.token) {
        console.log('P2P Analytics HTX: Not authenticated, skipping initialization');
        return false;
    }
    
    console.log('P2P Analytics HTX: Authenticated, proceeding with initialization');
    
    // Load display name
    await loadDisplayNameFromStorage();
    
    // Initialize mutation observer
    initializeMutationObserver();
    
    // Try to insert menu immediately
    const menuInserted = await insertMenuAfterTarget();
    
    if (menuInserted) {
        console.log('P2P Analytics HTX: Initialization successful');
        return true;
    }
    
    console.log('P2P Analytics HTX: Menu not inserted yet, will retry');
    return false;
}

// Retry mechanism for initialization
let initRetryCount = 0;
const maxInitRetries = 10;

async function tryInitialize() {
    const success = await initialize();
    
    if (!success && initRetryCount < maxInitRetries) {
        initRetryCount++;
        console.log(`P2P Analytics HTX: Retry ${initRetryCount}/${maxInitRetries}...`);
        setTimeout(tryInitialize, 1000);
    } else if (success) {
        console.log('P2P Analytics HTX: Successfully initialized');
    } else {
        console.log('P2P Analytics HTX: Max retries reached, giving up');
    }
}

// Wait for DOM ready and auth
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('P2P Analytics HTX: DOM content loaded');
        addStyles(); // Add styles as soon as DOM is ready
        setTimeout(tryInitialize, 500);
    });
} else {
    console.log('P2P Analytics HTX: DOM already loaded');
    addStyles(); // Add styles immediately if DOM already ready
    setTimeout(tryInitialize, 500);
}

// Handle URL changes (SPA navigation)
let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        console.log('P2P Analytics HTX: URL changed to:', url);
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

console.log('P2P Analytics HTX: Script initialization complete');


