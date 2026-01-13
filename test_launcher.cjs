const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        show: false // Keep it hidden for now
    });

    win.loadFile('test_gpu_solver.html');

    win.webContents.on('console-message', (event, level, message) => {
        // Filter out security warnings if possible, or just print clearly
        if (!message.includes('Electron Security Warning')) {
            console.log(`[BROWSER] ${message}`);
        }
        if (message.includes('SUCCESS') || message.includes('FAILURE') || message.includes('Conclusion:')) {
            setTimeout(() => app.quit(), 500); // Small delay to ensure all logs are out
        }
    });

    // Timeout if it takes too long
    setTimeout(() => {
        console.log("Test timed out.");
        app.quit();
    }, 30000); // 30 seconds
});
