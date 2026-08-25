// P2P Analytics Content Script for Gate.io
console.log('P2P Analytics Gate: Content script loaded');
console.log('P2P Analytics Gate: Script load time:', new Date().toISOString());
console.log('P2P Analytics Gate: Current URL:', window.location.href);
console.log('P2P Analytics Gate: Document ready state:', document.readyState);

// Exchange type constant for Gate.io
const EXCHANGE_TYPE_GATE = 4;

// Commission type constants are already declared in order_api.js
// COMMISSION_TYPE_PERCENT and COMMISSION_TYPE_MONEY are available globally

// UI color constants for Gate.io
const GATE_PRIMARY_COLOR = '#1F9A8E'; // Бирюзовый/зеленый Gate

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
    const storedState = localStorage.getItem('p2p-analytics-gate-widget-collapsed');
    widgetCollapsed = storedState === 'true';
} catch (e) {
    // Ignore localStorage errors
}

/**
 * Возвращает корневой элемент для поиска данных ордера.
 * Gate открывает ордер в модальном окне Mantine — ищем внутри него.
 * Fallback — весь document.
 */
/**
 * Возвращает корневой элемент для поиска данных ордера.
 * Улучшено для нового дизайна модалок Gate.io
 */
function getOrderRoot() {
    const modals = Array.from(document.querySelectorAll('.mantine-GateModal-inner, .mantine-Modal-inner, [id^="mantine-"][id$="-body"]'));
    
    // Ищем тот модал, который сейчас реально отображается на экране
    const visibleModal = modals.find(m => {
        const style = window.getComputedStyle(m);
        return style.display !== 'none' && style.opacity !== '0' && style.visibility !== 'hidden';
    });
    
    return visibleModal || document;
}

/**
 * XPath поиск с учётом корневого элемента
 */
