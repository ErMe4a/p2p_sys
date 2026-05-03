
(function() {
'use strict';

// P2P Analytics Content Script (BingX)
console.log('P2P Analytics: BingX content script loaded');

const EXCHANGE_TYPE_BINGX = 5;

// COMMISSION_TYPE_PERCENT и COMMISSION_TYPE_MONEY доступны глобально из order_api.js

// --- СПИСОК БАНКОВ ---
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

// --- HELPERS ---
function normalizeText(str) {
    try {
        return (str || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    } catch (_) {
        return (str || '').toLowerCase();
    }
}

function getBingxRowValue(labelRegex) {
    const rows = document.querySelectorAll('.justify-between.align-center');
    for (const row of rows) {
        const labelSpan = row.querySelector('span');
        if (!labelSpan) continue;
        if (labelRegex.test(labelSpan.textContent.trim())) {
            const valueSpan = row.querySelector('.text1, .number') || row.lastElementChild;
            return valueSpan ? valueSpan.textContent.trim() : '';
        }
    }
    return '';
}

// --- ORDER INFO ---
function parseOrderInfo() {
    const orderInfo = {};

    const rawDate = getBingxRowValue(/Время|Time/i);
    if (rawDate) {
        try {
            orderInfo.createdAt = new Date(rawDate).toISOString();
        } catch (e) {
            console.warn('P2P Analytics: Failed to parse Date', rawDate);
        }
    }

    const container = document.querySelector('.order-info') || document.body;
    if (container.querySelector('.sell')) {
        orderInfo.type = 'SELL';
    } else if (container.querySelector('.buy')) {
        orderInfo.type = 'BUY';
    }

    if (!orderInfo.type) {
        const titleText = normalizeText(document.body.textContent);
        if (/продаж|sell/i.test(titleText)) orderInfo.type = 'SELL';
        else if (/покупк|buy/i.test(titleText)) orderInfo.type = 'BUY';
        else orderInfo.type = 'UNKNOWN';
    }

    return orderInfo;
}

function detectOrderType() {
    return parseOrderInfo().type.toLowerCase();
}

function isBuyPage() {
    return detectOrderType() === 'buy';
}

function isSellPage() {
    return detectOrderType() === 'sell';
}

// --- PARSERS ---
function parsePriceFromPage() {
    try {
        const raw = getBingxRowValue(/Цена|Price/i);
        if (raw) {
            const price = extractNumber(raw);
            if (price !== null) return price.toString();
        }
        return '';
    } catch (e) {
        return '';
    }
}

function parseQuantityFromPage() {
    try {
        const raw = getBingxRowValue(/Сумма\s+(продажи|покупки)|Quantity|Количество/i);
        if (raw) {
            const qty = extractNumber(raw);
            if (qty !== null) return truncateToDecimals(qty, 3).toString();
        }
        return '';
    } catch (e) {
        return '';
    }
}

function parseAmountFromPage() {
    try {
        const rows = document.querySelectorAll('.justify-between.align-center');
        for (const row of rows) {
            const labelSpan = row.querySelector('span');
            if (!labelSpan) continue;
            let directText = '';
            for (const node of labelSpan.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) directText += node.textContent;
            }
            const trimmed = directText.trim();
            // Берём только чистую "Сумма" без "продажи"/"покупки"
            if (trimmed !== 'Сумма' && trimmed !== 'Amount') continue;
            // Дополнительная защита — если внутри span есть .sell/.buy — пропускаем
            if (labelSpan.querySelector('.sell, .buy')) continue;

            const valueSpan = row.querySelector('.text1, .number');
            const raw = valueSpan ? valueSpan.textContent.trim() : '';
            if (raw) {
                const amount = extractNumber(raw);
                if (amount !== null) return amount.toString();
            }
        }
        return '';
    } catch (e) {
        return '';
    }
}

// --- DISPLAY NAME ---
let currentDisplayName = '';
let currentSellDisplayNameTemp = '';
let originalOwnName = '';

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

function replaceCounterpartyNameInDomBingx(name) {
    if (!name) return false;
    let replaced = false;
    const rows = document.querySelectorAll('.justify-between.align-center');
    rows.forEach(row => {
        const labelText = row.querySelector('span')?.textContent.trim() || '';
        if (/Настоящее имя|Real name/i.test(labelText)) {
            const nameSpan = row.querySelector('.text1');
            if (nameSpan && nameSpan.textContent.trim() !== name) {
                nameSpan.textContent = name;
                replaced = true;
            }
        }
    });
    return replaced;
}

function replaceOwnNameInPaymentMethodBingx(name) {
    if (!name) return false;
    let replaced = false;
    const rows = document.querySelectorAll('.justify-between.align-center');
    rows.forEach(row => {
        const labelText = row.querySelector('span')?.textContent.trim() || '';
        if (/Имя и фамилия|Name|ФИО/i.test(labelText) && !/Настоящее имя|Real name/i.test(labelText)) {
            const nameSpan = row.querySelector('.text1');
            if (nameSpan) {
                const current = nameSpan.textContent.trim();
                if (current && current !== name) {
                    if (!originalOwnName) originalOwnName = current;
                    nameSpan.textContent = name;
                    replaced = true;
                }
            }
        }
    });
    return replaced;
}

function applyDisplayNameIfNeeded() {
    if (currentDisplayName && isSellPage()) {
        replaceOwnNameInPaymentMethodBingx(currentDisplayName);
    }
}

// --- ORDER ID ---
function getOrderIdFromUrl() {
    const match = window.location.href.match(/\/(\d{15,})/);
    return match ? String(match[1]) : null;
}

// --- API WRAPPERS ---
const checkOrderExists = async (orderId) => {
    return window.P2POrderAPI.checkOrderExists(orderId, EXCHANGE_TYPE_BINGX);
};

const deleteOrder = async (orderId) => {
    return window.P2POrderAPI.deleteOrder(orderId, EXCHANGE_TYPE_BINGX);
};

// --- SCREENSHOT ---
const captureScreenshot = async () => {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.success) {
                resolve(response.dataUrl);
            } else {
                reject(new Error(response?.error || 'Failed to capture screenshot'));
            }
        });
    });
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
        return { success: false, error: error.message };
    }
};

