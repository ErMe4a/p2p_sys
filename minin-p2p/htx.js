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
let currentDisplayName = '';  // Активное имя для текущей страницы (BUY или SELL)
let storedBuyName = '';       // Из storage — применяется ТОЛЬКО на BUY страницах
let originalBuyName = '';

// ============================================
// Timezone and Date Helpers (MSK)
// ============================================

function getCurrentMskDateTimeLocal() {
    try {
        // Получаем текущее время в таймзоне МСК и форматируем под datetime-local (YYYY-MM-DDTHH:mm)
        const str = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Moscow" });
        return str.replace(" ", "T").slice(0, 16);
    } catch (e) {
        // Фолбэк, если sv-SE не поддерживается
        const now = new Date();
        const mskTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
        return mskTime.toISOString().slice(0, 16);
    }
}

function mskDateTimeLocalToIso(localStr) {
    if (!localStr) return new Date().toISOString();
    // Принудительно указываем смещение +03:00 для МСК
    const d = new Date(localStr + "+03:00");
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function utcIsoToMskDateTimeLocal(isoStr) {
    if (!isoStr) return getCurrentMskDateTimeLocal();
    try {
        const d = new Date(isoStr);
        const str = d.toLocaleString("sv-SE", { timeZone: "Europe/Moscow" });
        return str.replace(" ", "T").slice(0, 16);
    } catch (e) {
        return isoStr.slice(0, 16);
    }
}

// ============================================
// General Helper functions
// ============================================

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
        
        const hasBuyToken = BUY_TOKENS.some(t => titleText.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => titleText.includes(t));
        
        if (hasBuyToken && !hasSellToken) return 'buy';
        if (hasSellToken && !hasBuyToken) return 'sell';
    }
    
    // Method 3: Check .direction p element
    const directionEl = document.querySelector('.baseInfo .direction');
    if (directionEl) {
        const directionText = normalizeText(directionEl.textContent);
        
        const hasBuyToken = BUY_TOKENS.some(t => directionText.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => directionText.includes(t));
        
        if (hasBuyToken && !hasSellToken) return 'buy';
        if (hasSellToken && !hasBuyToken) return 'sell';
    }
    
    // Method 4: Check any element with .l-trade-title class
    const allTitleElements = document.querySelectorAll('.l-trade-title, .l-trade-title *');
    for (const el of allTitleElements) {
        const text = normalizeText(el.textContent);
        const hasBuyToken = BUY_TOKENS.some(t => text.includes(t));
        const hasSellToken = SELL_TOKENS.some(t => text.includes(t));
        
        if (hasBuyToken && !hasSellToken) return 'buy';
        if (hasSellToken && !hasBuyToken) return 'sell';
    }

    console.warn('P2P Analytics HTX: Could not determine order type - all methods failed');
    return 'unknown';
}

function isBuyPage() {
    try { return detectOrderType() === 'buy'; } catch (_) { return false; }
}

function isSellPage() {
    try { return detectOrderType() === 'sell'; } catch (_) { return false; }
}

async function loadDisplayNameFromStorage() {
    try {
        const res = await chrome.storage.sync.get(['displayName']);
        storedBuyName = res.displayName || '';
        return storedBuyName;
    } catch (e) {
        console.warn('P2P Analytics HTX: Failed to load display name:', e);
        storedBuyName = '';
        return '';
    }
}

