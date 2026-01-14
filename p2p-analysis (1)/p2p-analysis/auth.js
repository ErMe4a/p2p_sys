// Authentication helper functions for content script

// API endpoint
const API_BASE_URL = 'https://p2p-analysis.app';

// Storage keys
const STORAGE_KEYS = {
    AUTH_TOKEN: 'authToken',
    TOKEN_TYPE: 'tokenType',
    USER_ID: 'userId',
    USER_LOGIN: 'userLogin',
    TOKEN_EXPIRY: 'tokenExpiry'
};

function isExtensionContextValid() {
    try {
        return !!(typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.sync);
    } catch (_) {
        return false;
    }
}

function isContextInvalidationError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return msg.includes('Extension context invalidated');
}

/**
 * Get authentication data from storage
 */
async function getAuthData() {
    try {
        if (!isExtensionContextValid()) {
            return null;
        }
        const result = await chrome.storage.sync.get(Object.values(STORAGE_KEYS));
        
        // Check if token is expired
        if (result.tokenExpiry && Date.now() > result.tokenExpiry) {
            await clearAuthData();
            return null;
        }
        
        if (result.authToken && result.userId && result.userLogin) {
            return {
                token: result.authToken,
                tokenType: result.tokenType || 'Bearer',
                userId: result.userId,
                login: result.userLogin
            };
        }
        
        return null;
    } catch (error) {
        // Silently return null on any failure, including extension context invalidation
        return null;
    }
}

/**
 * Clear authentication data from storage
 */
async function clearAuthData() {
    try {
        if (!isExtensionContextValid()) {
            return false;
        }
        await chrome.storage.sync.remove(Object.values(STORAGE_KEYS));
        return true;
    } catch (error) {
        // Ignore errors on context invalidation
        return false;
    }
}

/**
 * Create authorization headers
 */
function createAuthHeaders(authData) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    
    if (authData && authData.token) {
        headers['Authorization'] = `${authData.tokenType} ${authData.token}`;
    }
    
    return headers;
}

/**
 * Make authenticated API request
 */
async function makeAuthenticatedRequest(url, options = {}) {
    const authData = await getAuthData();
    
    if (!authData) {
        throw new Error('Не авторизован. Пожалуйста, войдите в систему.');
    }
    
    const headers = createAuthHeaders(authData);
    
    const requestOptions = {
        ...options,
        headers: {
            ...headers,
            ...options.headers
        }
    };
    
    try {
        const response = await fetch(url, requestOptions);
        
        // Handle 429 - rate limiting (DO NOT clear auth)
        if (response.status === 429) {
            console.warn('Rate limiting detected (429)');
            throw new Error('Слишком много запросов. Попробуйте позже.');
        }
        
        // Handle 403 - could be token expired, rate limiting, or resource access denied
        if (response.status === 403) {
            let errorData = {};
            try {
                const clonedResponse = response.clone();
                errorData = await clonedResponse.json();
            } catch (_) { /* ignore parse errors */ }
            
            const errorMsg = errorData.message || errorData.error || '';
            
            // If it's rate limiting, don't clear auth
            if (/rate limit|too many|quota|слишком много/i.test(errorMsg)) {
                console.warn('Rate limiting detected (403), not clearing auth');
                throw new Error('Слишком много запросов. Попробуйте позже.');
            }
            
            // If it's access denied to a specific resource (not auth issue), don't clear auth
            // Common patterns: "forbidden", "access denied", "not authorized to access this resource"
            if (/forbidden|access denied|not authorized to access|доступ запрещен|нет доступа/i.test(errorMsg)) {
                console.warn('Access denied to resource (403), not clearing auth');
                throw new Error('Доступ запрещен');
            }
            
            // Check if request was for a specific resource (like /api/order?id=...)
            // In this case, 403 likely means "not your order" rather than "invalid token"
            if (url.includes('/api/order?id=') || url.includes('/api/order/')) {
                console.warn('Access denied to order resource (403), not clearing auth');
                throw new Error('Нет доступа к этому ордеру');
            }
            
            // Real auth error - clear session
            console.log('Token expired or invalid, clearing auth data');
            await clearAuthData();
            throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
        }
        
        // Handle other errors
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }
        
        return response;
    } catch (error) {
        // If it's a network error or fetch error, re-throw
        if (error.name === 'TypeError' || error.name === 'NetworkError') {
            throw new Error('Ошибка сети. Проверьте подключение к интернету.');
        }
        
        throw error;
    }
}

/**
 * Show authentication error to user (CSP-safe, no inline handlers)
 */