// --- FORM DATA ---
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
        if (clean.includes(',') && clean.includes('.')) clean = clean.replace(/,/g, '');
        else if (clean.includes(',')) clean = clean.replace(',', '.');
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
    formData.commissionType = commissionType
        ? commissionType.getAttribute('data-commission-type') || COMMISSION_TYPE_PERCENT
        : COMMISSION_TYPE_PERCENT;

    formData.screenshot = true;

    const receiptCheckbox = document.querySelector('#check-checkbox');
    formData.hasReceipt = receiptCheckbox ? receiptCheckbox.checked : false;

    const rateInput = document.querySelector('#rate-input');
    const quantityInput = document.querySelector('#quantity-input');
    const costInput = document.querySelector('#cost-input');
    const contactInput = document.querySelector('#contact-input');

    let finalPrice    = cleanAndParseFloat(rateInput ? rateInput.value : '', 2);
    let finalQuantity = cleanAndParseFloat(quantityInput ? quantityInput.value : '', 3);
    let finalAmount   = cleanAndParseFloat(costInput ? costInput.value : '', 2);

    if (!finalPrice)    finalPrice    = cleanAndParseFloat(parsePriceFromPage(), 2);
    if (!finalQuantity) finalQuantity = cleanAndParseFloat(parseQuantityFromPage(), 3);
    if (!finalAmount)   finalAmount   = cleanAndParseFloat(parseAmountFromPage(), 2);

    formData.price    = finalPrice;
    formData.quantity = finalQuantity;
    formData.amount   = finalAmount;

    if (formData.hasReceipt) {
        const validQty = finalQuantity !== null ? Math.floor(finalQuantity * 1000) / 1000 : null;
        const receiptData = {
            contact: contactInput ? contactInput.value.trim() : '',
            price: finalPrice,
            amount: validQty,
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

    return formData;
}

async function handleFormSubmission() {
    const formData = collectFormData();

    if (!formData.bank || formData.bank === 'Выберите банк' || !formData.bankId) {
        alert('Пожалуйста, выберите банк');
        return;
    }
    if (!formData.createdAt) {
        alert('Не удалось определить дату создания заказа.');
        return;
    }
    if (!formData.type) {
        alert('Не удалось определить тип заказа (покупка/продажа).');
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
        try {
            screenshotDataUrl = await captureScreenshot();
        } catch (error) {
            console.error('P2P Analytics: Error capturing screenshot:', error);
        }

        let existingReceipt = null;
        try {
            const existingOrderResult = await checkOrderExists(orderId);
            if (existingOrderResult.success && existingOrderResult.exists && existingOrderResult.data?.receipt) {
                existingReceipt = existingOrderResult.data.receipt;
            }
        } catch (error) {
            console.warn('P2P Analytics: Could not check existing order receipt:', error);
        }

        const receiptValue = existingReceipt || (formData.hasReceipt ? formData.receipt : null);

        const orderData = {
            orderId: String(orderId),
            details: { id: formData.bankId },
            commission: formData.commission,
            commissionType: formData.commissionType,
            screenshotName: `${orderId}.png`,
            receipt: receiptValue,
            createdAt: formData.createdAt,
            type: formData.type,
            exchangeType: EXCHANGE_TYPE_BINGX,
            price: formData.price,
            quantity: formData.quantity,
            amount: formData.amount
        };

        submitButton.textContent = 'Сохранение заказа...';
        const result = await saveOrder(orderData);

        if (!result.success) {
            alert(`Ошибка при сохранении заказа: ${result.error}`);
            return;
        }

        if (screenshotDataUrl) {
            submitButton.textContent = 'Загрузка скриншота...';
            try {
                await uploadScreenshotFromDataUrl(screenshotDataUrl, orderId);
            } catch (error) {
                console.error('Error uploading screenshot:', error);
            }
        }

        alert(`Ордер успешно сохранен! ID: ${result.orderId}.`);

        const deleteButton = document.querySelector('.p2p-analytics-delete-button');
        if (deleteButton) deleteButton.style.display = 'block';

    } catch (error) {
        console.error('Unexpected error:', error);
        alert(`Произошла неожиданная ошибка: ${error.message}`);
    } finally {
        submitButton.textContent = originalText;
        submitButton.disabled = false;
    }
}

// --- UI ---
async function createDropdownMenu() {
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'p2p-analytics-dropdown-container';
    dropdownContainer.appendChild(await createUnifiedFormSection());
    return dropdownContainer;
}

async function createUnifiedFormSection() {
    const formSection = document.createElement('div');
    formSection.className = 'p2p-analytics-form-section';

    formSection.appendChild(createSubmitButton());
    formSection.appendChild(createDeleteOrderButton());

    const requisitesTitle = document.createElement('h3');
    requisitesTitle.className = 'p2p-analytics-form-title';
    requisitesTitle.textContent = 'Реквизиты';
    formSection.appendChild(requisitesTitle);

    // Bank dropdown
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

    FIXED_BANKS.forEach(bank => {
        const item = document.createElement('div');
        item.className = 'p2p-analytics-menu-item';
        item.textContent = bank.name;
        item.setAttribute('data-bank-id', bank.id);
        item.onclick = (e) => {
            e.stopPropagation();
            buttonTextSpan.textContent = bank.name;
            buttonTextSpan.setAttribute('data-bank-id', bank.id);
            dropdownMenu.style.display = 'none';
            dropdownButton.classList.remove('p2p-analytics-button-active');
        };
        dropdownMenu.appendChild(item);
    });

    buttonMenuWrapper.appendChild(dropdownButton);
    buttonMenuWrapper.appendChild(dropdownMenu);
    formSection.appendChild(buttonMenuWrapper);

    const commissionInputWrapper = createCommissionInput();
    formSection.appendChild(commissionInputWrapper);

    // Pre-populate from existing order
    const orderId = getOrderIdFromUrl();
    if (orderId) {
        checkOrderExists(orderId).then(orderResult => {
            if (orderResult.success && orderResult.exists && orderResult.data) {
                const order = orderResult.data;
                if (order.details) {
                    const match = FIXED_BANKS.find(b => b.id === order.details.id);
                    buttonTextSpan.textContent = match ? match.name : (order.details.name || 'Неизвестный банк');
                    buttonTextSpan.setAttribute('data-bank-id', order.details.id);
                }
                if (order.commission !== null && order.commission !== undefined) {
                    const ci = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (ci) ci.value = order.commission;
                }
                if (order.commissionType) {
                    const ct = commissionInputWrapper.querySelector('.p2p-analytics-suffix-text');
                    const ci = commissionInputWrapper.querySelector('.p2p-analytics-commission-input');
                    if (ct) {
                        if (order.commissionType === COMMISSION_TYPE_MONEY) {
                            ct.textContent = '₽';
                            ct.setAttribute('data-commission-type', COMMISSION_TYPE_MONEY);
                            if (ci) ci.placeholder = 'Введите сумму в рублях';
                        } else {
                            ct.textContent = '%';
                            ct.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);
                            if (ci) ci.placeholder = 'Введите процент';
                        }
                    }
                }
            }
        }).catch(e => console.error('P2P Analytics: Error pre-populating form:', e));
    }

    formSection.appendChild(createSeparator());
    formSection.appendChild(createCheckContent());

    dropdownButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = dropdownMenu.style.display === 'none';
        dropdownMenu.style.display = isHidden ? 'block' : 'none';
        dropdownButton.classList.toggle('p2p-analytics-button-active', isHidden);
    });

    document.addEventListener('click', (e) => {
        if (!formSection.contains(e.target) && dropdownMenu.style.display === 'block') {
            dropdownMenu.style.display = 'none';
            dropdownButton.classList.remove('p2p-analytics-button-active');
        }
    });

    return formSection;
}