async function waitForOrderIdInDOM(maxAttempts = 20, delayMs = 300) {
    console.log('P2P Analytics HTX: Waiting for order ID to appear in DOM...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const selectors = [
            '.l-trade-title .pay-code-wrap .btnCopy[data-clipboard-text]',
            '.pay-code-wrap .btnCopy[data-clipboard-text]',
            '.l-trade-title .btnCopy[data-clipboard-text]',
            '.btnCopy[data-clipboard-text]' 
        ];
        
        for (const selector of selectors) {
            const copyButton = document.querySelector(selector);
            if (copyButton) {
                const orderId = copyButton.getAttribute('data-clipboard-text');
                if (orderId && /^\d{15,25}$/.test(orderId)) {
                    return String(orderId);
                }
            }
        }
        
        const titleSection = document.querySelector('.l-trade-title');
        if (titleSection) {
            const allText = titleSection.textContent || '';
            const orderIdMatch = allText.match(/\b(\d{15,25})\b/);
            if (orderIdMatch) {
                return String(orderIdMatch[1]);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    return null;
}

function getOrderIdFromUrl() {
    try {
        const selectors = [
            '.l-trade-title .pay-code-wrap .btnCopy[data-clipboard-text]',
            '.pay-code-wrap .btnCopy[data-clipboard-text]',
            '.l-trade-title .btnCopy[data-clipboard-text]'
        ];
        
        for (const selector of selectors) {
            const copyButton = document.querySelector(selector);
            if (copyButton) {
                const orderId = copyButton.getAttribute('data-clipboard-text');
                if (orderId && /^\d{15,25}$/.test(orderId)) {
                    return String(orderId);
                }
            }
        }
        
        const copyButtons = document.querySelectorAll('.btnCopy[data-clipboard-text]');
        for (const btn of copyButtons) {
            const orderId = btn.getAttribute('data-clipboard-text');
            if (orderId && /^\d{15,25}$/.test(orderId)) {
                return String(orderId);
            }
        }
    } catch (e) { /* ignore */ }
    
    try {
        const titleSection = document.querySelector('.l-trade-title');
        if (titleSection) {
            const allText = titleSection.textContent || '';
            if (allText.includes('Номер') || allText.includes('номер')) {
                const orderIdMatch = allText.match(/(?:Номер|номер)\s*[：:]\s*(\d{15,25})/i);
                if (orderIdMatch) return String(orderIdMatch[1]);
                
                const simpleMatch = allText.match(/(?:Номер|номер)\s*(\d{15,25})/i);
                if (simpleMatch) return String(simpleMatch[1]);
            }
        }
    } catch (e) { /* ignore */ }
    
    try {
        const targetSelectors = ['.l-trade-title', '.l-trade-detail', '.mobile-trade-info'];
        for (const selector of targetSelectors) {
            const container = document.querySelector(selector);
            if (container) {
                const allText = container.textContent || '';
                const orderIdMatch = allText.match(/\b(\d{15,25})\b/);
                if (orderIdMatch) return String(orderIdMatch[1]);
            }
        }
    } catch (e) { /* ignore */ }
    
    return null;
}

async function getOrderId() {
    const orderIdFromDOM = await waitForOrderIdInDOM();
    if (orderIdFromDOM) return orderIdFromDOM;
    
    const orderIdImmediate = getOrderIdFromUrl();
    if (orderIdImmediate) return orderIdImmediate;
    
    return null;
}

const captureScreenshot = async () => {
    try {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'captureScreenshot' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
                    } else if (response && response.success) {
                        resolve(response.dataUrl);
                    } else {
                        reject(new Error(response?.error || 'Failed to capture screenshot'));
                    }
                }
            );
        });
    } catch (error) {
        throw error;
    }
};

const uploadScreenshotFromDataUrl = async (dataUrl, orderId) => {
    try {
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для загрузки скриншота');
            return { success: false, error: 'Не авторизован' };
        }

        const response = await fetch(dataUrl);
        const blob = await response.blob();
        return await window.P2PAuth.uploadScreenshot(blob, `${orderId}.png`);
    } catch (error) {
        window.P2PAuth.showAuthError(error.message);
        return { success: false, error: error.message };
    }
};

checkOrderExists = async (orderId) => {
    return window.P2POrderAPI.checkOrderExists(orderId, EXCHANGE_TYPE_HTX);
};

deleteOrder = async (orderId) => {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_HTX);
};

