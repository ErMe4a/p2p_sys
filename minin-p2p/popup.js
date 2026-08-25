// API endpoint
const API_BASE_URL = 'https://mininp2p.ru';

// Safe guards for extension context
function isExtensionContextValid() {
    try {
        return !!(typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
        return false;
    }
}
function isContextInvalidationError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return msg.includes('Extension context invalidated');
}

// DOM elements
const loginForm = document.getElementById('loginForm');
const userInfo = document.getElementById('userInfo');
const authForm = document.getElementById('authForm');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const errorMessage = document.getElementById('errorMessage');
const statusMessage = document.getElementById('statusMessage');
const userName = document.getElementById('userName');
const userId = document.getElementById('userId');

// Display name elements
const displayNameInput = document.getElementById('displayName');
const saveDisplayNameBtn = document.getElementById('saveDisplayNameBtn');

// Theme toggle (default: light)
const POPUP_THEME_KEY = 'popupTheme';
function applyPopupTheme(mode) {
    const isLight = mode === 'light';
    document.documentElement.classList.toggle('light', isLight);
    document.body.classList.toggle('light', isLight);
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.textContent = isLight ? '🌙 Тёмная' : '☀️ Светлая';
        btn.title = isLight ? 'Переключить на тёмную тему' : 'Переключить на светлую тему';
    }
}
function initPopupTheme() {
    let mode = localStorage.getItem(POPUP_THEME_KEY) || 'light';
    applyPopupTheme(mode);
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            mode = mode === 'light' ? 'dark' : 'light';
            localStorage.setItem(POPUP_THEME_KEY, mode);
            applyPopupTheme(mode);
        });
    }
}

// New: SELL name ephemeral UI elements (created dynamically)
let sellDisplayNameInput;
let applySellDisplayNameBtn;



// Utility functions
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

function hideError() {
    errorMessage.textContent = '';
    errorMessage.style.display = 'none';
}

function showStatus(message, type = 'success') {
    statusMessage.innerHTML = `<div class="status ${type}">${message}</div>`;
    setTimeout(() => {
        statusMessage.innerHTML = '';
    }, 3000);
}

function setLoadingState(isLoading) {
    loginBtn.disabled = isLoading;
    loginBtn.textContent = isLoading ? 'Вход...' : 'Войти';
}

// Authentication functions
async function login(loginData) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Extension-Version': chrome.runtime.getManifest().version
            },
            body: JSON.stringify(loginData)
        });

        const data = await response.json();

        if (!response.ok) {
            // Handle different error codes
            if (response.status === 400) {
                throw new Error(data.message || 'Неверный логин или пароль');
            } else if (response.status === 500) {
                throw new Error(`Ошибка авторизации: ${data.message || 'Внутренняя ошибка сервера'}`);
            } else {
                throw new Error(`Ошибка: ${data.message || 'Неизвестная ошибка'}`);
            }
        }

        return {
            success: true,
            data: data
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

async function saveAuthData(authData) {
    try {
        if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.sync) return false;
        await chrome.storage.sync.set({
            'authToken': authData.token,
            'tokenType': authData.tokenType,
            'userId': authData.userId,
            'userLogin': authData.login,
            'tokenExpiry': Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days (1 month)
        });
        return true;
    } catch (error) {
        if (!isContextInvalidationError(error)) {
            console.error('Failed to save auth data:', error);
        }
        return false;
    }
}

async function clearAuthData() {
    try {
        if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.sync) return true;
        await chrome.storage.sync.remove(['authToken', 'tokenType', 'userId', 'userLogin', 'tokenExpiry']);
        return true;
    } catch (error) {
        if (!isContextInvalidationError(error)) {
            console.error('Failed to clear auth data:', error);
        }
        return false;
    }
}

async function getAuthData() {
    try {
        if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.sync) return null;
        const result = await chrome.storage.sync.get(['authToken', 'tokenType', 'userId', 'userLogin', 'tokenExpiry']);
        
        // Check if token is expired
        if (result.tokenExpiry && Date.now() > result.tokenExpiry) {
            await clearAuthData();
            return null;
        }
        
        if (result.authToken && result.userId && result.userLogin) {
            return {
                token: result.authToken,
                tokenType: result.tokenType,
                userId: result.userId,
                login: result.userLogin
            };
        }
        
        return null;
    } catch (error) {
        // Silence context invalidation noise when extension is reloaded/unloaded
        if (!isContextInvalidationError(error)) {
            console.error('Failed to get auth data:', error);
        }
        return null;
    }
}

// New: display name helpers
async function saveDisplayName(name) {
    try {
        if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.sync) return { success: false, error: 'Extension context unavailable' };
        await chrome.storage.sync.set({ displayName: name || '' });
        return { success: true };
    } catch (e) {
        if (!isContextInvalidationError(e)) {
            console.error('Failed to save display name:', e);
        }
        return { success: false, error: e?.message || 'Unknown error' };
    }
}