function createSeparator() {
    const sep = document.createElement('div');
    sep.className = 'p2p-analytics-separator';
    return sep;
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

    const suffixBtn = document.createElement('button');
    suffixBtn.className = 'p2p-analytics-suffix-button';
    suffixBtn.type = 'button';

    const suffixText = document.createElement('span');
    suffixText.className = 'p2p-analytics-suffix-text';
    suffixText.textContent = '%';
    suffixText.setAttribute('data-commission-type', COMMISSION_TYPE_PERCENT);

    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('width', '10');
    arrowSvg.setAttribute('height', '10');
    arrowSvg.setAttribute('viewBox', '0 0 12 12');
    arrowSvg.setAttribute('fill', 'currentColor');
    arrowSvg.style.marginLeft = '4px';
    arrowSvg.innerHTML = '<path d="M2.94141 4.41645C3.13999 4.21787 3.47075 4.21787 3.66934 4.41645L6.00007 6.74719L8.3308 4.41645C8.52938 4.21787 8.86014 4.21787 9.05873 4.41645C9.25731 4.61504 9.25731 4.9458 9.05873 5.14438L6.39206 7.81105C6.19348 8.00963 5.86272 8.00963 5.66413 7.81105L2.94141 5.14438C2.74283 4.9458 2.74283 4.61504 2.94141 4.41645Z"></path>';

    suffixBtn.appendChild(suffixText);
    suffixBtn.appendChild(arrowSvg);

    const suffixMenu = document.createElement('div');
    suffixMenu.className = 'p2p-analytics-suffix-menu';
    suffixMenu.style.display = 'none';

    [{ value: COMMISSION_TYPE_PERCENT, label: '%' }, { value: COMMISSION_TYPE_MONEY, label: '₽' }].forEach(type => {
        const item = document.createElement('div');
        item.className = 'p2p-analytics-menu-item';
        item.textContent = type.label;
        item.onclick = (e) => {
            e.stopPropagation();
            suffixText.textContent = type.label;
            suffixText.setAttribute('data-commission-type', type.value);
            input.placeholder = type.value === COMMISSION_TYPE_MONEY ? 'Введите сумму в рублях' : 'Введите процент';
            suffixMenu.style.display = 'none';
            suffixBtn.classList.remove('p2p-analytics-suffix-button-active');
        };
        suffixMenu.appendChild(item);
    });

    suffixWrapper.appendChild(suffixBtn);
    suffixWrapper.appendChild(suffixMenu);
    inputGroup.appendChild(input);
    inputGroup.appendChild(suffixWrapper);
    inputWrapper.appendChild(label);
    inputWrapper.appendChild(inputGroup);

    suffixBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = suffixMenu.style.display === 'none';
        suffixMenu.style.display = isHidden ? 'block' : 'none';
        suffixBtn.classList.toggle('p2p-analytics-suffix-button-active', isHidden);
        inputGroup.classList.toggle('p2p-analytics-input-group-active', isHidden);
    });

    document.addEventListener('click', (e) => {
        if (!inputWrapper.contains(e.target) && suffixMenu.style.display === 'block') {
            suffixMenu.style.display = 'none';
            suffixBtn.classList.remove('p2p-analytics-suffix-button-active');
            inputGroup.classList.remove('p2p-analytics-input-group-active');
        }
    });

    return inputWrapper;
}