// ============================================
// UI Elements Creation
// ============================================

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

    submitBtn.addEventListener('mouseenter', () => submitBtn.style.backgroundColor = '#0165CC');
    submitBtn.addEventListener('mouseleave', () => submitBtn.style.backgroundColor = HTX_PRIMARY_COLOR);

    submitBtn.onclick = async () => {
        const formData = collectFormData();
        
        if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
            showNotification('Пожалуйста, выберите банк', 'error');
            return;
        }
        
        if (!formData.type || formData.type === 'UNKNOWN') {
            showNotification('Не удалось определить тип заказа (покупка/продажа)', 'error');
            return;
        }
        
        const orderId = await getOrderId();
        
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
            try {
                screenshotDataUrl = await captureScreenshot();
            } catch (error) {
                showNotification('Предупреждение: не удалось создать скриншот', 'error');
            }

            let existingOrderData = null;
            try {
                const existingOrderResult = await checkOrderExists(orderId);
                if (existingOrderResult.success && existingOrderResult.exists && existingOrderResult.data) {
                    existingOrderData = existingOrderResult.data;
                }
            } catch (error) { /* ignore */ }

            let finalReceipt = null;
            if (formData.hasReceipt) {
                finalReceipt = formData.receipt;
            } else if (existingOrderData && existingOrderData.receipt) {
                finalReceipt = existingOrderData.receipt;
            }

            submitBtn.textContent = 'Сохранение заказа...';
            
            const orderData = {
                orderId: String(orderId),
                details: { id: formData.bankId },
                commission: formData.commission,
                commissionType: formData.commissionType,
                receipt: finalReceipt,
                createdAt: formData.createdAt,
                type: formData.type,
                exchangeType: EXCHANGE_TYPE_HTX,
                price: formData.price,
                quantity: formData.quantity,
                amount: formData.amount
            };

            const result = await saveOrder(orderData);

            if (result.success) {
                if (screenshotDataUrl) {
                    submitBtn.textContent = 'Загрузка скриншота...';
                    try {
                        const uploadResult = await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
                        if (!uploadResult.success) {
                            showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                        }
                    } catch (error) {
                        showNotification('Предупреждение: не удалось загрузить скриншот', 'error');
                    }
                }

                showNotification('Заказ успешно сохранён!', 'success');
                
                if (finalReceipt && finalReceipt.uuid) {
                    const receiptCheckbox = document.querySelector('#check-checkbox');
                    const successMessage = document.querySelector('.p2p-analytics-check-success');
                    const contactInput = document.querySelector('#contact-input');
                    
                    if (receiptCheckbox) {
                        receiptCheckbox.checked = true;
                        receiptCheckbox.disabled = true;
                    }
                    if (successMessage) {
                        successMessage.style.display = 'block';
                        successMessage.textContent = 'Чек пробит';
                    }
                    if (contactInput) {
                        contactInput.value = finalReceipt.contact || '';
                        contactInput.classList.add('p2p-analytics-input-readonly');
                        contactInput.disabled = true;
                    }
                }
                
                const deleteButton = document.querySelector('.p2p-analytics-delete-button');
                if (deleteButton) deleteButton.style.display = 'block';
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

    (async () => {
        const orderId = await getOrderId();
        if (orderId) {
            checkOrderExists(orderId).then(result => {
                if (result.success && result.exists) {
                    deleteBtn.style.display = 'block';
                }
            }).catch(() => {});
        }
    })();

    deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.backgroundColor = '#D93850');
    deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.backgroundColor = '#E94359');

    deleteBtn.onclick = async () => {
        const orderId = await getOrderId();
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
                    if (commissionInput) commissionInput.value = '';
                    
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

    suffixButton.addEventListener('mouseenter', () => suffixButton.style.backgroundColor = '#E5E7EB');
    suffixButton.addEventListener('mouseleave', () => suffixButton.style.backgroundColor = '#F3F4F6');

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
        option.addEventListener('mouseenter', () => option.style.backgroundColor = '#F3F4F6');
        option.addEventListener('mouseleave', () => option.style.backgroundColor = 'white');
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

    // --- НОВОЕ: Поле для даты и времени (МСК) ---
    const dateInputWrapper = createInput('Дата и время ордера (МСК)', 'order-date-input', '');
    const dateInput = dateInputWrapper.querySelector('#order-date-input');
    dateInput.type = 'datetime-local';
    dateInput.value = getCurrentMskDateTimeLocal();
    formSection.appendChild(dateInputWrapper);

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
    const bankDetailsResult = await fetchBankDetails();
    
    if (bankDetailsResult.success && bankDetailsResult.data.length > 0) {
        buttonTextSpan.textContent = 'Выберите банк';
        
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

            menuItem.addEventListener('mouseenter', () => menuItem.style.backgroundColor = '#F3F4F6');
            menuItem.addEventListener('mouseleave', () => menuItem.style.backgroundColor = 'white');

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

    // Pre-populate if order exists
    (async () => {
        const orderId = await getOrderId();
        if (orderId) {
            checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                
                // --- НОВОЕ: Заполняем дату сохраненного ордера в поле ---
                if (order.createdAt) {
                    const savedDateInput = formSection.querySelector('#order-date-input');
                    if (savedDateInput) {
                        savedDateInput.value = utcIsoToMskDateTimeLocal(order.createdAt);
                    }
                }
                
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
                            if (commissionInput) commissionInput.placeholder = 'Введите сумму в рублях';
                        } else {
                            commissionTypeButton.textContent = '%';
                            commissionTypeButton.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
                            if (commissionInput) commissionInput.placeholder = 'Введите процент';
                        }
                    }
                }
            }
        }).catch(() => {});
        }
    })();

    return formSection;
}

