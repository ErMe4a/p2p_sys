// Service Worker for P2P Analytics Extension

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'openPopup') {
        // Open popup programmatically
        chrome.action.openPopup().catch((error) => {
            console.error('Failed to open popup:', error);
        });
        return true;
    }
    
    if (request.action === 'captureScreenshot') {
        // Capture screenshot of the active tab
        console.log('P2P Analytics: Capturing screenshot request received');
        
        // Get the current tab first
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                console.error('P2P Analytics Background: Error getting current tab:', chrome.runtime.lastError);
                sendResponse({ success: false, error: `Tab query error: ${chrome.runtime.lastError.message}` });
                return;
            }
            
            if (!tabs || tabs.length === 0) {
                console.error('P2P Analytics Background: No active tab found');
                sendResponse({ success: false, error: 'No active tab found' });
                return;
            }
            
            const activeTab = tabs[0];
            console.log('P2P Analytics Background: Active tab URL:', activeTab.url);
            console.log('P2P Analytics Background: Tab permissions check...');
            
            // Check if the tab URL is allowed
            if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('moz-extension://')) {
                console.error('P2P Analytics Background: Cannot capture screenshot of system page');
                sendResponse({ success: false, error: 'Cannot capture screenshot of system pages' });
                return;
            }
            
            // Capture screenshot of the active tab
            console.log('P2P Analytics Background: Attempting to capture screenshot...');
            
            // Try the new Chrome API first, then fallback to legacy
            if (chrome.tabs.captureVisibleTab) {
                chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png', quality: 90 }, (dataUrl) => {
                    if (chrome.runtime.lastError) {
                        console.error('P2P Analytics Background: Error capturing screenshot:', chrome.runtime.lastError);
                        const errorMessage = chrome.runtime.lastError.message;
                        sendResponse({ success: false, error: errorMessage });
                    } else if (!dataUrl) {
                        console.error('P2P Analytics Background: Screenshot captured but no data received');
                        sendResponse({ success: false, error: 'Screenshot captured but no data received' });
                    } else {
                        console.log('P2P Analytics Background: Screenshot captured successfully, size:', dataUrl.length);
                        sendResponse({ success: true, dataUrl: dataUrl });
                    }
                });
            } else {
                console.error('P2P Analytics Background: captureVisibleTab API not available');
                sendResponse({ success: false, error: 'Screenshot API not available in this browser' });
            }
        });
        
        return true; // Indicates we will send response asynchronously
    }
    
    if (request.action === 'downloadScreenshot') {
        // Download screenshot
        chrome.downloads.download({
            url: request.dataUrl,
            filename: request.filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('Error downloading screenshot:', chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId: downloadId });
            }
        });
        return true; // Indicates we will send response asynchronously
    }
});

// Handle extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('P2P Analytics extension installed');
});

// Handle startup
chrome.runtime.onStartup.addListener(() => {
    console.log('P2P Analytics extension started');
}); 