function waitAndFillReceiptInputs(rateInput, quantityInput, costInput, maxRetries = 10, delay = 500) {
    let retryCount = 0;
    function tryFill() {
        const rateValue     = parsePriceFromPage();
        const quantityValue = parseQuantityFromPage();
        const costValue     = parseAmountFromPage();
        if (rateValue || quantityValue || costValue) {
            if (rateInput && rateValue)         rateInput.value     = rateValue;
            if (quantityInput && quantityValue) quantityInput.value = quantityValue;
            if (costInput && costValue)         costInput.value     = costValue;
            return;
        }
        if (++retryCount < maxRetries) setTimeout(tryFill, delay);
    }
    tryFill();
}

function createCheckContent() {
    const checkContent = document.createElement('div');
    checkContent.className = 'p2p-analytics-check-content';

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

    const warningMessage = document.createElement('div');
    warningMessage.className = 'p2p-analytics-check-warning';
    warningMessage.style.display = 'none';
    warningMessage.textContent = 'Чтобы пробить чек, заполните анкету';

    const successMessage = document.createElement('div');
    successMessage.className = 'p2p-analytics-check-success';
    successMessage.style.display = 'none';
    successMessage.textContent = 'Чек пробит';

    const conditionalInputs = document.createElement('div');
    conditionalInputs.className = 'p2p-analytics-conditional-inputs';
    conditionalInputs.style.display = 'none';

    const contactInputWrapper  = createInput('Контакт',    'contact-input',  'Введите контакт');
    const rateInputWrapper     = createInput('Курс',       'rate-input',     'Введите курс');
    const quantityInputWrapper = createInput('Количество', 'quantity-input', 'Введите количество');
    const costInputWrapper     = createInput('Стоимость',  'cost-input',     'Введите стоимость');

    const contactInput  = contactInputWrapper.querySelector('#contact-input');
    const rateInput     = rateInputWrapper.querySelector('#rate-input');
    const quantityInput = quantityInputWrapper.querySelector('#quantity-input');
    const costInput     = costInputWrapper.querySelector('#cost-input');

    conditionalInputs.appendChild(contactInputWrapper);
    conditionalInputs.appendChild(rateInputWrapper);
    conditionalInputs.appendChild(quantityInputWrapper);
    conditionalInputs.appendChild(costInputWrapper);

    checkContent.appendChild(checkboxWrapper);
    checkContent.appendChild(warningMessage);
    checkContent.appendChild(successMessage);
    checkContent.appendChild(conditionalInputs);

    const orderId = getOrderIdFromUrl();
    const orderCheckPromise = orderId
        ? checkOrderExists(orderId).catch(() => ({ success: false, exists: false }))
        : Promise.resolve({ success: false, exists: false });
    const credentialsCheckPromise = checkEvotorCredentials().catch(() => false);

    Promise.all([orderCheckPromise, credentialsCheckPromise]).then(([orderResult, hasCredentials]) => {
        const lockStyle = (input) => {
            input.style.backgroundColor = '#333';
            input.style.color = '#aaa';
            input.style.border = '1px solid #444';
        };

        if (orderResult.success && orderResult.exists && orderResult.data?.receipt) {
            checkbox.checked = true;
            checkbox.disabled = true;
            checkbox.classList.add('p2p-analytics-checkbox-disabled');
            successMessage.style.display = 'block';
            conditionalInputs.style.display = 'block';
            conditionalInputs.style.opacity = '0.7';
            conditionalInputs.style.pointerEvents = 'none';
            conditionalInputs.style.filter = 'grayscale(100%)';

            const receipt = orderResult.data.receipt;
            if (contactInput)  { contactInput.value  = receipt.contact || '';                                        contactInput.readOnly  = true; lockStyle(contactInput); }
            if (rateInput)     { rateInput.value      = receipt.price  ?? '';                                        rateInput.readOnly     = true; lockStyle(rateInput); }
            if (quantityInput) { quantityInput.value  = receipt.amount ?? '';                                        quantityInput.readOnly = true; lockStyle(quantityInput); }
            if (costInput)     { costInput.value      = receipt.sum    ?? '';                                        costInput.readOnly     = true; lockStyle(costInput); }
        } else if (!hasCredentials) {
            checkbox.disabled = true;
            checkbox.classList.add('p2p-analytics-checkbox-disabled');
            warningMessage.style.display = 'block';
        } else {
            checkbox.checked = true;
            conditionalInputs.style.display = 'block';
            if (contactInput) contactInput.value = generateRandomGmail();
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
    const btn = document.createElement('button');
    btn.className = 'p2p-analytics-submit-button';
    btn.textContent = 'Отправить';
    btn.addEventListener('click', (e) => { e.preventDefault(); handleFormSubmission(); });
    return btn;
}

function createDeleteOrderButton() {
    const btn = document.createElement('button');
    btn.className = 'p2p-analytics-delete-button';
    btn.textContent = 'Удалить ордер';
    btn.style.marginTop = '8px';
    btn.style.display = 'none';

    const orderId = getOrderIdFromUrl();
    if (orderId) {
        checkOrderExists(orderId).then(result => {
            if (result.success && result.exists) btn.style.display = 'block';
        });
    }

    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const orderId = getOrderIdFromUrl();
        if (!orderId) { alert('Не удалось получить ID ордера из URL страницы'); return; }

        const confirmed = confirm('Если вы допустили ошибку в ордере - не удаляйте его, а пробейте повторно, с корректными данными. Удаление ордера требуется только в случае, если был пробит ордер, не относящийся к деятельности ИП.');
        if (!confirmed) return;

        const originalText = btn.textContent;
        btn.textContent = 'Удаление...';
        btn.disabled = true;
        try {
            const result = await deleteOrder(orderId);
            if (!result.success) { alert(`Ошибка при удалении ордера: ${result.error}`); return; }
            alert('Ордер успешно удален');
            setTimeout(() => window.location.reload(), 500);
        } catch (error) {
            alert(`Произошла ошибка при удалении ордера: ${error.message}`);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });

    return btn;
}

// --- WIDGET ---
let observer = null;
let isInitializing = false;
let isCreatingWidget = false;  // отдельный флаг для создания виджета
let currentUrl = window.location.href;
let urlWatchInterval = null;

let widgetCollapsed = false;
try {
    widgetCollapsed = localStorage.getItem('p2p-analytics-widget-collapsed-bingx') === 'true';
} catch (e) {}

async function createFloatingWidget() {
    if (document.querySelector('.p2p-analytics-widget')) return true;
    if (isCreatingWidget) return false;
    isCreatingWidget = true;

    try {
        const widget = document.createElement('div');
        widget.className = 'p2p-analytics-widget';
        if (widgetCollapsed) widget.classList.add('collapsed');

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'p2p-analytics-widget-toggle';
        toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>`;
        toggleBtn.addEventListener('click', () => {
            widgetCollapsed = !widgetCollapsed;
            widget.classList.toggle('collapsed', widgetCollapsed);
            try { localStorage.setItem('p2p-analytics-widget-collapsed-bingx', widgetCollapsed.toString()); } catch (e) {}
        });

        const panel = document.createElement('div');
        panel.className = 'p2p-analytics-widget-panel';

        const header = document.createElement('div');
        header.className = 'p2p-analytics-widget-header';
        header.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            <span>P2P Analytics (BingX)</span>
        `;

        const content = document.createElement('div');
        content.className = 'p2p-analytics-widget-content';
        content.appendChild(await createDropdownMenu());

        panel.appendChild(header);
        panel.appendChild(content);
        widget.appendChild(toggleBtn);
        widget.appendChild(panel);
        document.body.appendChild(widget);
        return true;
    } catch (error) {
        console.error('P2P Analytics: Error creating widget:', error);
        return false;
    } finally {
        isCreatingWidget = false;
    }
}

function cleanupResources() {
    if (observer) { observer.disconnect(); observer = null; }
    const w = document.querySelector('.p2p-analytics-widget');
    if (w) w.remove();
    isInitializing = false;
    isCreatingWidget = false;
    currentSellDisplayNameTemp = '';
    originalOwnName = '';
}

function initializeMutationObserver() {
    if (observer) observer.disconnect();
    let debounceTimer = null;

    observer = new MutationObserver(async () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            applyDisplayNameIfNeeded();
            if (currentSellDisplayNameTemp) {
                replaceCounterpartyNameInDomBingx(currentSellDisplayNameTemp);
            }
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

async function initialize() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        const urlPattern = /(bingx\.com|paycat\.com).*\/order\/\d+/;
        if (!urlPattern.test(window.location.href)) {
            cleanupResources();
            return;
        }

        if (!window.P2PAuth) {
            setTimeout(() => { isInitializing = false; initialize(); }, 1000);
            return;
        }

        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            cleanupResources();
            return;
        }

        await loadDisplayNameFromStorage();
        applyDisplayNameIfNeeded();
        initializeMutationObserver();
        await createFloatingWidget();

    } catch (error) {
        console.error('P2P Analytics: Initialization error:', error);
    } finally {
        isInitializing = false;
    }
}

function handleDocumentReady() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
}
handleDocumentReady();