async function createDropdownMenu() {
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

    return dropdownContainer;
}

function extractNumber(text) {
    if (!text) return null;
    let clean = text.replace(/[^\d.,]/g, '');
    if (clean.includes(',') && clean.includes('.')) {
        clean = clean.replace(/,/g, '');
    } else if (clean.includes(',')) {
        clean = clean.replace(',', '.');
    }
    const num = parseFloat(clean);
    return isNaN(num) ? null : num;
}

function parseOrderInfo() {
    const orderInfo = {};
    let dateFound = false;
    const dateRegex = /(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}:\d{2})/;

    try {
        const userListItems = document.querySelectorAll('.user-list li');
        if (userListItems.length > 0) {
            for (const li of userListItems) {
                const text = li.textContent || '';
                if (text.includes('Последняя сделка') || text.includes('Latest deal')) {
                    const match = text.match(dateRegex);
                    if (match) {
                        const dateStr = match[1].replace(/\//g, '-');
                        const parsedDate = new Date(dateStr);
                        if (!isNaN(parsedDate.getTime())) {
                            orderInfo.createdAt = parsedDate.toISOString(); 
                            dateFound = true;
                            break;
                        }
                    }
                }
            }
        }

        if (!dateFound) {
            const contentBlocks = document.querySelectorAll('.l-trade-detail, .baseInfo, .trade-info-list, .order-detail-container');
            for (const block of contentBlocks) {
                const text = block.textContent || '';
                const match = text.match(dateRegex);
                if (match) {
                    const dateStr = match[1].replace(/\//g, '-');
                    const parsedDate = new Date(dateStr);
                    if (!isNaN(parsedDate.getTime())) {
                        orderInfo.createdAt = parsedDate.toISOString();
                        dateFound = true;
                        break;
                    }
                }
            }
        }

        if (!dateFound) {
            const bodyText = document.body.innerText;
            const globalMatch = bodyText.match(dateRegex);
            if (globalMatch) {
                const dateStr = globalMatch[1].replace(/\//g, '-');
                const parsedDate = new Date(dateStr);
                if (!isNaN(parsedDate.getTime())) {
                    orderInfo.createdAt = parsedDate.toISOString();
                    dateFound = true;
                }
            }
        }

    } catch (e) { /* ignore */ }
    
    if (!dateFound) {
        orderInfo.createdAt = new Date().toISOString();
    }
    
    orderInfo.type = detectOrderType().toUpperCase();
    return orderInfo;
}

function parsePriceFromPage() {
    try {
        const priceElements = document.querySelectorAll('.coin-item');
        for (const item of priceElements) {
            const label = item.querySelector('.font12');
            if (label && /unit\s+price|цена|курс/i.test(label.textContent)) {
                const value = item.querySelector('.font-base.font16, .font16');
                if (value) {
                    const price = extractNumber(value.textContent.trim());
                    if (price !== null) return price.toString();
                }
            }
        }
        return '';
    } catch (error) { return ''; }
}

function parseQuantityFromPage() {
    try {
        const amountElements = document.querySelectorAll('.coin-item');
        for (const item of amountElements) {
            const label = item.querySelector('.font12');
            const value = item.querySelector('.font-base.font16, .font16');
            if (label && value) {
                const valueText = value.textContent.trim();
                if (/USDT|BTC|ETH|USDC/i.test(valueText)) {
                    let cleanValue = valueText.replace(/[^\d.,]/g, '');
                    if (cleanValue.includes(',') && cleanValue.includes('.')) {
                        cleanValue = cleanValue.replace(/,/g, '');
                    } else if (cleanValue.includes(',')) {
                        cleanValue = cleanValue.replace(',', '.');
                    }
                    const quantity = parseFloat(cleanValue);
                    if (!isNaN(quantity)) return quantity.toString();
                }
            }
        }
        return '';
    } catch (error) { return ''; }
}

function parseAmountFromPage() {
    try {
        const amountElements = document.querySelectorAll('.coin-item');
        for (const item of amountElements) {
            const label = item.querySelector('.font12');
            const value = item.querySelector('.font-blue.font16, .main-price');
            if (label && value) {
                const labelText = label.textContent.trim();
                const valueText = value.textContent.trim();
                if (/amount|сумма|количество/i.test(labelText) && /RUB|USD|EUR/i.test(valueText)) {
                    const amount = extractNumber(valueText);
                    if (amount !== null) return amount.toString();
                }
            }
        }
        return '';
    } catch (error) { return ''; }
}

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

    input.addEventListener('focus', () => input.style.borderColor = HTX_PRIMARY_COLOR);
    input.addEventListener('blur', () => input.style.borderColor = '#E5E7EB');

    inputWrapper.appendChild(label);
    inputWrapper.appendChild(input);

    return inputWrapper;
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

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
    label.textContent = 'Пробить чек (Эвотор)';
    label.style.cssText = `
        font-size: 14px;
        color: #1F2937;
        cursor: pointer;
        user-select: none;
        font-weight: 500;
    `;

    checkboxWrapper.appendChild(checkbox);
    checkboxWrapper.appendChild(label);

    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.cssText = `display: none; padding: 8px 12px; background: #FEF3CD; color: #92400E; border-radius: 4px; font-size: 12px; margin-bottom: 12px;`;
    warningMessage.textContent = 'Чтобы пробить чек, заполните анкету';

    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.cssText = `display: none; padding: 8px 12px; background: #D1FAE5; color: #065F46; border-radius: 4px; font-size: 12px; margin-bottom: 12px;`;
    successMessage.textContent = 'Чек уже пробит';

    const inputsContainer = document.createElement('div');
    inputsContainer.className = 'p2p-analytics-conditional-inputs';
    inputsContainer.style.display = 'block';

    const contactInputWrapper = createInput('Контакт покупателя', 'contact-input', 'email или телефон');
    const contactInput = contactInputWrapper.querySelector('#contact-input');
    contactInputWrapper.style.display = 'none';
    inputsContainer.appendChild(contactInputWrapper);

    const rateInputWrapper = createInput('Курс', 'rate-input', 'Курс обмена');
    const rateInput = rateInputWrapper.querySelector('#rate-input');
    inputsContainer.appendChild(rateInputWrapper);

    const quantityInputWrapper = createInput('Количество (USDT)', 'quantity-input', 'Сумма в крипте');
    const quantityInput = quantityInputWrapper.querySelector('#quantity-input');
    inputsContainer.appendChild(quantityInputWrapper);

    const costInputWrapper = createInput('Стоимость (RUB)', 'cost-input', 'Сумма в фиате');
    const costInput = costInputWrapper.querySelector('#cost-input');
    inputsContainer.appendChild(costInputWrapper);

    checkContent.appendChild(checkboxWrapper);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(inputsContainer);

    let receiptExists = false;

    let attempts = 0;
    const autoFillInterval = setInterval(() => {
        attempts++;
        if (attempts > 5) clearInterval(autoFillInterval);

        if (!rateInput.value) {
            const val = parsePriceFromPage();
            if (val) rateInput.value = val;
        }
        if (!quantityInput.value) {
            const val = parseQuantityFromPage();
            if (val) quantityInput.value = val;
        }
        if (!costInput.value) {
            const val = parseAmountFromPage();
            if (val) costInput.value = val;
        }
    }, 1000);

    (async () => {
        const orderId = await getOrderId();
        
        const orderCheckPromise = orderId 
            ? checkOrderExists(orderId).catch(() => ({ success: false, exists: false }))
            : Promise.resolve({ success: false, exists: false });

        const credentialsCheckPromise = checkEvotorCredentials().catch(() => false);

        Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                
                if (order.receipt) {
                    receiptExists = true;
                    checkbox.checked = true;
                    checkbox.disabled = true;
                    successMessage.style.display = 'block';
                    contactInputWrapper.style.display = 'block';

                    const receipt = order.receipt;
                    if (contactInput && receipt.contact) {
                        contactInput.value = receipt.contact;
                        contactInput.classList.add('p2p-analytics-input-readonly');
                        contactInput.disabled = true;
                    }
                    
                    [rateInput, quantityInput, costInput].forEach(inp => {
                        inp.classList.add('p2p-analytics-input-readonly');
                        inp.disabled = true;
                    });
                    
                    if (rateInput && receipt.price) rateInput.value = receipt.price;
                    if (quantityInput && receipt.amount) quantityInput.value = receipt.amount;
                    if (costInput && receipt.sum) costInput.value = receipt.sum;
                } else {
                    if (order.price) rateInput.value = order.price;
                    if (order.quantity) quantityInput.value = order.quantity;
                    if (order.amount) costInput.value = order.amount;
                }
                
                if (!hasCredentials) {
                    checkbox.disabled = true;
                    warningMessage.style.display = 'block';
                }
            } else {
                if (!hasCredentials) {
                    checkbox.disabled = true;
                    warningMessage.style.display = 'block';
                }
            }
        });
    })();

    checkbox.addEventListener('change', () => {
        if (!receiptExists) {
            contactInputWrapper.style.display = checkbox.checked ? 'block' : 'none';
            
            if (checkbox.checked) {
                if (contactInput && !contactInput.value) contactInput.value = generateRandomGmail();
                if (!rateInput.value) rateInput.value = parsePriceFromPage();
                if (!quantityInput.value) quantityInput.value = parseQuantityFromPage();
                if (!costInput.value) costInput.value = parseAmountFromPage();
            }
        }
    });

    return checkContent;
}

