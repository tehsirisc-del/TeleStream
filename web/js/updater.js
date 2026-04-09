const UpdateCheckerPlugin = Capacitor.Plugins.UpdateChecker;

class Updater {
    constructor() {
        this.snoozeDurationMs = 24 * 60 * 60 * 1000; // 24 hours
        this.overlay = null;
        this.isUpdating = false;
        
        // Listen for progress events
        if (UpdateCheckerPlugin) {
            UpdateCheckerPlugin.addListener('download_progress', (info) => {
                this.updateProgress(info.progress);
            });
        }
    }

    async checkOnLaunch() {
        if (!UpdateCheckerPlugin) return;
        
        // If app is already ready, trigger check
        if (window.AppIsReady) {
            this.triggerDelayedCheck();
        }
    }

    async triggerDelayedCheck() {
        if (this.hasScheduledCheck) return;
        this.hasScheduledCheck = true;
        // Wait a small bit after app is visible
        setTimeout(() => this.performCheck(), 2500);
    }

    async performCheck() {
        try {
            const result = await UpdateCheckerPlugin.checkForUpdate();
            console.log('Update check result: ', result);
            
            const vDisp = document.getElementById('app-version-display');
            if (vDisp) vDisp.innerText = `v${result.currentVersion || '1.0.0'}`;

            if (result.updateAvailable) {
                this.latestUpdateInfo = result;
                
                const banner = document.getElementById('global-update-banner');
                if (banner) {
                    banner.style.display = 'flex';
                    void banner.offsetWidth; // Force layout
                    banner.style.opacity = '1';
                    banner.style.transform = 'translateX(-50%) translateY(0)';
                }
                
                const badge = document.getElementById('update-badge');
                if (badge) badge.style.display = 'block';
                
                const row = document.getElementById('update-row');
                if (row) row.style.borderLeft = '4px solid #38bdf8';
            }
        } catch (e) {
            console.error('Failed to check for updates', e);
        }
    }

    async checkForUpdatesManual() {
        if (this.latestUpdateInfo && this.latestUpdateInfo.updateAvailable) {
            this.showUpdateDialog(this.latestUpdateInfo);
            return;
        }
        
        if (typeof showToast === 'function') showToast('Checking for updates...', 'info');
        try {
            const result = await UpdateCheckerPlugin.checkForUpdate();
            if (result.updateAvailable) {
                this.latestUpdateInfo = result;
                this.showUpdateDialog(result);
            } else {
                if (typeof showToast === 'function') showToast(`You are on the latest version (${result.currentVersion})`, 'success');
            }
        } catch (e) {
            if (typeof showToast === 'function') showToast('Failed to check for updates', 'error');
        }
    }