function handleUrlChange() {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
        currentUrl = newUrl;
        cleanupResources();
        setTimeout(() => initialize(), 200);
    }
}

function ensureUrlWatcher() {
    if (!urlWatchInterval) {
        urlWatchInterval = setInterval(handleUrlChange, 300);
    }
}
ensureUrlWatcher();

window.addEventListener('popstate', handleUrlChange);
window.addEventListener('hashchange', handleUrlChange);

(function patchHistoryApi() {
    try {
        const origPush    = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function() {
            const r = origPush.apply(this, arguments);
            handleUrlChange();
            return r;
        };
        history.replaceState = function() {
            const r = origReplace.apply(this, arguments);
            handleUrlChange();
            return r;
        };
    } catch (e) {}
})();

window.addEventListener('beforeunload', cleanupResources);

if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'sync') return;
        if (changes.authToken) {
            if (!changes.authToken.newValue && changes.authToken.oldValue) {
                cleanupResources();
                window.P2PAuth.showAuthError('Вы вышли из системы. Для работы с расширением необходимо авторизоваться заново.');
            }
            if (changes.authToken.newValue && !changes.authToken.oldValue) {
                setTimeout(() => initialize(), 500);
            }
        }
        if (changes.displayName) {
            currentDisplayName = changes.displayName.newValue || '';
            if (currentDisplayName) {
                applyDisplayNameIfNeeded();
            } else if (isSellPage() && originalOwnName) {
                replaceOwnNameInPaymentMethodBingx(originalOwnName);
            }
        }
    });
}

try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === 'applySellName') {
            const name = (message.name || '').trim();
            if (!name) { sendResponse({ success: false, error: 'Имя пустое' }); return; }
            currentSellDisplayNameTemp = name;
            const replaced = replaceCounterpartyNameInDomBingx(name);
            sendResponse({ success: true, replaced });
            return true;
        }
    });
} catch (e) {}

})();