async function getDisplayName() {
    try {
        if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.sync) return '';
        const res = await chrome.storage.sync.get(['displayName']);
        return res.displayName || '';
    } catch (e) {
        if (!isContextInvalidationError(e)) {
            console.error('Failed to load display name:', e);
        }
        return '';
    }
}

// UI functions
function showLoginForm() {
    loginForm.style.display = 'block';
    userInfo.style.display = 'none';
    hideError();
}

function showUserInfo(authData) {
    loginForm.style.display = 'none';
    userInfo.style.display = 'block';
    userName.textContent = authData.login;
    userId.textContent = authData.userId;
    hideError();
    
    try {
        injectNameMenus();
    } catch (e) {
        console.warn('Failed to inject name menus:', e);
    }

    autoBindSaveDisplayName(); // ← ДОБАВИТЬ ЭТУ СТРОКУ

    getDisplayName().then((name) => {
        if (displayNameInput) {
            displayNameInput.value = name || '';
        }
    });
}

async function handleLogin(event) {
    event.preventDefault();
    
    const formData = new FormData(authForm);
    const loginData = {
        login: formData.get('login'),
        password: formData.get('password')
    };
    
    // Validate form
    if (!loginData.login || !loginData.password) {
        showError('Пожалуйста, заполните все поля');
        return;
    }
    
    setLoadingState(true);
    hideError();
    
    try {
        const result = await login(loginData);
        
        if (result.success) {
            const saved = await saveAuthData(result.data);
            
            if (saved) {
                showUserInfo(result.data);
                showStatus('Авторизация успешна!');
                
                // Clear form
                authForm.reset();
            } else {
                showError('Ошибка при сохранении данных авторизации');
            }
        } else {
            showError(result.error);
        }
    } catch (error) {
        showError('Произошла ошибка при авторизации');
        console.error('Login error:', error);
    } finally {
        setLoadingState(false);
    }
}

async function handleLogout() {
    const cleared = await clearAuthData();
    
    if (cleared) {
        showLoginForm();
        showStatus('Вы успешно вышли из системы');
    } else {
        showError('Ошибка при выходе из системы');
    }
}

// Event listeners
authForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

// New: display name save handler
function autoBindSaveDisplayName() {
    if (!saveDisplayNameBtn) return;
    saveDisplayNameBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const name = (displayNameInput?.value || '').trim();
        const result = await saveDisplayName(name);
        if (result.success) {
            try {
                if (isExtensionContextValid() && chrome.tabs) {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    const tabId = tabs && tabs[0] ? tabs[0].id : null;
                    if (tabId) {
                        chrome.tabs.sendMessage(tabId, { action: 'applyMyName', name }, () => {
                            if (chrome.runtime.lastError) { /* ignore */ }
                        });
                    }
                }
            } catch (_) { /* ignore */ }
            showStatus('Имя сохранено');
        } else {
            showError(result.error || 'Не удалось сохранить имя');
        }
    });
}