    showUpdateDialog(info) {
        if (this.overlay) return; // Already showing

        const overlay = document.createElement('div');
        overlay.id = 'update-overlay';
        overlay.style.position = 'fixed';
        overlay.style.bottom = '-300px'; // Start off-screen
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.backgroundColor = 'rgba(15, 23, 42, 0.95)';
        overlay.style.color = '#fff';
        overlay.style.padding = '30px';
        overlay.style.borderTop = '2px solid #3b82f6';
        overlay.style.boxShadow = '0 -10px 40px rgba(0,0,0,0.5)';
        overlay.style.zIndex = '9999';
        overlay.style.fontFamily = 'sans-serif';
        overlay.style.transition = 'bottom 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const title = document.createElement('h2');
        title.innerText = 'New Update Available';
        title.style.margin = '0 0 10px 0';
        title.style.color = '#38bdf8';

        const desc = document.createElement('p');
        desc.innerText = `Version ${info.latestVersion} is out! (Current: ${info.currentVersion})`;
        desc.style.margin = '0 0 20px 0';
        desc.style.fontSize = '1.2rem';

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.gap = '20px';

        const updateBtn = document.createElement('button');
        updateBtn.innerText = 'Update Now';
        updateBtn.tabIndex = 0;
        this.styleButton(updateBtn, '#2563eb');

        const laterBtn = document.createElement('button');
        laterBtn.innerText = 'Later';
        laterBtn.tabIndex = 0;
        this.styleButton(laterBtn, '#475569');

        const progressContainer = document.createElement('div');
        progressContainer.style.width = '80%';
        progressContainer.style.height = '20px';
        progressContainer.style.backgroundColor = '#1e293b';
        progressContainer.style.borderRadius = '10px';
        progressContainer.style.marginTop = '20px';
        progressContainer.style.display = 'none';
        progressContainer.style.overflow = 'hidden';

        const progressBar = document.createElement('div');
        progressBar.id = 'update-progress-bar';
        progressBar.style.width = '0%';
        progressBar.style.height = '100%';
        progressBar.style.backgroundColor = '#10b981';
        progressBar.style.transition = 'width 0.2s';

        const progressText = document.createElement('div');
        progressText.id = 'update-progress-text';
        progressText.innerText = 'Downloading... 0%';
        progressText.style.marginTop = '10px';
        progressText.style.fontSize = '1.1rem';
        progressText.style.display = 'none';

        progressContainer.appendChild(progressBar);

        btnContainer.appendChild(laterBtn);
        btnContainer.appendChild(updateBtn);

        overlay.appendChild(title);
        overlay.appendChild(desc);
        overlay.appendChild(btnContainer);
        overlay.appendChild(progressContainer);
        overlay.appendChild(progressText);

        document.body.appendChild(overlay);
        this.overlay = overlay;

        // Slide up
        setTimeout(() => {
            overlay.style.bottom = '0';
            updateBtn.focus(); // Focus primary action for TV remote
        }, 100);

        // Actions
        laterBtn.onclick = () => {
            if (this.isUpdating) return;
            this.dismissDialog();
        };

        updateBtn.onclick = () => {
            if (this.isUpdating) return;
            this.isUpdating = true;
            btnContainer.style.display = 'none';
            progressContainer.style.display = 'block';
            progressText.style.display = 'block';
            
            UpdateCheckerPlugin.downloadAndInstall({ downloadUrl: info.downloadUrl }).catch(e => {
                console.error('Update failed', e);
                alert("Update download failed. Please try again later.");
                this.dismissDialog();
            });
        };

        // Keyboard handling (D-pad)
        [updateBtn, laterBtn].forEach(btn => {
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    btn.click();
                } else if (e.key === 'ArrowRight' && btn === laterBtn) {
                    updateBtn.focus();
                } else if (e.key === 'ArrowLeft' && btn === updateBtn) {
                    laterBtn.focus();
                }
            });
        });
    }

    styleButton(btn, bgColor) {
        btn.style.padding = '15px 30px';
        btn.style.fontSize = '1.2rem';
        btn.style.border = 'none';
        btn.style.borderRadius = '8px';
        btn.style.backgroundColor = bgColor;
        btn.style.color = '#fff';
        btn.style.cursor = 'pointer';
        btn.style.outline = 'none';
        btn.style.transition = 'transform 0.2s, background-color 0.2s';

        btn.onfocus = () => {
            btn.style.transform = 'scale(1.1)';
            btn.style.border = '2px solid white';
        };
        btn.onblur = () => {
            btn.style.transform = 'scale(1.0)';
            btn.style.border = 'none';
        };
        btn.onmouseenter = btn.onfocus;
        btn.onmouseleave = btn.onblur;
    }

    updateProgress(percent) {
        if (!this.overlay) return;
        const bar = document.getElementById('update-progress-bar');
        const text = document.getElementById('update-progress-text');
        if (bar && text) {
            bar.style.width = percent + '%';
            text.innerText = `Downloading... ${percent}%`;
        }
    }

    dismissDialog() {
        if (!this.overlay) return;
        this.overlay.style.bottom = '-300px';
        setTimeout(() => {
            if (this.overlay && this.overlay.parentNode) {
                this.overlay.parentNode.removeChild(this.overlay);
            }
            this.overlay = null;
            this.isUpdating = false;
        }, 500);
    }
}

window.AppUpdater = new Updater();