function strictParseFloat(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    
    let clean = value.toString().replace(/\s|&nbsp;/g, '').trim();
    clean = clean.replace(/[^\d.,]/g, '');
    
    if (!clean) return null;

    if (clean.includes(',') && clean.includes('.')) {
        clean = clean.replace(/,/g, '');
    } 
    else if (clean.includes(',')) {
        clean = clean.replace(',', '.');
    }
    
    const num = parseFloat(clean);
    return isNaN(num) ? null : num;
}

function collectFormData() {
    const formData = {};
    
    const bankButton = document.querySelector('.p2p-analytics-button .p2p-analytics-button-text');
    const selectedBankId = bankButton ? bankButton.getAttribute('data-bank-id') : null;
    
    formData.bank = bankButton ? bankButton.textContent : null;
    formData.bankId = selectedBankId ? parseInt(selectedBankId) : null;
    
    const commissionInput = document.querySelector('.p2p-analytics-commission-input');
    const commissionType = document.querySelector('.p2p-analytics-suffix-text');
    
    formData.commission = commissionInput ? (strictParseFloat(commissionInput.value) || 0) : 0;
    formData.commissionType = commissionType ? commissionType.getAttribute('data-commission-type') || COMMISSION_TYPE_PERCENT : COMMISSION_TYPE_PERCENT;
    
    formData.screenshot = true;
    
    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;
    
    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');
    const contactInput = document.querySelector('#contact-input');

    let finalPrice = strictParseFloat(rateInput ? rateInput.value : '');
    let finalQuantity = strictParseFloat(quantityInput ? quantityInput.value : '');
    let finalAmount = strictParseFloat(costInput ? costInput.value : '');

    if (!finalPrice) finalPrice = strictParseFloat(parsePriceFromPage());
    if (!finalQuantity) finalQuantity = strictParseFloat(parseQuantityFromPage());
    if (!finalAmount) finalAmount = strictParseFloat(parseAmountFromPage());

    formData.quantity = finalQuantity;
    formData.price = finalPrice;
    formData.amount = finalAmount;
    
    // --- 5. Обработка даты ---
    // Берем распаршенную дату ТОЛЬКО для получения типа (BUY/SELL)
    const orderInfo = parseOrderInfo();
    formData.type = orderInfo.type;

    // ДАТУ БЕРЕМ ИЗ НОВОГО ИНПУТА
    const dateInput = document.querySelector('#order-date-input');
    if (dateInput && dateInput.value) {
        // Конвертируем локальную МСК дату обратно в ISO формат для отправки на сервер
        formData.createdAt = mskDateTimeLocalToIso(dateInput.value);
    } else {
        formData.createdAt = new Date().toISOString(); // fallback
    }

    if (formData.hasReceipt) {
        let validQty = finalQuantity;
        if (validQty !== null) {
            validQty = Math.floor(validQty * 1000) / 1000;
        }

        formData.receipt = {
            contact: contactInput ? contactInput.value : '',
            price: finalPrice,
            amount: validQty,
            sum: finalAmount,
        };
    }
    
    return formData;
}

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