// New: inject collapsible BUY/SELL menus for name replacement
function injectNameMenus() {
    // Detect the existing name section by the save button
    const nameSection = saveDisplayNameBtn ? saveDisplayNameBtn.closest('.details-section') : null;
    if (!nameSection) return;

    // If menus already injected, skip
    if (document.getElementById('nameMenusContainer')) return;

    // Create container
    const container = document.createElement('div');
    container.id = 'nameMenusContainer';
    container.className = 'details-section';

    // Title
    const h3 = document.createElement('h3');
    h3.textContent = 'Замены имени';
    container.appendChild(h3);

    // Build BUY details: move existing input + save under a <details>
    const buyDetails = document.createElement('details');
    buyDetails.id = 'buyNameDetails';
    const buySummary = document.createElement('summary');
    buySummary.textContent = 'Заменить свое имя';
    buyDetails.appendChild(buySummary);

    // Move existing nodes
    const buyContent = document.createElement('div');
    // Move form-group (label + input)
    const formGroup = nameSection.querySelector('.form-group');
    if (formGroup) buyContent.appendChild(formGroup);
    // Move actions (save button)
    let formActions = nameSection.querySelector('.form-actions');
    if (!formActions) {
        formActions = document.createElement('div');
        formActions.className = 'form-actions';
        buyContent.appendChild(formActions);
    } else {
        buyContent.appendChild(formActions);
    }
    // Add reset BUY name button
    const resetBuyBtn = document.createElement('button');
    resetBuyBtn.className = 'btn';
    resetBuyBtn.id = 'resetBuyDisplayNameBtn';
    resetBuyBtn.textContent = 'Сбросить имя';
    formActions.appendChild(resetBuyBtn);

    buyDetails.appendChild(buyContent);

    // Build SELL details: ephemeral input + apply button
    const sellDetails = document.createElement('details');
    sellDetails.id = 'sellNameDetails';
    const sellSummary = document.createElement('summary');
    sellSummary.textContent = 'Информация о контрагенте';
    sellDetails.appendChild(sellSummary);

    const sellContent = document.createElement('div');

    const sellFormGroup = document.createElement('div');
    sellFormGroup.className = 'form-group';
    sellFormGroup.style.marginBottom = '0';
    const sellLabel = document.createElement('label');
    sellLabel.setAttribute('for', 'sellDisplayName');
    sellLabel.textContent = '';
    sellDisplayNameInput = document.createElement('input');
    sellDisplayNameInput.type = 'text';
    sellDisplayNameInput.id = 'sellDisplayName';
    sellDisplayNameInput.placeholder = 'Никнейм';
    sellFormGroup.appendChild(sellLabel);
    sellFormGroup.appendChild(sellDisplayNameInput);

    const nameFormGroup = document.createElement('div');
    nameFormGroup.className = 'form-group';
    nameFormGroup.style.marginBottom = '0';
    const nameLabel = document.createElement('label');
    
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'sellRealName';
    nameInput.placeholder = 'Имя';
    nameFormGroup.appendChild(nameLabel);
    nameFormGroup.appendChild(nameInput);

    const nameActions = document.createElement('div');
    nameActions.className = 'form-actions';
    nameActions.style.marginTop = '2px';
    const applyNameBtn = document.createElement('button');
    applyNameBtn.className = 'btn';
    applyNameBtn.id = 'applyRealNameBtn';
    applyNameBtn.textContent = 'Применить имя';
    nameActions.appendChild(applyNameBtn);

    const sellActions = document.createElement('div');
    sellActions.className = 'form-actions';
    sellActions.style.marginTop = '4px';
    sellActions.style.marginBottom = '8px';
    applySellDisplayNameBtn = document.createElement('button');
    applySellDisplayNameBtn.className = 'btn';
    applySellDisplayNameBtn.id = 'applySellDisplayNameBtn';
    applySellDisplayNameBtn.textContent = 'Применить никнейм';
    sellActions.appendChild(applySellDisplayNameBtn);

    // НОВОЕ: кнопка сброса замен контрагента (никнейм + имя) — теперь под блоком "Имя"
    const resetCounterpartyActions = document.createElement('div');
    resetCounterpartyActions.className = 'form-actions';
    resetCounterpartyActions.style.marginTop = '4px';
    const resetCounterpartyBtn = document.createElement('button');
    resetCounterpartyBtn.className = 'btn';
    resetCounterpartyBtn.id = 'resetCounterpartyNamesBtn';
    resetCounterpartyBtn.textContent = 'Сбросить замены';
    resetCounterpartyActions.appendChild(resetCounterpartyBtn);

    // Правильный порядок:
    sellContent.appendChild(sellFormGroup);    // Никнейм
    sellContent.appendChild(sellActions);      // Применить никнейм
    sellContent.appendChild(nameFormGroup);    // Реальное имя
    sellContent.appendChild(nameActions);      // Применить имя
    sellContent.appendChild(resetCounterpartyActions); // Сбросить замены (под именем)
    sellDetails.appendChild(sellContent);

    // Append details to container
    container.appendChild(buyDetails);
    container.appendChild(sellDetails);

    // Insert container before original section and then hide/remove original shell
    nameSection.parentElement.insertBefore(container, nameSection);
    // Remove the now-empty nameSection wrapper
    nameSection.remove();

    // Bind SELL apply button
    if (applySellDisplayNameBtn) {
        applySellDisplayNameBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const name = (sellDisplayNameInput?.value || '').trim();
            if (!name) {
                showError('Пожалуйста, введите имя для SELL');
                return;
            }
            try {
                if (!isExtensionContextValid() || !chrome.tabs) {
                    showError('Невозможно применить имя: контекст расширения недоступен');
                    return;
                }
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabId = tabs && tabs[0] ? tabs[0].id : null;
                if (!tabId) {
                    showError('Не найдена активная вкладка');
                    return;
                }
                chrome.tabs.sendMessage(tabId, { action: 'applySellName', name }, (response) => {
                    if (chrome.runtime.lastError) {
                        showError(chrome.runtime.lastError.message || 'Ошибка отправки сообщения');
                        return;
                    }
                    if (response && response.success) {
                        showStatus('Имя применено для SELL на странице');
                    } else {
                        showError(response?.error || 'Не удалось применить имя для SELL');
                    }
                });
            } catch (err) {
                console.error('Failed to apply SELL name:', err);
                showError('Не удалось применить имя для SELL');
            }
        });
    }

    // Bind кнопку применения реального имени
    const applyRealNameBtnEl = document.getElementById('applyRealNameBtn');
    if (applyRealNameBtnEl) {
        applyRealNameBtnEl.addEventListener('click', async (e) => {
            e.preventDefault();
            const name = (document.getElementById('sellRealName')?.value || '').trim();
            if (!name) { showError('Введите реальное имя'); return; }
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = tabs?.[0]?.id;
            if (!tabId) { showError('Не найдена активная вкладка'); return; }
            chrome.tabs.sendMessage(tabId, { action: 'applyRealName', name }, (response) => {
                if (chrome.runtime.lastError) { showError(chrome.runtime.lastError.message); return; }
                if (response?.success) showStatus('Реальное имя применено');
                else showError(response?.error || 'Ошибка');
            });
        });
    }

    // НОВОЕ: Bind кнопку сброса замен контрагента (работает и для никнейма, и для имени)
    const resetCounterpartyBtnEl = document.getElementById('resetCounterpartyNamesBtn');
    if (resetCounterpartyBtnEl) {
        resetCounterpartyBtnEl.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                if (!isExtensionContextValid() || !chrome.tabs) {
                    showError('Невозможно сбросить: контекст расширения недоступен');
                    return;
                }
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabId = tabs && tabs[0] ? tabs[0].id : null;
                if (!tabId) {
                    showError('Не найдена активная вкладка');
                    return;
                }
                chrome.tabs.sendMessage(tabId, { action: 'resetCounterpartyNames' }, (response) => {
                    if (chrome.runtime.lastError) {
                        showError(chrome.runtime.lastError.message || 'Ошибка отправки сообщения');
                        return;
                    }
                    if (response && response.success) {
                        showStatus('Оригинальные имена восстановлены');
                        if (sellDisplayNameInput) sellDisplayNameInput.value = '';
                        const realNameInput = document.getElementById('sellRealName');
                        if (realNameInput) realNameInput.value = '';
                    } else {
                        showError(response?.error || 'Не удалось сбросить');
                    }
                });
            } catch (err) {
                console.error('Failed to reset counterparty names:', err);
                showError('Не удалось сбросить замены контрагента');
            }
        });
    }

    // Bind BUY reset button
    const resetBuyBtnEl = document.getElementById('resetBuyDisplayNameBtn');
    if (resetBuyBtnEl) {
        resetBuyBtnEl.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                if (!isExtensionContextValid() || !chrome.tabs) {
                    showError('Невозможно сбросить имя: контекст расширения недоступен');
                    return;
                }
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabId = tabs && tabs[0] ? tabs[0].id : null;
                if (!tabId) {
                    showError('Не найдена активная вкладка');
                    return;
                }
                chrome.tabs.sendMessage(tabId, { action: 'resetBuyName' }, (response) => {
                    if (chrome.runtime.lastError) {
                        showError(chrome.runtime.lastError.message || 'Ошибка отправки сообщения');
                        return;
                    }
                    if (response && response.success) {
                        showStatus('Имя BUY сброшено');
                        if (displayNameInput) displayNameInput.value = '';
                    } else {
                        showError(response?.error || 'Не удалось сбросить имя BUY');
                    }
                });
            } catch (err) {
                console.error('Failed to reset BUY name:', err);
                showError('Не удалось сбросить имя BUY');
            }
        });
    }
}