function showAuthError(message, showLoginButton = true) {
    // Create a notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff6b6b;
        color: white;
        padding: 15px 20px;
        border-radius: 5px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        z-index: 10000;
        font-family: Arial, sans-serif;
        font-size: 14px;
        max-width: 350px;
        word-wrap: break-word;
    `;

    const wrapper = document.createElement('div');

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.marginBottom = '5px';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.color = 'white';
    closeBtn.style.fontSize = '16px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.marginLeft = '10px';
    closeBtn.addEventListener('click', () => {
        if (notification.parentElement) notification.remove();
    });

    header.appendChild(msgSpan);
    header.appendChild(closeBtn);

    wrapper.appendChild(header);

    if (showLoginButton) {
        const hint = document.createElement('div');
        hint.style.marginTop = '8px';
        hint.style.fontSize = '12px';
        hint.style.opacity = '0.9';
        hint.textContent = 'Нажмите на иконку расширения для входа в систему';
        wrapper.appendChild(hint);
    }

    notification.appendChild(wrapper);
    document.body.appendChild(notification);
    
    // Auto-remove after 8 seconds (longer for auth errors)
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 8000);
}

/**
 * Check if user is authenticated
 */
async function isAuthenticated() {
    const authData = await getAuthData();
    return authData !== null;
}

/**
 * Get current user info from storage
 */
async function getCurrentUser() {
    const authData = await getAuthData();
    if (!authData) {
        return null;
    }
    
    return {
        id: authData.userId,
        login: authData.login
    };
}

/**
 * Get detailed current user info from API
 */
async function getCurrentUserFromAPI() {
    try {
        const response = await makeAuthenticatedRequest(
            `${API_BASE_URL}/api/users/me`,
            {
                method: 'GET'
            }
        );
        
        const userData = await response.json();
        return {
            success: true,
            data: userData
        };
    } catch (error) {
        console.error('Error fetching current user from API:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Update current user info
 */
async function updateCurrentUser(userData) {
    try {
        const response = await makeAuthenticatedRequest(
            `${API_BASE_URL}/api/users/me`,
            {
                method: 'PUT',
                body: JSON.stringify(userData)
            }
        );
        
        const updatedUser = await response.json();
        return {
            success: true,
            data: updatedUser
        };
    } catch (error) {
        console.error('Error updating current user:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get current user's orders
 */
async function getCurrentUserOrders() {
    try {
        const response = await makeAuthenticatedRequest(
            `${API_BASE_URL}/api/order/my`,
            {
                method: 'GET'
            }
        );
        
        const orders = await response.json();
        return {
            success: true,
            data: orders
        };
    } catch (error) {
        console.error('Error fetching user orders:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Upload screenshot
 */
async function uploadScreenshot(file, name) {
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', name);
        
        const authData = await getAuthData();
        if (!authData) {
            throw new Error('Не авторизован. Пожалуйста, войдите в систему.');
        }
        
        const response = await fetch(`${API_BASE_URL}/api/order/screenshot`, {
            method: 'POST',
            headers: {
                'Authorization': `${authData.tokenType} ${authData.token}`
                // Content-Type не указываем для FormData
            },
            body: formData
        });
        
        // Handle 429 - rate limiting (DO NOT clear auth)
        if (response.status === 429) {
            console.warn('Rate limiting detected on upload (429)');
            throw new Error('Слишком много запросов. Попробуйте позже.');
        }
        
        // Handle 403 - could be token expired, rate limiting, or resource access denied
        if (response.status === 403) {
            let errorData = {};
            try {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    const clonedResponse = response.clone();
                    errorData = await clonedResponse.json();
                }
            } catch (_) { /* ignore parse errors */ }
            
            const errorMsg = errorData.message || errorData.error || '';
            
            // If it's rate limiting, don't clear auth
            if (/rate limit|too many|quota|слишком много/i.test(errorMsg)) {
                console.warn('Rate limiting detected on upload (403), not clearing auth');
                throw new Error('Слишком много запросов. Попробуйте позже.');
            }
            
            // If it's access denied to a specific resource, don't clear auth
            if (/forbidden|access denied|not authorized to access|доступ запрещен|нет доступа/i.test(errorMsg)) {
                console.warn('Access denied to resource on upload (403), not clearing auth');
                throw new Error('Доступ запрещен');
            }
            
            // Real auth error - clear session
            console.log('Token expired or invalid on upload, clearing auth data');
            await clearAuthData();
            throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
        }
        
        if (!response.ok) {
            // Try to get error message from response
            let errorMessage = `HTTP error! status: ${response.status}`;
            try {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    const errorData = await response.json();
                    errorMessage = errorData.message || errorMessage;
                } else {
                    const errorText = await response.text();
                    errorMessage = errorText || errorMessage;
                }
            } catch (parseError) {
                console.error('Error parsing error response:', parseError);
            }
            throw new Error(errorMessage);
        }
        
        // Try to parse response - could be JSON or text
        let result;
        try {
            const contentType = response.headers.get('content-type');
            console.log('Upload response content-type:', contentType);
            
            if (contentType && contentType.includes('application/json')) {
                result = await response.json();
                console.log('Parsed JSON response:', result);
            } else {
                result = await response.text();
                console.log('Got text response:', result);
            }
        } catch (parseError) {
            console.error('Error parsing response:', parseError);
            // If parsing fails, treat as text
            result = await response.text();
            console.log('Fallback to text response:', result);
        }
        
        return {
            success: true,
            data: result
        };
    } catch (error) {
        console.error('Error uploading screenshot:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get screenshot by name
 */
async function getScreenshot(name) {
    try {
        const response = await makeAuthenticatedRequest(
            `${API_BASE_URL}/api/order/screenshot?name=${encodeURIComponent(name)}`,
            {
                method: 'GET'
            }
        );
        
        // Return the response directly for binary data
        return response;
    } catch (error) {
        console.error('Error fetching screenshot:', error);
        throw error;
    }
}

/**
 * Create bank detail
 */
async function createBankDetail(detailData) {
    try {
        const response = await makeAuthenticatedRequest(
            `${API_BASE_URL}/api/details`,
            {
                method: 'POST',
                body: JSON.stringify(detailData)
            }
        );
        
        const result = await response.json();
        return {
            success: true,
            data: result
        };
    } catch (error) {
        console.error('Error creating bank detail:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Export functions for use in content script
window.P2PAuth = {
    getAuthData,
    clearAuthData,
    createAuthHeaders,
    makeAuthenticatedRequest,
    showAuthError,
    isAuthenticated,
    getCurrentUser,
    getCurrentUserFromAPI,
    updateCurrentUser,
    getCurrentUserOrders,
    uploadScreenshot,
    getScreenshot,
    createBankDetail,
    API_BASE_URL
}; 