function addStyles() {
    if (document.getElementById('p2p-analytics-htx-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'p2p-analytics-htx-styles';
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        .p2p-analytics-commission-menu::-webkit-scrollbar { width: 6px; }
        .p2p-analytics-commission-menu::-webkit-scrollbar-thumb { background: #D1D5DB; border-radius: 3px; }
        .p2p-analytics-menu::-webkit-scrollbar { width: 6px; }
        .p2p-analytics-menu::-webkit-scrollbar-thumb { background: #D1D5DB; border-radius: 3px; }
        .p2p-analytics-input-readonly { background-color: #F3F4F6 !important; cursor: not-allowed !important; }
        .p2p-analytics-checkbox-disabled { cursor: not-allowed !important; opacity: 0.6; }
    `;
    
    if (document.head) document.head.appendChild(style);
}

async function insertMenuAfterTarget() {
    const targetSelectors = [
        '.l-trade-detail',
        '.l-trade-coin',   
        '.l-trade-status', 
        '.l-trade-payment' 
    ];
    
    let targetDiv = null;
    for (const selector of targetSelectors) {
        targetDiv = document.querySelector(selector);
        if (targetDiv) break;
    }
    
    if (!targetDiv) return false;

    const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
    if (existingMenus.length > 0) {
        for (let i = 1; i < existingMenus.length; i++) {
            existingMenus[i].remove();
        }
        return true;
    }
    
    if (isInitializing) return false;
    
    isInitializing = true;
    
    try {
        const menuContainer = await createDropdownMenu();
        targetDiv.parentNode.insertBefore(menuContainer, targetDiv.nextSibling);
        return true;
    } catch (error) {
        return false;
    } finally {
        isInitializing = false;
    }
}

function initializeMutationObserver() {
    if (observer) observer.disconnect();
    
    let debounceTimer = null;
    
    observer = new MutationObserver(async () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(async () => {
            const targetSelectors = [
                '.l-trade-detail',
                '.l-trade-coin',
                '.l-trade-status',
                '.l-trade-payment'
            ];

            let targetDiv = null;
            for (const selector of targetSelectors) {
                targetDiv = document.querySelector(selector);
                if (targetDiv) break;
            }

            if (targetDiv) {
                const existingMenus = document.querySelectorAll('.p2p-analytics-dropdown-container');
                if (existingMenus.length === 0) {
                    await insertMenuAfterTarget();
                } else {
                    for (let i = 1; i < existingMenus.length; i++) {
                        existingMenus[i].remove();
                    }
                }
            }

            // Повторная замена имени после любой перерисовки SPA
            if (currentDisplayName) {
                replaceNameInUserList(currentDisplayName);
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

// ============================================
// Замена имени контрагента в .user-list (HTX)
// ============================================

function replaceNameInUserList(name) {
    if (!name) return false;
    
    try {
        const userList = document.querySelector('.user-list');
        if (!userList) return false;
        
        const firstLi = userList.querySelector('ul li:first-child');
        if (!firstLi) return false;
        
        const currentText = firstLi.textContent || '';
        
        // Сохраняем оригинальное имя при первом вызове
        if (!originalBuyName && currentText.trim()) {
            // Убираем префикс "· " если есть
            originalBuyName = currentText.replace(/^[\s·•\-]+/, '').trim();
        }
        
        // Не заменяем если уже заменено
        if (currentText.trim() === `· ${name}` || currentText.trim() === name) {
            return true;
        }
        
        firstLi.textContent = `· ${name}`;
        return true;
    } catch (e) {
        console.warn('P2P Analytics HTX: replaceNameInUserList error:', e);
        return false;
    }
}

function restoreOriginalName() {
    if (!originalBuyName) return;
    
    try {
        const userList = document.querySelector('.user-list');
        if (!userList) return;
        
        const firstLi = userList.querySelector('ul li:first-child');
        if (firstLi) {
            firstLi.textContent = `· ${originalBuyName}`;
        }
    } catch (e) { /* ignore */ }
}

// ============================================
// Запуск замены имени с polling (HTX SPA)
// ============================================

// Добавь флаг вверху файла рядом с остальными state variables
let nameReplacementStarted = false;

// И измени startNameReplacement:
function startNameReplacement() {
    if (!storedBuyName) return;
    if (!isBuyPage()) return;  // Из storage применяем ТОЛЬКО на BUY страницах
    if (nameReplacementStarted) return; // защита от повторного запуска
    nameReplacementStarted = true;
    currentDisplayName = storedBuyName;  // Активируем для текущей страницы

    replaceNameInUserList(currentDisplayName);

    let attempts = 0;
    const maxAttempts = 20;

    // Polling только до первого успеха или таймаута.
    // После этого поддержку берёт на себя MutationObserver в initializeMutationObserver.
    const nameInterval = setInterval(() => {
        attempts++;
        const replaced = replaceNameInUserList(currentDisplayName);
        if (attempts >= maxAttempts) {
            clearInterval(nameInterval);
        } else if (replaced) {
            clearInterval(nameInterval);
        }
    }, 300);
}

async function initialize() {
    if (isInitializing) return false;
    
    const urlPattern = /htx\.com(\.gt)?.*\/fiat-crypto\/tradeInfo/;
    if (!urlPattern.test(window.location.href)) return false;
    
    if (!window.P2PAuth) return false;
    
    const authData = await window.P2PAuth.getAuthData();
    if (!authData || !authData.token) return false;
    
    await loadDisplayNameFromStorage();
    
    // ← Добавить сюда:
    startNameReplacement();
    
    initializeMutationObserver();
    
    const menuInserted = await insertMenuAfterTarget();
    if (menuInserted) return true;
    
    return false;
}

let initRetryCount = 0;
const maxInitRetries = 10;

async function tryInitialize() {
    const success = await initialize();
    
    if (!success && initRetryCount < maxInitRetries) {
        initRetryCount++;
        setTimeout(tryInitialize, 1000);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        addStyles();
        setTimeout(tryInitialize, 500);
    });
} else {
    addStyles();
    setTimeout(tryInitialize, 500);
}

// Обработчик сообщений от popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'resetBuyName') {
        currentDisplayName = '';
        nameReplacementStarted = false;
        originalBuyName = '';
        restoreOriginalName();
        chrome.storage.sync.set({ displayName: '' }).catch(() => {});
        sendResponse({ success: true });
    } else if (message.action === 'applySellName') {
        const name = message.name || '';
        currentDisplayName = name;
        nameReplacementStarted = false;
        if (name) {
            replaceNameInUserList(name);
            nameReplacementStarted = true;
        }
        sendResponse({ success: true });
    }
    return true;
});

let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        initRetryCount = 0;
        nameReplacementStarted = false;
        currentDisplayName = '';   // Сбрасываем активное имя при смене страницы
        originalBuyName = '';
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        setTimeout(tryInitialize, 1000);
    }
}).observe(document, { subtree: true, childList: true });