// Initialize popup
async function initPopup() {
    try {
        const authData = await getAuthData();
        
        if (authData) {
            showUserInfo(authData);
        } else {
            showLoginForm();
        }
    } catch (error) {
        console.error('Failed to initialize popup:', error);
        showLoginForm();
    }
}

// Check auth status periodically
function startAuthCheck() {
    // Check every minute if token is still valid
    setInterval(async () => {
        try {
            const authData = await getAuthData();
            if (!authData && userInfo.style.display === 'block') {
                showLoginForm();
                showStatus('Сессия истекла. Войдите снова.', 'error');
            }
        } catch (e) {
            // Ignore context invalidation during periodic checks
        }
    }, 60000); // 1 minute
}

// Start initialization
document.addEventListener('DOMContentLoaded', () => {
    // Check that all required DOM elements exist
    if (!loginForm || !userInfo || !authForm || !loginBtn || !logoutBtn || 
        !errorMessage || !statusMessage || !userName || !userId) {
        console.error('Missing required DOM elements');
        return;
    }
    
    initPopupTheme();
    initPopup();
    startAuthCheck();
});

// Handle form submission with Enter key
document.addEventListener('keypress', (event) => {
    if (event.key === 'Enter' && loginForm.style.display === 'block') {
        handleLogin(event);
    }
});