function xpathFirst(expr, root) {
    root = root || getOrderRoot();
    try {
        return document.evaluate(expr, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch (e) {
        return null;
    }
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

// --- Определение типа ордера (Buy/Sell) на Gate ---
// --- Определение типа ордера (Buy/Sell) на Gate ---
function detectOrderType() {
    try {
        const root = getOrderRoot();
        const html = root.innerHTML.toLowerCase();
        
        // Надежный способ: по кнопкам действий или системным статусам (игнорируем переписку)
        // Если мы получаем фиат (Продажа крипты = SELL = Приход)
        if (html.includes('платеж получен') || html.includes('подтвердить получение') || html.includes('вы продали')) {
            console.log('P2P Analytics Gate: Detected SELL (Приход)');
            return 'sell'; 
        }
        
        // Если мы отдаем фиат (Покупка крипты = BUY = Расход)
        if (html.includes('я оплатил') || html.includes('вы купили') || html.includes('оплатить')) {
            console.log('P2P Analytics Gate: Detected BUY (Расход)');
            return 'buy'; 
        }

        // Фоллбэк: ищем строго в span-заголовках
        const typeEl = xpathFirst('.//span[contains(text(), "Покупка") or contains(text(), "Продажа")]', root);
        if (typeEl) {
            const typeText = typeEl.textContent.toLowerCase();
            if (typeText.includes('продажа')) return 'sell';
            if (typeText.includes('покупка')) return 'buy';
        }

    } catch (e) {
        console.error('P2P Analytics Gate: Error in detectOrderType:', e);
    }
    return 'buy'; // fallback
}

function isBuyPage() { return detectOrderType() === 'buy'; }
function isSellPage() { return detectOrderType() === 'sell'; }

// Display name management
async function loadDisplayNameFromStorage() {
    try {
        const res = await chrome.storage.sync.get(['displayName']);
        currentDisplayName = res.displayName || '';
        return currentDisplayName;
    } catch (e) {
        currentDisplayName = '';
        return '';
    }
}

// ============================================
// Функции парсинга для Gate.io (Обновлено под новый DOM)
// ============================================

/**
 * Парсинг цены за единицу
 */
function parsePriceFromPage() {
    try {
        const root = getOrderRoot();
        // Ищем элемент, текст которого содержит 'Цена', берем следующий за ним узел
        const priceElement = xpathFirst(".//*[contains(text(), 'Цена за единицу') or text()='Цена']/following-sibling::*", root);
        
        if (priceElement) {
            const cleaned = priceElement.textContent.replace(/[₽\s\u00A0]/g, '').replace(',', '.');
            const price = parseFloat(cleaned);
            if (!isNaN(price)) {
                console.log('P2P Analytics Gate: Found price:', price);
                return price.toString();
            }
        }
    } catch (e) {
        console.error('P2P Analytics Gate: Error parsing price:', e);
    }
    return '';
}

/**
 * Парсинг количества USDT
 */
function parseQuantityFromPage() {
    try {
        const root = getOrderRoot();
        const quantityElement = xpathFirst(".//*[text()='Количество']/following-sibling::*", root);
        
        if (quantityElement) {
            const cleaned = quantityElement.textContent.replace(/USDT/gi, '').replace(/[\s\u00A0]/g, '').replace(',', '.');
            const quantity = parseFloat(cleaned);
            if (!isNaN(quantity)) {
                console.log('P2P Analytics Gate: Found quantity:', quantity);
                return quantity.toString();
            }
        }
    } catch (e) {
        console.error('P2P Analytics Gate: Error parsing quantity:', e);
    }
    return '';
}

/**
 * Парсинг суммы в рублях
 */
function parseAmountFromPage() {
    try {
        const root = getOrderRoot();
        const amountElement = xpathFirst(".//*[text()='Сумма']/following-sibling::*", root);
        
        if (amountElement) {
            const cleaned = amountElement.textContent.replace(/[₽\s\u00A0]/g, '').replace(',', '.');
            const amount = parseFloat(cleaned);
            if (!isNaN(amount)) {
                console.log('P2P Analytics Gate: Found amount:', amount);
                return amount.toString();
            }
        }
    } catch (e) {
        console.error('P2P Analytics Gate: Error parsing amount:', e);
    }
    return '';
}

/**
 * Парсинг ID ордера
 */
function parseOrderIdFromPage() {
    try {
        const urlMatch = window.location.href.match(/transaction_details\/(\d+)/);
        if (urlMatch) return urlMatch[1];

        const root = getOrderRoot();
        const orderIdElement = xpathFirst(".//*[contains(text(),'ID Ордера') or contains(text(),'Ордер №') or contains(text(),'Номер ордера')]/following-sibling::*", root);
        
        if (orderIdElement) {
            const match = orderIdElement.textContent.match(/(\d+)/);
            if (match) {
                console.log('P2P Analytics Gate: Found order ID:', match[1]);
                return match[1];
            }
        }
    } catch (e) {
        console.error('P2P Analytics Gate: Error parsing order ID:', e);
    }
    return null;
}

/**
 * Парсинг времени ордера
 */
function parseOrderTimeFromPage() {
    try {
        const root = getOrderRoot();
        const timeElement = xpathFirst(".//*[contains(text(),'Время ордера') or contains(text(),'Ордер размещен') or contains(text(),'Время создания')]/following-sibling::*", root);
        
        if (timeElement) {
            const timeText = timeElement.textContent.trim();
            const isoString = timeText.replace(' ', 'T');
            if (!isNaN(new Date(isoString).getTime())) {
                return new Date(isoString).toISOString();
            }
        }
    } catch (e) {
        console.error('P2P Analytics Gate: Error parsing order time:', e);
    }
    return new Date().toISOString();
}

/**
 * Основная функция для получения всех данных ордера
 */
function parseOrderInfo() {
    return {
        orderId: parseOrderIdFromPage(),
        createdAt: parseOrderTimeFromPage(),
        type: detectOrderType().toUpperCase(),
        price: parsePriceFromPage(),
        quantity: parseQuantityFromPage(),
        amount: parseAmountFromPage()
    };
}

// ============================================
// Функции для работы с DOM и ожидания
// ============================================

async function waitForOrderIdInDOM(maxAttempts = 20, delayMs = 300) {
    console.log('P2P Analytics Gate: Waiting for order ID to appear in DOM...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`P2P Analytics Gate: Attempt ${attempt}/${maxAttempts} to find order ID`);
        
        const orderId = parseOrderIdFromPage();
        if (orderId) {
            console.log('P2P Analytics Gate: ✓ Order ID found:', orderId);
            return String(orderId);
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    console.warn('P2P Analytics Gate: ⚠ Order ID not found after', maxAttempts, 'attempts');
    return null;
}

async function getOrderId() {
    console.log('P2P Analytics Gate: getOrderId() called');
    
    const urlMatch = window.location.href.match(/transaction_details\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
        console.log('P2P Analytics Gate: ✓ Order ID found in URL:', urlMatch[1]);
        return urlMatch[1];
    }
    
    const orderId = parseOrderIdFromPage();
    if (orderId) {
        console.log('P2P Analytics Gate: ✓ Order ID found in DOM:', orderId);
        return orderId;
    }
    
    return await waitForOrderIdInDOM();
}

// ============================================
// API Wrappers
// ============================================

async function checkOrderExists(orderId) {
    try {
        const authData = await window.P2PAuth.getAuthData();
        if (!authData || !authData.token) {
            return { success: false, error: 'Not authenticated' };
        }

        const url = `${window.P2PAuth.API_BASE_URL}/api/order?id=${encodeURIComponent(orderId)}&exchangeType=${EXCHANGE_TYPE_GATE}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authData.token}`,
                'Content-Type': 'application/json',
                'X-Extension-Version': chrome.runtime.getManifest().version
            }
        });

        if (response.status === 404) {
            return { success: true, exists: false, data: null };
        }

        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (e) {
            console.error('P2P Analytics Gate: Server returned non-JSON:', text);
            return { success: false, error: `Server Error (${response.status})` };
        }

        if (response.ok) {
            return { success: true, exists: true, data: data };
        } else {
            return { success: false, error: (data && data.message) ? data.message : `HTTP ${response.status}` };
        }
    } catch (error) {
        console.error('P2P Analytics Gate: Error checking order:', error);
        return { success: false, error: error.message };
    }
}

async function saveOrder(orderData) {
    try {
        const authData = await window.P2PAuth.getAuthData();
        if (!authData || !authData.token) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться');
            return { success: false, error: 'Не авторизован' };
        }

        if (orderData.stringOrderId) {
            orderData.stringOrderId = String(orderData.stringOrderId);
        }

        console.log('P2P Analytics Gate: Sending payload:', JSON.stringify(orderData));

        const response = await fetch(`${window.P2PAuth.API_BASE_URL}/api/order`, {
             method: 'POST',
             headers: {
                 'Authorization': `Bearer ${authData.token}`,
                 'Content-Type': 'application/json',
                 'X-Extension-Version': chrome.runtime.getManifest().version
             },
             body: JSON.stringify(orderData)
        });

        const responseText = await response.text();
        let data = null;
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            console.error("P2P Analytics: Failed to parse server response:", responseText);
        }

        if (response.ok && data) {
            if (orderData.hasReceipt && data.receipt) {
                console.log("P2P Analytics Gate: Receipt Server Response:", data.receipt);
                if (data.receipt.status === 'ERROR' || (data.receipt.error && data.receipt.error.length > 0)) {
                    console.error("P2P Analytics Gate: Receipt Error:", data.receipt.error);
                    alert(`Ордер сохранен, но ЧЕК НЕ ПРОБИТ!\nОшибка Эвотора: ${data.receipt.error}`);
                } else if (data.receipt.status === 'SENT') {
                    console.log("P2P Analytics Gate: Receipt sent successfully!");
                }
            }

            return {
                success: true,
                orderId: data.id || responseText,
                message: 'Order saved'
            };
        } else {
             let errorMsg = `HTTP ${response.status}`;
             if (data && data.message) errorMsg = data.message;
             else if (responseText.length < 200) errorMsg = responseText;
             
             console.error('P2P Analytics Gate: Save failed:', errorMsg);
             return { success: false, error: errorMsg };
        }
    } catch (error) {
        console.error('P2P Analytics Gate: Network error:', error);
        return { success: false, error: error.message };
    }
}

