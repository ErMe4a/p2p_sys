// P2P Analytics - Common API functions
// Shared between content.js (Bybit) and htx.js (HTX)

// Commission type constants
const COMMISSION_TYPE_PERCENT = 'PERCENT';
const COMMISSION_TYPE_MONEY = 'MONEY';

// ============================================
// API Functions
// ============================================

/**
 * Fetch Bank Details from API
 * @returns {Promise<{success: boolean, data: Array, error?: string}>}
 */
async function fetchBankDetails() {
    try {
        // Check if user is authenticated
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для получения данных банков');
            return {
                success: false,
                error: 'Не авторизован',
                data: []
            };
        }

        const response = await window.P2PAuth.makeAuthenticatedRequest(
            `${window.P2PAuth.API_BASE_URL}/api/details`,
            {
                method: 'GET'
            }
        );

        const bankDetails = await response.json();
        return {
            success: true,
            data: bankDetails
        };
    } catch (error) {
        console.error('Error fetching bank details:', error);
        
        // Show error to user
        window.P2PAuth.showAuthError(error.message);
        
        return {
            success: false,
            error: error.message,
            data: []
        };
    }
}

/**
 * Check if Order Exists on API
 * @param {string} orderId - Order ID (MUST be string to preserve precision for large IDs)
 * @param {number} exchangeType - Exchange type (1=Bybit, 2=HTX)
 * @returns {Promise<{success: boolean, exists: boolean, data?: Object, error?: string}>}
 */
async function checkOrderExists(orderId, exchangeType) {
    try {
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            return {
                success: false,
                exists: false,
                error: 'Не авторизован'
            };
        }

        // Ensure orderId is string to prevent precision loss for large numbers
        const orderIdString = String(orderId);
        
        const response = await window.P2PAuth.makeAuthenticatedRequest(
            `${window.P2PAuth.API_BASE_URL}/api/order?id=${orderIdString}&exchangeType=${exchangeType}`,
            {
                method: 'GET'
            }
        );

        if (response.status === 404) {
            console.log('P2P Analytics: Order not found (404)');
            return {
                success: true,
                exists: false
            };
        }

        if (!response.ok) {
            console.warn('P2P Analytics: Error checking order existence:', response.status);
            return {
                success: false,
                exists: false,
                error: `HTTP ${response.status}`
            };
        }

        const order = await response.json();
        
        // Validate Order structure - check if orderId exists and matches
        // Always compare as strings to handle large numbers correctly
        const orderExists = order && order.orderId && String(order.orderId) === orderIdString;
        
        console.log('P2P Analytics: Order check result:', {
            orderId: orderIdString,
            exchangeType: exchangeType,
            responseOrderId: order?.orderId,
            exists: orderExists
        });
        
        return {
            success: true,
            exists: orderExists,
            data: order
        };
    } catch (error) {
        console.error('Error checking order existence:', error);
        return {
            success: false,
            exists: false,
            error: error.message
        };
    }
}

/**
 * Save Order to API
 * @param {Object} orderData - Order data to save
 * @param {string} orderData.orderId - Order ID (MUST be string to preserve precision for large IDs)
 * @returns {Promise<{success: boolean, orderId?: string, message?: string, error?: string}>}
 */
