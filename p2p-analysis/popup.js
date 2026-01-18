// API endpoint
const API_BASE_URL = 'http://127.0.0.1:8000';
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

// Details management elements
const detailsList = document.getElementById('detailsList');
const addDetailForm = document.getElementById('addDetailForm');
const detailForm = document.getElementById('detailForm');
const showAddDetailBtn = document.getElementById('showAddDetailBtn');
const addDetailBtn = document.getElementById('addDetailBtn');
const cancelDetailBtn = document.getElementById('cancelDetailBtn');
const refreshDetailsBtn = document.getElementById('refreshDetailsBtn');
const detailNameInput = document.getElementById('detailName');
// Add display name elements
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
                'Accept': 'application/json'
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

// Helper function for authenticated requests
async function makeAuthenticatedRequest(url, options = {}) {
    const authData = await getAuthData();
    
    if (!authData) {
        throw new Error('Не авторизован');
    }
    
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${authData.token}`,
        ...options.headers
    };
    
    const response = await fetch(url, {
        ...options,
        headers
    });
    
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        
        if (response.status === 401) {
            await clearAuthData();
            throw new Error('Сессия истекла. Войдите снова.');
        } else if (response.status === 403) {
            throw new Error('Доступ запрещен');
        } else if (response.status === 404) {
            throw new Error('Ресурс не найден');
        } else if (response.status === 500) {
            throw new Error(`Ошибка сервера: ${errorData.message || 'Внутренняя ошибка сервера'}`);
        } else {
            throw new Error(`Ошибка ${response.status}: ${errorData.message || 'Неизвестная ошибка'}`);
        }
    }
    
    return response;
}

// Details API functions
async function fetchDetails() {
    try {
        const response = await makeAuthenticatedRequest(`${API_BASE_URL}/api/details`);
        const details = await response.json();
        return {
            success: true,
            data: details
        };
    } catch (error) {
        console.error('Error fetching details:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function createDetail(name) {
    try {
        const response = await makeAuthenticatedRequest(`${API_BASE_URL}/api/details`, {
            method: 'POST',
            body: JSON.stringify({ name })
        });
        
        const result = await response.json();
        return {
            success: true,
            data: result
        };
    } catch (error) {
        console.error('Error creating detail:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function deleteDetail(id) {
    try {
        await makeAuthenticatedRequest(`${API_BASE_URL}/api/details/${id}`, {
            method: 'DELETE'
        });
        
        return {
            success: true
        };
    } catch (error) {
        console.error('Error deleting detail:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// UI functions
function showLoginForm() {
    loginForm.style.display = 'block';
    userInfo.style.display = 'none';
    hideError();
    
    // Clear details list when showing login form
    if (detailsList) {
        detailsList.innerHTML = '';
    }
    
    // Hide add detail form if it was shown
    if (addDetailForm) {
        hideAddDetailForm();
    }
}

function initRequisitesCollapse() {
    try {
        const sections = document.querySelectorAll('.details-section');
        const requisitesSection = Array.from(sections).find(sec => {
            const h3 = sec.querySelector('h3');
            return h3 && (h3.textContent || '').trim().startsWith('Реквизиты');
        });
        if (!requisitesSection) return;
        if (requisitesSection.dataset.collapsibleInitialized === 'true') return;
        requisitesSection.dataset.collapsibleInitialized = 'true';

        const title = requisitesSection.querySelector('h3');
        if (!title) return;

        // Create a minimal triangle indicator using Unicode
        const indicator = document.createElement('span');
        indicator.textContent = '▸'; // closed state
        indicator.style.marginLeft = '8px';
        indicator.style.opacity = '.8';
        indicator.style.cursor = 'pointer';

        // Ensure title is clickable and has compact inline layout
        title.style.display = 'inline-flex';
        title.style.alignItems = 'center';
        title.style.cursor = 'pointer';

        // Insert indicator after the title text
        title.appendChild(indicator);

        // Collapsible container (hidden by default)
        const wrapper = document.createElement('div');
        wrapper.id = 'requisitesCollapseContent';
        wrapper.style.display = 'none';

        const nodesToMove = [];
        let node = title.nextSibling;
        while (node) {
            const next = node.nextSibling;
            nodesToMove.push(node);
            node = next;
        }
        nodesToMove.forEach(n => wrapper.appendChild(n));
        requisitesSection.appendChild(wrapper);

        // Toggle handler
        const toggle = () => {
            const isHidden = wrapper.style.display === 'none';
            wrapper.style.display = isHidden ? 'block' : 'none';
            indicator.textContent = isHidden ? '▾' : '▸';
        };

        title.addEventListener('click', toggle);
        indicator.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    } catch (e) {
        console.warn('Failed to initialize requisites collapse:', e);
    }
}

function showUserInfo(authData) {
    loginForm.style.display = 'none';
    userInfo.style.display = 'block';
    userName.textContent = authData.login;
    userId.textContent = authData.userId;
    hideError();
    
    // Load details when user info is shown
    loadDetails();

    // Inject BUY/SELL name menus (collapsible)
    try {
        injectNameMenus();
    } catch (e) {
        console.warn('Failed to inject name menus:', e);
    }

    // Initialize requisites collapse (hidden by default, toggled by title click)
    initRequisitesCollapse();

    // Load saved display name
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

// Details management functions
async function loadDetails() {
    try {
        detailsList.innerHTML = '<div class="loading">Загрузка реквизитов...</div>';
        
        const result = await fetchDetails();
        
        if (result.success) {
            renderDetails(result.data);
        } else {
            detailsList.innerHTML = `<div class="error">Ошибка загрузки: ${result.error}</div>`;
        }
    } catch (error) {
        console.error('Error loading details:', error);
        detailsList.innerHTML = '<div class="error">Произошла ошибка при загрузке реквизитов</div>';
    }
}

function renderDetails(details) {
    if (!details || details.length === 0) {
        detailsList.innerHTML = '<div class="empty-state">Реквизиты не найдены</div>';
        return;
    }
    
    const detailsHtml = details.map(detail => `
        <div class="detail-item">
            <div class="detail-text">${escapeHtml(detail.name)}</div>
            <div class="detail-actions">
                <button class="btn-small btn-danger" data-detail-id="${detail.id}">
                    Удалить
                </button>
            </div>
        </div>
    `).join('');
    
    detailsList.innerHTML = detailsHtml;
    
    // Add event listeners to delete buttons
    const deleteButtons = detailsList.querySelectorAll('.btn-danger');
    deleteButtons.forEach(button => {
        button.addEventListener('click', (event) => {
            const detailId = parseInt(event.target.getAttribute('data-detail-id'));
            handleDeleteDetail(detailId, event.target);
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showAddDetailForm() {
    addDetailForm.style.display = 'block';
    showAddDetailBtn.style.display = 'none';
    detailNameInput.focus();
}

function hideAddDetailForm() {
    addDetailForm.style.display = 'none';
    showAddDetailBtn.style.display = 'block';
    detailForm.reset();
}

async function handleAddDetail(event) {
    event.preventDefault();
    
    const name = detailNameInput.value.trim();
    
    if (!name) {
        showError('Пожалуйста, введите реквизиты');
        return;
    }
    
    // Set loading state
    addDetailBtn.disabled = true;
    addDetailBtn.textContent = 'Добавление...';
    
    try {
        const result = await createDetail(name);
        
        if (result.success) {
            showStatus('Реквизит успешно добавлен');
            hideAddDetailForm();
            loadDetails(); // Refresh the list
        } else {
            showError(result.error);
        }
    } catch (error) {
        console.error('Error adding detail:', error);
        showError('Произошла ошибка при добавлении реквизита');
    } finally {
        // Reset button state
        addDetailBtn.disabled = false;
        addDetailBtn.textContent = 'Добавить';
    }
}

async function handleDeleteDetail(id, buttonElement = null) {
    if (!id || isNaN(id)) {
        showError('Неверный ID реквизита');
        return;
    }
    
    if (!confirm('Вы уверены, что хотите удалить этот реквизит?')) {
        return;
    }
    
    // Set loading state for the button
    if (buttonElement) {
        buttonElement.disabled = true;
        buttonElement.textContent = 'Удаление...';
    }
    
    try {
        const result = await deleteDetail(id);
        
        if (result.success) {
            showStatus('Реквизит успешно удален');
            loadDetails(); // Refresh the list
        } else {
            showError(result.error);
        }
    } catch (error) {
        console.error('Error deleting detail:', error);
        showError('Произошла ошибка при удалении реквизита');
    } finally {
        // Reset button state
        if (buttonElement) {
            buttonElement.disabled = false;
            buttonElement.textContent = 'Удалить';
        }
    }
}

// Event listeners
authForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

// New: display name save handler
autoBindSaveDisplayName();
function autoBindSaveDisplayName() {
    if (!saveDisplayNameBtn) return;
    saveDisplayNameBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const name = (displayNameInput?.value || '').trim();
        const result = await saveDisplayName(name);
        if (result.success) {
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
    sellSummary.textContent = 'Заменить имя контрагента';
    sellDetails.appendChild(sellSummary);

    const sellContent = document.createElement('div');

    const sellFormGroup = document.createElement('div');
    sellFormGroup.className = 'form-group';
    const sellLabel = document.createElement('label');
    sellLabel.setAttribute('for', 'sellDisplayName');
    sellLabel.textContent = '';
    sellDisplayNameInput = document.createElement('input');
    sellDisplayNameInput.type = 'text';
    sellDisplayNameInput.id = 'sellDisplayName';
    sellDisplayNameInput.placeholder = 'Введите имя для продажи';
    sellFormGroup.appendChild(sellLabel);
    sellFormGroup.appendChild(sellDisplayNameInput);

    const sellActions = document.createElement('div');
    sellActions.className = 'form-actions';
    applySellDisplayNameBtn = document.createElement('button');
    applySellDisplayNameBtn.className = 'btn';
    applySellDisplayNameBtn.id = 'applySellDisplayNameBtn';
    applySellDisplayNameBtn.textContent = 'Применить на текущей странице';
    sellActions.appendChild(applySellDisplayNameBtn);

    sellContent.appendChild(sellFormGroup);
    sellContent.appendChild(sellActions);
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

//
// Details management event listeners
showAddDetailBtn.addEventListener('click', showAddDetailForm);
cancelDetailBtn.addEventListener('click', hideAddDetailForm);
detailForm.addEventListener('submit', handleAddDetail);
refreshDetailsBtn.addEventListener('click', loadDetails);

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
    
    // Check that details management elements exist
    if (!detailsList || !addDetailForm || !detailForm || !showAddDetailBtn || 
        !addDetailBtn || !cancelDetailBtn || !refreshDetailsBtn || !detailNameInput) {
        console.error('Missing details management DOM elements');
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