async function deleteOrder(orderId) {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_GATE);
}

// ============================================
// Screenshot Functions
// ============================================

const captureScreenshot = async () => {
    try {
        console.log('P2P Analytics Gate: Requesting screenshot from background script...');
        
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'captureScreenshot' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('P2P Analytics Gate: Runtime error:', chrome.runtime.lastError);
                        reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
                    } else if (response && response.success) {
                        console.log('P2P Analytics Gate: Screenshot captured successfully');
                        resolve(response.dataUrl);
                    } else {
                        const errorMsg = response?.error || 'Failed to capture screenshot';
                        console.error('P2P Analytics Gate: Screenshot capture failed:', errorMsg);
                        reject(new Error(errorMsg));
                    }
                }
            );
        });
    } catch (error) {
        console.error('P2P Analytics Gate: Error in captureScreenshot function:', error);
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
        console.error('P2P Analytics Gate: Error uploading screenshot:', error);
        window.P2PAuth.showAuthError(error.message);
        return {
            success: false,
            error: error.message
        };
    }
};

// ============================================
// UI Creation Functions
// ============================================

function createSubmitButton() {
    const submitBtn = document.createElement('button');
    submitBtn.className = 'p2p-analytics-submit-button';
    submitBtn.textContent = 'Сохранить заказ';

    submitBtn.onclick = async () => {
        const formData = collectFormData();
        
        if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
            showNotification('Пожалуйста, выберите банк', 'error');
            return;
        }
        
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
        
        if (!formData.type || formData.type === 'UNKNOWN') {
            showNotification('Не удалось определить тип заказа (покупка/продажа)', 'error');
            return;
        }
        
        console.log('P2P Analytics Gate: Getting order ID before submitting...');
        const orderId = await getOrderId();
        console.log('P2P Analytics Gate: Order ID for submission:', orderId);
        
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

        let screenshotDataUrl = null;

        try {
            submitBtn.textContent = 'Создание скриншота...';
            console.log('P2P Analytics Gate: Capturing screenshot...');
            
            try {
                screenshotDataUrl = await captureScreenshot();
                console.log('P2P Analytics Gate: Screenshot captured successfully');
            } catch (error) {
                console.error('P2P Analytics Gate: Error capturing screenshot:', error);
                showNotification('Предупреждение: не удалось создать скриншот', 'error');
            }

            let existingReceipt = null;
            try {
                const existingOrderResult = await checkOrderExists(orderId);
                if (existingOrderResult.success && existingOrderResult.exists && 
                    existingOrderResult.data && existingOrderResult.data.receipt) {
                    existingReceipt = existingOrderResult.data.receipt;
                }
            } catch (error) {
                console.warn('P2P Analytics Gate: Could not check existing order receipt:', error);
            }

            submitBtn.textContent = 'Сохранение заказа...';
            const orderData = {
                stringOrderId: String(orderId),
                details: { id: formData.bankId },
                commission: formData.commission,
                commissionType: formData.commissionType,
                price: formData.price,
                amount: formData.amount,
                quantity: formData.quantity,
                receipt: existingReceipt ? existingReceipt : (formData.hasReceipt ? formData.receipt : null),
                createdAt: formData.createdAt,
                type: formData.type,
                exchangeType: EXCHANGE_TYPE_GATE
            };

            const result = await saveOrder(orderData);

            if (result.success) {
                if (screenshotDataUrl) {
                    submitBtn.textContent = 'Загрузка скриншота...';
                    console.log('P2P Analytics Gate: Uploading screenshot...');
                    
                    try {
                        const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
                        
                        if (uploadResult.success) {
                            console.log('P2P Analytics Gate: Screenshot uploaded successfully');
                        } else {
                            console.error('P2P Analytics Gate: Error uploading screenshot:', uploadResult.error);
                            showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                        }
                    } catch (error) {
                        console.error('P2P Analytics Gate: Error uploading screenshot:', error);
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
    deleteBtn.style.display = 'none';

    (async () => {
        console.log('P2P Analytics Gate: Checking if order exists for delete button...');
        const orderId = await getOrderId();
        console.log('P2P Analytics Gate: Got order ID for delete button check:', orderId);
        
        if (orderId) {
            checkOrderExists(orderId).then(result => {
                if (result.success && result.exists) {
                    deleteBtn.style.display = 'block';
                    console.log('P2P Analytics Gate: Order exists, showing delete button');
                }
            }).catch(error => {
                console.error('P2P Analytics Gate: Error checking order existence:', error);
            });
        }
    })();

    deleteBtn.onclick = async () => {
        console.log('P2P Analytics Gate: Delete button clicked, getting order ID...');
        const orderId = await getOrderId();
        console.log('P2P Analytics Gate: Order ID for deletion:', orderId);
        
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

    const inputGroup = document.createElement('div');
    inputGroup.className = 'p2p-analytics-input-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'p2p-analytics-input p2p-analytics-commission-input';
    input.name = `p2p-gate-commission-${Date.now()}`;
    input.placeholder = 'Введите комиссию';
    input.autocomplete = 'new-password';
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('data-lpignore', 'true');
    input.setAttribute('data-form-type', 'other');

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
    console.log('P2P Analytics Gate: Creating dropdown menu...');
    
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'p2p-analytics-dropdown-container';

    const formSection = await createUnifiedFormSection();
    dropdownContainer.appendChild(formSection);

    console.log('P2P Analytics Gate: Dropdown menu created successfully');
    return dropdownContainer;
}

async function createFloatingWidget() {
    const existingWidget = document.querySelector('.p2p-analytics-widget--gate');
    if (existingWidget) {
        console.log('P2P Analytics Gate: Widget already exists');
        return true;
    }
    
    if (isInitializing) {
        console.log('P2P Analytics Gate: Widget creation already in progress, skipping...');
        return false;
    }
    
    isInitializing = true;
    
    try {
        console.log('P2P Analytics Gate: Creating floating widget...');
        
        const widget = document.createElement('div');
        widget.className = 'p2p-analytics-widget p2p-analytics-widget--gate';
        
        if (widgetCollapsed) {
            widget.classList.add('collapsed');
        }
        
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
            try {
                localStorage.setItem('p2p-analytics-gate-widget-collapsed', widgetCollapsed.toString());
            } catch (e) {
                // Ignore localStorage errors
            }
        });
        
        const panel = document.createElement('div');
        panel.className = 'p2p-analytics-widget-panel';
        
        const header = document.createElement('div');
        header.className = 'p2p-analytics-widget-header';
        header.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            <span>v${chrome.runtime.getManifest().version}</span>
        `;
        
        const content = document.createElement('div');
        content.className = 'p2p-analytics-widget-content';
        
        const menuContainer = await createDropdownMenu();
        content.appendChild(menuContainer);
        
        panel.appendChild(header);
        panel.appendChild(content);
        
        widget.appendChild(toggleBtn);
        widget.appendChild(panel);
        
        document.body.appendChild(widget);
        
        console.log('P2P Analytics Gate: Floating widget created successfully!');
        
        return true;
    } catch (error) {
        console.error('P2P Analytics Gate: Error creating widget:', error);
        return false;
    } finally {
        isInitializing = false;
    }
}

/**
 * Полная очистка — при смене страницы / выходе
 */
function cleanupResources() {
    console.log('P2P Analytics Gate: Cleaning up resources...');
    
    if (observer) {
        clearInterval(observer); // observer теперь setInterval
        observer = null;
    }
    
    removeWidget();
    isInitializing = false;
    currentSellDisplayNameTemp = '';
    originalBuyName = '';
}

/**
 * Только удаление виджета — при закрытии модала.
 * Observer НЕ отключается, чтобы следить за следующим открытием модала.
 */
function removeWidget() {
    const existingWidget = document.querySelector('.p2p-analytics-widget--gate');
    if (existingWidget) {
        existingWidget.remove();
        console.log('P2P Analytics Gate: Widget removed');
    }
    isInitializing = false;
    currentSellDisplayNameTemp = '';
    originalBuyName = '';
}

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
    input.name = `p2p-gate-${inputId}-${Date.now()}`;
    input.placeholder = placeholder;
    input.autocomplete = 'new-password';
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('data-lpignore', 'true');
    input.setAttribute('data-form-type', 'other');

    inputWrapper.appendChild(label);
    inputWrapper.appendChild(input);

    return inputWrapper;
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

    const permanentInputs = document.createElement('div');
    permanentInputs.className = 'p2p-analytics-permanent-inputs';

    const rateInputWrapper = createInput('Курс', 'rate-input', 'Введите курс');
    const rateInput = rateInputWrapper.querySelector('#rate-input');
    permanentInputs.appendChild(rateInputWrapper);

    const quantityInputWrapper = createInput('Количество', 'quantity-input', 'Введите количество');
    const quantityInput = quantityInputWrapper.querySelector('#quantity-input');
    permanentInputs.appendChild(quantityInputWrapper);

    const costInputWrapper = createInput('Стоимость (₽)', 'cost-input', 'Введите стоимость');
    const costInput = costInputWrapper.querySelector('#cost-input');
    permanentInputs.appendChild(costInputWrapper);

    checkContent.appendChild(permanentInputs);
    checkContent.appendChild(createSeparator());

    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'p2p-analytics-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'p2p-analytics-checkbox';
    checkbox.id = 'check-checkbox';

    const label = document.createElement('label');
    label.className = 'p2p-analytics-checkbox-label';
    label.htmlFor = 'check-checkbox';
    label.textContent = 'Чек (Фискализация)';

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    const typeSelector = document.createElement('div');
    typeSelector.className = 'p2p-analytics-type-selector';
    typeSelector.style.display = 'none'; 

    const labelSell = document.createElement('label');
    labelSell.className = 'p2p-analytics-radio-label type-sell';
    const radioSell = document.createElement('input');
    radioSell.type = 'radio';
    radioSell.name = 'order-type-selection';
    radioSell.value = 'SELL';
    labelSell.appendChild(radioSell);
    labelSell.appendChild(document.createTextNode('Приход (Продажа)'));

    const labelBuy = document.createElement('label');
    labelBuy.className = 'p2p-analytics-radio-label type-buy';
    const radioBuy = document.createElement('input');
    radioBuy.type = 'radio';
    radioBuy.name = 'order-type-selection';
    radioBuy.value = 'BUY';
    labelBuy.appendChild(radioBuy);
    labelBuy.appendChild(document.createTextNode('Расход (Покупка)'));

    typeSelector.appendChild(labelSell);
    typeSelector.appendChild(labelBuy);

    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.display = 'none';
    warningMessage.textContent = 'Для чека заполните анкету в настройках';

    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.display = 'none';
    successMessage.textContent = 'Чек пробит (данные зафиксированы)';

    const conditionalInputs = document.createElement('div');
    conditionalInputs.className = 'p2p-analytics-conditional-inputs';
    conditionalInputs.style.display = 'none';

    const contactInputWrapper = createInput('Контакт', 'contact-input', 'Введите контакт');
    const contactInput = contactInputWrapper.querySelector('#contact-input');
    conditionalInputs.appendChild(contactInputWrapper);
    
    checkContent.appendChild(checkboxWrapper);
    checkContent.appendChild(typeSelector);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    let receiptExists = false;

    (async () => {
        const detectedType = detectOrderType();
        if (detectedType === 'sell') {
            radioSell.checked = true;
        } else {
            radioBuy.checked = true; 
        }

        const orderId = await getOrderId();
        
        const orderCheckPromise = orderId 
            ? checkOrderExists(orderId).catch(() => ({ success: false, exists: false }))
            : Promise.resolve({ success: false, exists: false });
        
        const credentialsCheckPromise = (window.P2POrderAPI ? window.P2POrderAPI.checkEvotorCredentials() : checkEvotorCredentials()).catch(() => false);

        Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
            
            const lockInputStyle = (input) => {
                input.style.backgroundColor = '#333';
                input.style.color = '#aaa';
                input.style.border = '1px solid #444';
            };

            const lockContainerStyle = (container) => {
                container.style.opacity = '0.6';
                container.style.pointerEvents = 'none';
                container.style.filter = 'grayscale(100%)';
            };

            if (orderResult.success && orderResult.exists && orderResult.data && orderResult.data.receipt) {
                receiptExists = true;
                const receipt = orderResult.data.receipt;

                checkbox.checked = true;
                checkbox.disabled = true;
                checkbox.classList.add('p2p-analytics-checkbox-disabled');
                
                typeSelector.style.display = 'flex';
                radioBuy.disabled = true;
                radioSell.disabled = true;

                const orderType = orderResult.data.type || 'BUY';
                if (orderType === 'SELL') {
                    radioSell.checked = true;
                } else {
                    radioBuy.checked = true;
                }

                label.style.color = '#888';
                successMessage.style.display = 'block';
                conditionalInputs.style.display = 'block';

                lockContainerStyle(permanentInputs);
                lockContainerStyle(conditionalInputs);

                const fields = [
                    { el: rateInput, val: receipt.price },
                    { el: quantityInput, val: receipt.amount }, 
                    { el: costInput, val: receipt.sum },        
                    { el: contactInput, val: receipt.contact }
                ];

                fields.forEach(field => {
                    if (field.el) {
                        field.el.value = (field.val !== null && field.val !== undefined) ? field.val : '';
                        field.el.readOnly = true;
                        field.el.disabled = true;
                        field.el.classList.add('p2p-analytics-input-readonly');
                        lockInputStyle(field.el);
                    }
                });

            } else {
                if (orderResult.success && orderResult.exists && orderResult.data) {
                    const order = orderResult.data;
                    rateInput.value = order.price || parsePriceFromPage();
                    quantityInput.value = order.quantity || parseQuantityFromPage();
                    if (costInput) costInput.value = order.amount || parseAmountFromPage();
                    
                    if (order.type === 'SELL') radioSell.checked = true;
                    else radioBuy.checked = true;

                } else {
                    rateInput.value = parsePriceFromPage();
                    quantityInput.value = parseQuantityFromPage();
                    if (costInput) costInput.value = parseAmountFromPage();
                }

                [rateInput, quantityInput, costInput, contactInput].forEach(el => {
                    if (el) {
                        el.readOnly = false;
                        el.disabled = false;
                        el.classList.remove('p2p-analytics-input-readonly');
                        el.style.pointerEvents = 'auto';
                    }
                });
                
                permanentInputs.style.pointerEvents = 'auto';
                permanentInputs.style.opacity = '1';
                permanentInputs.style.filter = 'none';

                if (!hasCredentials) {
                    checkbox.disabled = true;
                    checkbox.classList.add('p2p-analytics-checkbox-disabled');
                    warningMessage.style.display = 'block';
                } else {
                    checkbox.checked = true;
                    checkbox.disabled = false;
                    
                    typeSelector.style.display = 'flex';
                    conditionalInputs.style.display = 'block';
                    
                    if (contactInput && !contactInput.value) {
                        contactInput.value = generateRandomGmail();
                    }
                }
            }
        });
    })();
    
    checkbox.addEventListener('change', () => {
        if (!receiptExists) {
            const isChecked = checkbox.checked;
            conditionalInputs.style.display = isChecked ? 'block' : 'none';
            typeSelector.style.display = isChecked ? 'flex' : 'none';

            if (isChecked && contactInput && !contactInput.value) {
                contactInput.value = generateRandomGmail();
            }
        }
    });

    return checkContent;
}

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
    
    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');
    
    const parsedPrice = parseNumberOrNull(rateInput?.value);
    const parsedAmount = parseNumberOrNull(costInput?.value);
    const parsedQuantity = parseNumberOrNull(quantityInput?.value);

    formData.price = (parsedPrice !== null && !isNaN(parsedPrice)) ? parsedPrice : 0;
    formData.amount = (parsedAmount !== null && !isNaN(parsedAmount)) ? parsedAmount : 0;  
    formData.quantity = (parsedQuantity !== null && !isNaN(parsedQuantity)) ? parseFloat(parsedQuantity.toFixed(3)) : 0;
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    if (formData.hasReceipt) {
        const contactInput = document.querySelector('#contact-input');
        let contactValue = contactInput ? contactInput.value : '';
        
        if (!contactValue || contactValue.trim() === '') {
            contactValue = generateRandomGmail(); 
        }
        
        formData.receipt = {
            contact: contactValue,
            price: formData.price,    
            amount: formData.quantity, 
            sum: formData.amount,       
        };
    } else {
        formData.receipt = null;
    }
    
    const selectedType = document.querySelector('input[name="order-type-selection"]:checked');
    
    if (selectedType) {
        formData.type = selectedType.value;
    } else {
        const orderInfo = parseOrderInfo();
        formData.type = (orderInfo.type === 'UNKNOWN' || !orderInfo.type) ? 'BUY' : orderInfo.type;
    }

    const orderInfo = parseOrderInfo();
    formData.createdAt = orderInfo.createdAt;
    
    return formData;
}

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

function addStyles() {
    // Check if styles already added
    if (document.getElementById('p2p-analytics-gate-styles')) {
        return;
    }
    
    const style = document.createElement('style');
    style.id = 'p2p-analytics-gate-styles';
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
        /* ... начало стилей ... */
        .p2p-analytics-type-selector {
            display: flex;
            gap: 15px; /* Чуть увеличил отступ между ними */
            margin-top: 10px;
            margin-bottom: 10px;
            padding: 0 5px;
        }

        .p2p-analytics-radio-label {
            display: flex;
            align-items: center;
            cursor: pointer;
            font-size: 12px;
            user-select: none;
        }

        .p2p-analytics-radio-label input {
            margin-right: 6px;
            cursor: pointer;
        }

        /* Цвета по твоему запросу */
        .type-sell { color: #E94359; font-weight: bold; } /* Приход (Продажа) -> КРАСНЫЙ */
        .type-buy { color: #0B8E5A; font-weight: bold; }  /* Расход (Покупка) -> ЗЕЛЕНЫЙ */
        /* ... конец стилей ... */
    `;
    
    if (document.head) {
        document.head.appendChild(style);
        console.log('P2P Analytics MEXC: Styles added');
    } else {
        console.warn('P2P Analytics MEXC: document.head not available yet');
    }
}

// ============================================
// Mutation Observer
// ============================================

/**
 * Лёгкий polling-наблюдатель вместо тяжёлого MutationObserver.
 * Проверяет наличие модала раз в 400ms — минимальная нагрузка на CPU.
 */
function initializeMutationObserver() {
    // Отключаем предыдущий если был
    if (observer) {
        clearInterval(observer);
        observer = null;
    }

    // Флаг — модал был открыт в прошлом тике (для детектирования нового открытия)
    let wasModalOpen = false;

    observer = setInterval(async () => {
        try {
            const existingWidget = document.querySelector('.p2p-analytics-widget--gate');
            const modalOpen = isOrderModalOpen();

            // Модал закрылся — убираем виджет
            if (existingWidget && !modalOpen) {
                console.log('P2P Analytics Gate: Modal closed, removing widget');
                wasModalOpen = false;
                removeWidget();
                return;
            }

            // Модал только что открылся (переход false→true) — ждём 600ms для полного рендера DOM
            if (!wasModalOpen && modalOpen && !existingWidget && !isInitializing) {
                wasModalOpen = true;
                console.log('P2P Analytics Gate: Modal just opened, waiting for DOM render...');
                setTimeout(async () => {
                    if (isOrderModalOpen() && !document.querySelector('.p2p-analytics-widget--gate')) {
                        console.log('P2P Analytics Gate: Creating widget after DOM ready');
                        await createFloatingWidget();
                    }
                }, 600);
                return;
            }

            wasModalOpen = modalOpen;
        } catch (e) {
            // noop
        }
    }, 400);
}

// ============================================
// URL Detection and Initialization
// ============================================

/**
 * Проверяет домен Gate
 */
function isGateDomain() {
    try {
        const hostname = location.hostname;
        return hostname.includes('gate.com') || hostname.includes('gate.io');
    } catch (_) { return false; }
}

/**
 * Проверяет что мы на P2P разделе Gate
 */
function isGateP2PPage() {
    try {
        if (!isGateDomain()) return false;
        const path = location.pathname;
        return path.includes('/p2p/') || path.includes('/u/p2p/');
    } catch (_) { return false; }
}

/**
 * Проверяет что в DOM открыт модал с деталями ордера.
 * Gate.com открывает ордера как Mantine-модалы БЕЗ изменения URL.
 */
/**
 * Ищет в DOM маркер открытого ордера Gate.
 * Gate.com не меняет URL — модал открывается поверх списка ордеров.
 * Поддерживаем оба варианта дизайна: старый (ID Ордера) и новый (Ордер №.)
 */
function isOrderModalOpen() {
    try {
        const root = getOrderRoot();
        if (root === document) return false; // Если видимого модала нет, значит закрыт
        
        const text = root.textContent || '';
        return text.includes('Ордер №') || text.includes('Номер ордера') || text.includes('ID Ордера');
    } catch (_) { return false; }
}

function isTargetPage() {
    // Вариант 1: gate.io — URL-based навигация (transaction_details в pathname)
    try {
        const url = new URL(location.href);
        const isCorrectDomain = url.hostname.includes('gate.com') || url.hostname.includes('gate.io');
        const isCorrectPath = /\/p2p\/transaction_details\/\d+/.test(url.pathname);
        if (isCorrectDomain && isCorrectPath) {
            console.log('P2P Analytics Gate: URL-based order page detected');
            return true;
        }
    } catch (_) {}

    // Вариант 2: gate.com — модал открыт на P2P странице (URL не меняется)
    if (isGateP2PPage() && isOrderModalOpen()) {
        console.log('P2P Analytics Gate: Modal-based order detected on P2P page');
        return true;
    }

    console.log('P2P Analytics Gate: Not on order page. URL:', location.href);
    return false;
}

async function initialize() {
    if (isInitializing) {
        console.log('P2P Analytics Gate: Already initializing, skipping...');
        return false;
    }
    
    console.log('P2P Analytics Gate: Initializing extension...');
    console.log('P2P Analytics Gate: Current URL:', window.location.href);
    
    if (!isGateDomain()) {
        console.log('P2P Analytics Gate: Not on Gate domain, skipping');
        return false;
    }

    if (!window.P2PAuth) {
        console.error('P2P Analytics Gate: Auth helper not loaded, retrying...');
        setTimeout(initialize, 1000);
        return false;
    }
    
    // Запускаем MutationObserver сразу — он будет следить за появлением модала
    initializeMutationObserver();
    
    await loadDisplayNameFromStorage();
    
    // Если модал уже открыт (напр. при перезагрузке страницы с открытым ордером)
    if (isTargetPage()) {
        console.log('P2P Analytics Gate: Order modal already open, creating widget');
        const widgetCreated = await createFloatingWidget();
        if (widgetCreated) {
            console.log('P2P Analytics Gate: Initialization successful');
            return true;
        }
    } else {
        console.log('P2P Analytics Gate: On Gate P2P page, observer running, waiting for order modal...');
    }
    
    return true;
}

// ============================================
// Main Execution
// ============================================

function handleDocumentReady() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            console.log('P2P Analytics Gate: DOM content loaded');
            addStyles();
            initialize();
        });
    } else {
        console.log('P2P Analytics Gate: DOM already loaded');
        addStyles();
        initialize();
    }
}