async function saveOrder(orderData) {
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

        // Ensure orderId is always a string to prevent precision loss for large numbers
        if (orderData.orderId) {
            orderData.orderId = String(orderData.orderId);
        }

        const response = await window.P2PAuth.makeAuthenticatedRequest(
            `${window.P2PAuth.API_BASE_URL}/api/order`,
            {
                method: 'POST',
                body: JSON.stringify(orderData)
            }
        );

        const orderId = await response.json();
        return {
            success: true,
            orderId: orderId,
            message: 'Order saved successfully'
        };
    } catch (error) {
        console.error('Error saving order:', error);
        
        // Show error to user
        window.P2PAuth.showAuthError(error.message);
        
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Delete Order from API
 * @param {string} orderId - Order ID to delete (MUST be string to preserve precision for large IDs)
 * @param {number} exchangeType - Exchange type (1=Bybit, 2=HTX)
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function deleteOrder(orderId, exchangeType) {
    try {
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            window.P2PAuth.showAuthError('Необходимо авторизоваться для удаления ордера');
            return {
                success: false,
                error: 'Не авторизован'
            };
        }

        // Ensure orderId is string to prevent precision loss for large numbers
        const orderIdString = String(orderId);

        const response = await window.P2PAuth.makeAuthenticatedRequest(
            `${window.P2PAuth.API_BASE_URL}/api/order/${orderIdString}?exchangeType=${exchangeType}`,
            {
                method: 'DELETE'
            }
        );

        if (!response.ok) {
            let serverMessage = '';
            try {
                const errJson = await response.json();
                serverMessage = errJson?.message || '';
            } catch (_) { /* noop */ }
            throw new Error(serverMessage || `Ошибка удаления ордера (HTTP ${response.status})`);
        }

        let data = null;
        try {
            data = await response.json();
        } catch (_) { /* some DELETE endpoints return no body */ }

        return {
            success: true,
            data
        };
    } catch (error) {
        console.error('Error deleting order:', error);
        window.P2PAuth.showAuthError(error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Check if user has evotor credentials filled
 * @returns {Promise<boolean>}
 */
async function checkEvotorCredentials() {
    try {
        // Check if user is authenticated
        const isAuth = await window.P2PAuth.isAuthenticated();
        if (!isAuth) {
            console.log('P2P Analytics: User not authenticated, cannot check evotor credentials');
            return false;
        }

        // Get user data from API
        const result = await window.P2PAuth.getCurrentUserFromAPI();
        
        if (!result.success || !result.data) {
            console.error('P2P Analytics: Failed to get user data:', result.error);
            return false;
        }

        const userData = result.data;
        console.log('P2P Analytics: Checking evotor credentials for user:', userData.login);

        // Check if evotorLogin and evotorPassword are filled
        const hasEvotorLogin = userData.evotorLogin && userData.evotorLogin.trim() !== '';
        const hasEvotorPassword = userData.evotorPassword && userData.evotorPassword.trim() !== '';
        
        console.log('P2P Analytics: Evotor credentials status:', {
            hasEvotorLogin,
            hasEvotorPassword
        });

        return hasEvotorLogin && hasEvotorPassword;
    } catch (error) {
        console.error('P2P Analytics: Error checking evotor credentials:', error);
        return false;
    }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Helper: parse numeric input or return null when empty/invalid
 * @param {*} value - Value to parse
 * @returns {number|null}
 */
function parseNumberOrNull(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim().replace(',', '.');
    if (raw === '') return null;
    const num = parseFloat(raw);
    return Number.isFinite(num) ? num : null;
}

/**
 * Helper function to generate random Gmail address
 * @returns {string}
 */
function generateRandomGmail() {
    const randomString = Math.random().toString(36).substring(2, 10);
    return `${randomString}@gmail.com`;
}

/**
 * Helper function to truncate number to specified decimal places (not round)
 * @param {number} num - Number to truncate
 * @param {number} decimals - Number of decimal places
 * @returns {number}
 */
function truncateToDecimals(num, decimals) {
    const multiplier = Math.pow(10, decimals);
    return Math.floor(num * multiplier) / multiplier;
}

/**
 * Helper function to extract number from text, handling various formats
 * Supports both European (15 000,00) and American (15,000.00) decimal formats
 * @param {string} text - Text containing number
 * @returns {number|null}
 */
function extractNumber(text) {
    if (!text) return null;
    
    // Remove all spaces (including non-breaking spaces)
    const cleaned = text.replace(/\s+/g, '').replace(/\u00A0/g, '');
    
    // Match number with possible separators
    const match = cleaned.match(/[\d.,]+/);
    if (!match) return null;
    
    let numberStr = match[0];
    
    // Count occurrences of each separator
    const commaCount = (numberStr.match(/,/g) || []).length;
    const periodCount = (numberStr.match(/\./g) || []).length;
    
    // Determine decimal separator by checking the pattern
    const hasComma = commaCount > 0;
    const hasPeriod = periodCount > 0;
    
    if (hasComma && hasPeriod) {
        // Both separators present - the last one is the decimal separator
        const lastComma = numberStr.lastIndexOf(',');
        const lastPeriod = numberStr.lastIndexOf('.');
        
        if (lastComma > lastPeriod) {
            // Comma is decimal separator (European: 1.234,56 or 15.000,00)
            numberStr = numberStr.replace(/\./g, '').replace(',', '.');
        } else {
            // Period is decimal separator (American: 1,234.56 or 15,000.00)
            numberStr = numberStr.replace(/,/g, '');
        }
    } else if (hasComma) {
        // Only comma present - check context to determine if decimal or thousands
        const parts = numberStr.split(',');
        const lastPart = parts[parts.length - 1];
        
        // If there are multiple commas, they are thousands separators
        if (commaCount > 1) {
            // Multiple commas (e.g., 1,234,567)
            numberStr = numberStr.replace(/,/g, '');
        } else {
            // Single comma - check if it's thousands or decimal separator
            // Thousands separator is used ONLY with exactly 3 digits after it
            // Any other count (1, 2, 4, 5, 6+) means decimal separator
            if (lastPart.length === 3 && parts.length === 2 && parts[0].length >= 2) {
                // Could be thousands (e.g., 15,000) - check first part length
                // If first part is less than 2 digits, it's likely decimal (e.g., 1,234)
                // But for safety, only treat as thousands if >= 4 total digits before comma
                if (parts[0].length >= 2) {
                    // Likely thousands separator (e.g., 15,000 or 1,234)
                    numberStr = numberStr.replace(/,/g, '');
                } else {
                    // Edge case: treat as decimal
                    numberStr = numberStr.replace(/,/g, '.');
                }
            } else {
                // Any other digit count after comma = decimal separator
                // Examples: 83,32 (2 digits), 169,87555 (5 digits), 15000,0 (1 digit)
                numberStr = numberStr.replace(/,/g, '.');
            }
        }
    } else if (hasPeriod) {
        // Only period present - check context
        const parts = numberStr.split('.');
        const lastPart = parts[parts.length - 1];
        
        // If there are multiple periods, they are thousands separators (European style)
        if (periodCount > 1) {
            // Multiple periods (e.g., 1.234.567)
            numberStr = numberStr.replace(/\./g, '');
        } else {
            // Single period - same logic as comma
            if (lastPart.length === 3 && parts.length === 2 && parts[0].length >= 2) {
                // Likely thousands separator (e.g., 15.000 or 1.234)
                numberStr = numberStr.replace(/\./g, '');
            }
            // Otherwise assume period is decimal separator (already correct format)
        }
    }
    
    const num = parseFloat(numberStr);
    return isFinite(num) ? num : null;
}

// Export functions for use in content scripts
if (typeof window !== 'undefined') {
    window.P2POrderAPI = {
        // Constants
        COMMISSION_TYPE_PERCENT,
        COMMISSION_TYPE_MONEY,
        
        // API Functions
        fetchBankDetails,
        checkOrderExists,
        saveOrder,
        deleteOrder,
        checkEvotorCredentials,
        
        // Utility Functions
        parseNumberOrNull,
        generateRandomGmail,
        truncateToDecimals,
        extractNumber
    };
}