handleDocumentReady();

// URL watcher for SPA navigation
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

function handleUrlChange() {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
        console.log('P2P Analytics Gate: URL change detected');
        currentUrl = newUrl;
        // Убираем только виджет, НЕ observer — он нужен для отслеживания модала
        removeWidget();
        // initialize() запустит observer заново если нужно
        setTimeout(() => initialize(), 200);
    }
}

window.addEventListener('popstate', handleUrlChange);
window.addEventListener('hashchange', handleUrlChange);

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
        console.warn('P2P Analytics Gate: Failed to patch History API for URL changes:', e);
    }
})();

window.addEventListener('beforeunload', () => {
    cleanupResources();
});

// Listen for auth changes
if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'sync') {
            if (changes.authToken) {
                console.log('P2P Analytics Gate: Auth token changed, reinitializing...');
                
                if (!changes.authToken.newValue && changes.authToken.oldValue) {
                    console.log('P2P Analytics Gate: User logged out');
                    cleanupResources();
                    window.P2PAuth.showAuthError('Вы вышли из системы. Для работы с расширением необходимо авторизоваться заново.');
                }
                
                if (changes.authToken.newValue && !changes.authToken.oldValue) {
                    console.log('P2P Analytics Gate: User logged in, reinitializing...');
                    setTimeout(() => {
                        initialize();
                    }, 500);
                }
            }

            if (changes.displayName) {
                currentDisplayName = changes.displayName.newValue || '';
                console.log('P2P Analytics Gate: Display name changed to:', currentDisplayName);
            }
        }
    });
}

// Debug functions
window.P2PAnalyticsGateDebug = {
    initialize: initialize,
    createWidget: createFloatingWidget,
    cleanupResources: cleanupResources,
    toggleWidget: () => {
        const widget = document.querySelector('.p2p-analytics-widget--gate');
        if (widget) {
            widgetCollapsed = !widgetCollapsed;
            widget.classList.toggle('collapsed', widgetCollapsed);
            try {
                localStorage.setItem('p2p-analytics-gate-widget-collapsed', widgetCollapsed.toString());
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
    parseOrderInfo: parseOrderInfo,
    getOrderId: getOrderId
};

console.log('P2P Analytics Gate: Debug functions available at window.P2PAnalyticsGateDebug');
console.log('P2P Analytics Gate: Script initialization complete');