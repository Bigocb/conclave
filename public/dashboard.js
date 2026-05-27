const STATE = {
    token: localStorage.getItem('clv_token'),
    orgId: localStorage.getItem('clv_orgId'),
    principals: [],
    apiBase: window.location.origin,
    defaultPrincipalId: null,
};

async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (STATE.token) headers['Authorization'] = `Bearer ${STATE.token}`;

    const config = { method, headers, body: body ? JSON.stringify(body) : null };
    const url = `${STATE.apiBase}${endpoint}`;
    const res = await fetch(url, config);
    if (res.status === 401) { showAuth(); throw new Error('Unauthorized'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    return data;
}


// ─── Real-time Pulse Infrastructure ────────────────────────────

function initPulse() {
    console.log('📡 Initializing Pulse SSE (Render Daemon)...');
    
    if (!STATE.token || !STATE.orgId) {
        console.warn('⚠️ Missing token or orgId, skipping Pulse initialization');
        return;
    }

    const daemonUrl = 'https://conclave-bp4o.onrender.com';
    const eventSource = new EventSource(`${daemonUrl}/pulse?token=${STATE.token}&orgId=${STATE.orgId}`);

    eventSource.onopen = () => {
        console.log('✅ Connected to Conclave Pulse');
        showToast('Connected to real-time pulse', 'info');
    };

    eventSource.onerror = (err) => {
        console.error('❌ Pulse SSE connection error:', err);
    };

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('🚀 Pulse Event Received:', data);
            handlePulseEvent(data);
        } catch (e) {
            console.error('Failed to parse Pulse event:', e);
        }
    };
}

function handlePulseEvent(event) {
    const { type, payload, orgId } = event;
    if (orgId && STATE.orgId !== orgId) return;

    console.log(`[Pulse Event] ${type}:`, payload);

    switch (type) {
        case 'TASK_CREATED':
            showToast(`New task submitted to ${payload.channel}`, 'info');
            if (document.getElementById('view-tasks')?.classList.contains('hidden') === false) {
                refreshTasks(); 
            }
            if (document.getElementById('view-active')?.classList.contains('hidden') === false) {
                refreshActiveView();
            }
            break;
        case 'REVIEW_SUBMITTED':
            showToast(`New review submitted for task ${payload.taskId.slice(0,8)}`, 'success');
            if (document.getElementById('view-tasks')?.classList.contains('hidden') === false) {
                refreshTasks();
            }
            handleActiveViewPulse(event);
            break;
    }
}

// ─── NOC Active View ──────────────────────────────────────────

async function refreshActiveView() {
    if (!STATE.token || !STATE.orgId) return;
    
    try {
        const data = await apiRequest('/v1/active-view');
        const tasks = data.activeTasks || [];
        
        // Update Global Tickers
        document.getElementById('noc-active-tasks').innerText = tasks.length;
        const totalReviews = tasks.reduce((sum, t) => sum + t.currentReviews, 0);
        document.getElementById('noc-reviews-count').innerText = totalReviews;

        const grid = document.getElementById('active-grid');
        if (!grid) return;

        // Surgical Update: Only create elements if they don't exist
        tasks.forEach(task => {
            let card = document.getElementById(`noc-card-${task.id}`);
            const progress = (task.currentReviews / task.requestedReviews) * 100;
            
            if (!card) {
                card = document.createElement('div');
                card.id = `noc-card-${task.id}`;
                card.className = 'noc-card group';
                card.onclick = () => {
                    document.getElementById('td-task-id').innerText = task.id;
                    toggleTaskDetailModal(true);
                    refreshTaskDetails(task.id);
                };
                grid.appendChild(card);
            }

            card.innerHTML = `
                <div class="flex justify-between items-start mb-3">
                    <span class="text-[10px] font-mono text-gray-500">${task.id}</span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-400 font-bold uppercase">${task.status}</span>
                </div>
                <p class="text-sm font-medium text-gray-200 mb-4 line-clamp-2 h-10">${escapeHtml(task.description)}</p>
                <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] font-bold text-gray-500 uppercase">Verify Consensus</span>
                    <span class="text-[10px] font-mono text-green-400">${task.currentReviews}/${task.requestedReviews}</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${progress}%"></div>
                </div>
            `;
        });

        // Remove cards for tasks that are no longer active
        const activeIds = new Set(tasks.map(t => `noc-card-${t.id}`));
        Array.from(grid.children).forEach(child => {
            if (!activeIds.has(child.id)) child.remove();
        });

    } catch (e) {
        console.error('Active View Refresh Failed:', e);
    }
}

function handleActiveViewPulse(event) {
    const { type, payload } = event;
    if (type === 'REVIEW_SUBMITTED') {
        const card = document.getElementById(`noc-card-${payload.taskId}`);
        if (card) {
            card.classList.add('pulse-flash');
            setTimeout(() => card.classList.remove('pulse-flash'), 1000);
            refreshActiveView(); // Surgical refresh of data
        }
    }
}

// ─── NOC Active View ──────────────────────────────────────────

async function refreshActiveView() {
    if (!STATE.token || !STATE.orgId) return;
    
    try {
        const data = await apiRequest('/v1/active-view');
        const tasks = data.activeTasks || [];
        
        // Update Global Tickers
        document.getElementById('noc-active-tasks').innerText = tasks.length;
        const totalReviews = tasks.reduce((sum, t) => sum + (t.currentReviews || 0), 0);
        document.getElementById('noc-reviews-count').innerText = totalReviews;

        const grid = document.getElementById('active-grid');
        if (!grid) return;

        // Surgical Update: Only create or update elements
        tasks.forEach(task => {
            let card = document.getElementById(`noc-card-${task.id}`);
            const progress = ((task.currentReviews || 0) / (task.requestedReviews || 1)) * 100;
            
            if (!card) {
                card = document.createElement('div');
                card.id = `noc-card-${task.id}`;
                card.className = 'noc-card group';
                card.onclick = () => {
                    document.getElementById('td-task-id').innerText = task.id;
                    toggleTaskDetailModal(true);
                    refreshTaskDetails(task.id);
                };
                grid.appendChild(card);
            }

            card.innerHTML = `
                <div class="flex justify-between items-start mb-3">
                    <span class="text-[10px] font-mono text-gray-500">${task.id}</span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-400 font-bold uppercase">${task.status}</span>
                </div>
                <p class="text-sm font-medium text-gray-200 mb-4 line-clamp-2 h-10">${escapeHtml(task.description)}</p>
                <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] font-bold text-gray-500 uppercase">Verify Consensus</span>
                    <span class="text-[10px] font-mono text-green-400">${task.currentReviews}/${task.requestedReviews}</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${progress}%"></div>
                </div>
            `;
        });

        // Remove cards for tasks that are no longer active
        const activeIds = new Set(tasks.map(t => `noc-card-${t.id}`));
        Array.from(grid.children).forEach(child => {
            if (!activeIds.has(child.id)) child.remove();
        });

    } catch (e) {
        console.error('Active View Refresh Failed:', e);
    }
}

function handleActiveViewPulse(event) {
    const { type, payload } = event;
    if (type === 'REVIEW_SUBMITTED') {
        const card = document.getElementById(`noc-card-${payload.taskId}`);
        if (card) {
            card.classList.add('pulse-flash');
            setTimeout(() => card.classList.remove('pulse-flash'), 1000);
            refreshActiveView(); 
        }
    }
}
// ─── Toast Notifications ─────────────────────────────────────

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) { alert(message); return; }

    const icons = { success: 'check-circle', error: 'alert-circle', info: 'info', warning: 'alert-triangle' };
    const icon = icons[type] || 'info';

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 flex-shrink-0"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    lucide.createIcons({ attrs: { root: toast } });

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 250);
    }, duration);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Mobile Sidebar ──────────────────────────────────────────

function openMobileSidebar() {
    document.getElementById('mobile-sidebar-overlay').classList.add('open');
    document.getElementById('mobile-sidebar-panel').classList.add('open');
    document.body.style.overflow = 'hidden';
    // Focus the close button
    setTimeout(() => {
        const closeBtn = document.querySelector('.mobile-sidebar-panel [aria-label="Close navigation menu"]');
        if (closeBtn) closeBtn.focus();
    }, 100);
}

function closeMobileSidebar() {
    document.getElementById('mobile-sidebar-overlay').classList.remove('open');
    document.getElementById('mobile-sidebar-panel').classList.remove('open');
    document.body.style.overflow = '';
}

// ─── Focus Trap for Modals ───────────────────────────────────

const MODAL_SELECTORS = [
    'auth-overlay', 'deploy-modal', 'factory-modal', 'edit-agent-modal',
    'submit-task-modal', 'task-detail-modal', 'principal-modal',
    'org-modal', 'grant-budget-modal'
];

function getModalElement(id) {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden') ? el : null;
}

function getOpenModal() {
    for (const id of MODAL_SELECTORS) {
        const el = getModalElement(id);
        if (el) return el;
    }
    return null;
}

document.addEventListener('keydown', function(e) {
    // Escape closes modals
    if (e.key === 'Escape') {
        const modal = getOpenModal();
        if (modal) {
            const id = modal.id;
            if (id === 'auth-overlay') hideAuth();
            else if (id === 'deploy-modal') toggleDeployModal();
            else if (id === 'factory-modal') toggleFactoryModal(false);
            else if (id === 'edit-agent-modal') toggleEditAgentModal(false);
            else if (id === 'submit-task-modal') toggleSubmitTaskModal(false);
            else if (id === 'task-detail-modal') toggleTaskDetailModal(false);
            else if (id === 'principal-modal') hideCreatePrincipalModal();
            else if (id === 'org-modal') hideCreateOrgModal();
            else if (id === 'grant-budget-modal') hideGrantBudgetModal();
        }
        // Escape closes mobile sidebar
        if (document.getElementById('mobile-sidebar-overlay')?.classList.contains('open')) {
            closeMobileSidebar();
        }
    }

    // Focus trap: Tab inside open modal
    if (e.key === 'Tab') {
        const modal = getOpenModal();
        if (modal) {
            const focusable = modal.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }
});

// Backdrop click to close modals
document.addEventListener('click', function(e) {
    for (const id of MODAL_SELECTORS) {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('hidden')) continue;
        // Check if click is on the overlay itself (not on the modal content)
        if (e.target === el || (el.id === 'task-detail-modal' && e.target === el)) {
            if (id === 'auth-overlay') { /* don't close auth on backdrop */ }
            else if (id === 'deploy-modal') toggleDeployModal();
            else if (id === 'factory-modal') toggleFactoryModal(false);
            else if (id === 'edit-agent-modal') toggleEditAgentModal(false);
            else if (id === 'submit-task-modal') toggleSubmitTaskModal(false);
            else if (id === 'task-detail-modal') toggleTaskDetailModal(false);
            else if (id === 'principal-modal') hideCreatePrincipalModal();
            else if (id === 'org-modal') hideCreateOrgModal();
            else if (id === 'grant-budget-modal') hideGrantBudgetModal();
        }
    }
});

// ─── Debounced Auto-Refresh ─────────────────────────────────

let AUTO_REFRESH_TIMERS = {};
let IS_MOBILE = window.innerWidth < 768;

window.addEventListener('resize', () => {
    IS_MOBILE = window.innerWidth < 768;
});

function scheduleRefresh(fn, key = 'default') {
    if (AUTO_REFRESH_TIMERS[key]) clearTimeout(AUTO_REFRESH_TIMERS[key]);
    const delay = IS_MOBILE ? 2000 : 500;
    AUTO_REFRESH_TIMERS[key] = setTimeout(fn, delay);
}

// ─── Pull-to-Refresh (touch gesture) ──────────────────────────

let PULL_START_Y = 0;
let PULL_THRESHOLD = 80;
let PULL_ACTIVE = false;
let PULL_OVERSCROLL = false;
let PULL_REFRESH_FN = null;

function setupPullToRefresh(refreshFn) {
    PULL_REFRESH_FN = refreshFn;
    const main = document.getElementById('main-content');
    if (!main) return;

    main.addEventListener('touchstart', function(e) {
        if (IS_MOBILE && main.scrollTop <= 0) {
            PULL_START_Y = e.touches[0].clientY;
            PULL_OVERSCROLL = true;
        } else {
            PULL_OVERSCROLL = false;
        }
    }, { passive: true });

    main.addEventListener('touchmove', function(e) {
        if (!PULL_OVERSCROLL || PULL_ACTIVE) return;
        const delta = e.touches[0].clientY - PULL_START_Y;
        if (delta > PULL_THRESHOLD) {
            PULL_ACTIVE = true;
            startPullRefresh();
        }
    }, { passive: true });

    main.addEventListener('touchend', function() {
        PULL_OVERSCROLL = false;
    }, { passive: true });
}

function startPullRefresh() {
    const indicator = document.getElementById('pull-to-refresh-indicator');
    if (!indicator) return;
    indicator.classList.add('active');
    PULL_ACTIVE = true;

    if (PULL_REFRESH_FN) {
        Promise.resolve(PULL_REFRESH_FN()).finally(() => {
            setTimeout(() => {
                indicator.classList.remove('active');
                PULL_ACTIVE = false;
            }, 500);
        });
    } else {
        setTimeout(() => {
            indicator.classList.remove('active');
            PULL_ACTIVE = false;
        }, 1000);
    }
}

// ─── Summary Mode Toggle ──────────────────────────────────────

let SUMMARY_MODE = localStorage.getItem('clv_summary_mode') === 'true';

function toggleSummaryMode() {
    SUMMARY_MODE = !SUMMARY_MODE;
    localStorage.setItem('clv_summary_mode', SUMMARY_MODE);
    applySummaryMode();
}

function applySummaryMode() {
    const toggles = document.querySelectorAll('.summary-toggle');
    toggles.forEach(t => t.classList.toggle('active', SUMMARY_MODE));
    document.body.classList.toggle('summary-mode', SUMMARY_MODE);
    const label = SUMMARY_MODE ? 'Detailed' : 'Compact';
    toggles.forEach(t => {
        t.innerHTML = `<i data-lucide="${SUMMARY_MODE ? 'list' : 'grid'}" class="w-3.5 h-3.5"></i> ${label}`;
    });
    if (SUMMARY_MODE) lucide.createIcons();
}

// ─── Swipe-to-Close Modals (touch gesture) ───────────────────

let SWIPE_MODAL_START_Y = 0;
let SWIPE_MODAL_ACTIVE = false;

document.addEventListener('touchstart', function(e) {
    const modal = getOpenModal();
    if (!modal) return;
    const content = modal.querySelector('[class*="rounded-2xl"], [class*="bg-\\[#0c111b\\]"]');
    if (!content || !content.contains(e.target)) return;
    if (content.scrollTop > 0) return; // Only swipe if scrolled to top
    SWIPE_MODAL_START_Y = e.touches[0].clientY;
    SWIPE_MODAL_ACTIVE = true;
}, { passive: true });

document.addEventListener('touchmove', function(e) {
    if (!SWIPE_MODAL_ACTIVE) return;
    const modal = getOpenModal();
    if (!modal) return;
    const delta = e.touches[0].clientY - SWIPE_MODAL_START_Y;
    if (delta > 100) {
        SWIPE_MODAL_ACTIVE = false;
        const id = modal.id;
        if (id === 'deploy-modal') toggleDeployModal();
        else if (id === 'factory-modal') toggleFactoryModal(false);
        else if (id === 'edit-agent-modal') toggleEditAgentModal(false);
        else if (id === 'submit-task-modal') toggleSubmitTaskModal(false);
        else if (id === 'task-detail-modal') toggleTaskDetailModal(false);
        else if (id === 'principal-modal') hideCreatePrincipalModal();
        else if (id === 'org-modal') hideCreateOrgModal();
        else if (id === 'grant-budget-modal') hideGrantBudgetModal();
    }
}, { passive: true });

document.addEventListener('touchend', function() {
    SWIPE_MODAL_ACTIVE = false;
}, { passive: true });

// ─── PWA: Service Worker + Push Notifications + Install Prompt ──

const VAPID_PUBLIC_KEY = 'BJRbzU74Mave_sfRvjBcQ_xfoalte0tm08DKMeRfK_YxLGU60t66Fi9MtDt-YiD6oy-3kSQoUUZU4dPp_CA5p_w';
let INSTALL_PROMPT = null;

// Capture the install prompt event
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    INSTALL_PROMPT = e;
    showInstallPrompt();
});

// Show install button when PWA is installable
function showInstallPrompt() {
    // Add install button to the sidebar footer
    const sidebarFooter = document.querySelector('.sidebar-footer');
    if (!sidebarFooter || document.getElementById('pwa-install-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pwa-install-btn';
    btn.className = 'w-full flex items-center gap-3 px-4 py-2 text-xs text-green-400 hover:text-green-300 transition-all text-left';
    btn.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i> Install App';
    btn.onclick = triggerInstallPrompt;
    sidebarFooter.appendChild(btn);

    // Also add to bottom nav "More" section if on mobile
    const moreSection = document.querySelector('#mobile-sidebar-panel .sidebar-footer');
    if (moreSection && !moreSection.querySelector('#pwa-install-mobile')) {
        const mbtn = document.createElement('button');
        mbtn.id = 'pwa-install-mobile';
        mbtn.className = 'w-full flex items-center gap-3 px-4 py-2 text-xs text-green-400 hover:text-green-300 transition-all text-left';
        mbtn.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i> Install App';
        mbtn.onclick = triggerInstallPrompt;
        moreSection.insertBefore(mbtn, moreSection.querySelector('button'));
    }

    lucide.createIcons();
}

// Trigger the install prompt
async function triggerInstallPrompt() {
    if (!INSTALL_PROMPT) {
        showToast('App is already installed or not yet available.', 'info');
        return;
    }
    const result = await INSTALL_PROMPT.prompt();
    INSTALL_PROMPT = null;
    // Hide install buttons after result
    document.querySelectorAll('[id^="pwa-install"]').forEach(el => el.style.display = 'none');
    if (result.outcome === 'accepted') {
        showToast('Conclave installed! 🎉', 'success');
    } else {
        showToast('Install cancelled.', 'info');
    }
}

// Detect successful install
window.addEventListener('appinstalled', () => {
    showToast('Conclave installed! 🎉', 'success');
    document.querySelectorAll('[id^="pwa-install"]').forEach(el => el.style.display = 'none');
});

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        console.log('SW registered:', reg.scope);

        // Check if push is supported
        if (!('PushManager' in window)) return reg;

        // Check permission
        const result = await Notification.requestPermission();
        if (result !== 'granted') return reg;

        // Subscribe to push
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });

        // Send subscription to server
        await sendPushSubscription(sub);
        return reg;
    } catch (e) {
        console.warn('SW registration failed:', e);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function sendPushSubscription(subscription) {
    try {
        await apiRequest('/v1/push/subscribe', 'POST', {
            subscription: JSON.stringify(subscription),
        });
        console.log('Push subscription saved');
    } catch (e) {
        console.warn('Failed to save push subscription:', e.message);
    }
}

// ─── Auth ──────────────────────────────────────────────────────

let AUTH_MODE = 'login';
function toggleAuthMode(mode) {
    AUTH_MODE = mode;
    const isReg = mode === 'register';
    document.getElementById('auth-title').innerText = isReg ? 'Join Conclave' : 'Conclave Identity';
    document.getElementById('auth-subtitle').innerText = isReg ? 'Establish your identity and organization.' : 'Enter credentials to access your fleet control plane.';
    document.getElementById('reg-fields').classList.toggle('hidden', !isReg);
    document.getElementById('btn-login').innerText = isReg ? 'Create Account' : 'Access Dashboard';
}

function showAuth() { document.getElementById('auth-overlay').classList.remove('hidden'); }
function hideAuth() { document.getElementById('auth-overlay').classList.add('hidden'); }

async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-pass').value;

    if (AUTH_MODE === 'login') {
        try {
            const data = await apiRequest('/v1/auth/login', 'POST', { email, password });
            STATE.token = data.token;
            STATE.orgId = data.orgId;
            localStorage.setItem('clv_token', data.token);
            localStorage.setItem('clv_orgId', data.orgId);
            hideAuth();
            await loadPrincipals();
            switchView('fleet');
        } catch (e) {
            showToast('Login failed. Check your credentials.', 'error');
        }
    } else {
        const fullName = document.getElementById('reg-name').value;
        const orgName = document.getElementById('reg-org').value;
        if (!fullName || !orgName) { showToast('Name and Organization are required.', 'warning'); return; }
        try {
            const data = await apiRequest('/v1/auth/register', 'POST', { email, password, fullName, orgName, displayName: fullName });
            STATE.token = data.token;
            STATE.orgId = data.orgId;
            localStorage.setItem('clv_token', data.token);
            localStorage.setItem('clv_orgId', data.orgId);
            hideAuth();
            await loadPrincipals();
            switchView('fleet');
        } catch (e) {
            showToast('Registration failed: ' + (e.message || 'Email might be taken.'), 'error');
        }
    }
}

async function loadPrincipals() {
    try {
        const data = await apiRequest('/v1/principals');
        const principals = data.data || [];
        STATE.principals = principals;
        if (principals.length > 0) STATE.defaultPrincipalId = principals[0].id;
    } catch (e) { console.warn('Could not load principals', e); }
}

// ─── View Switching ────────────────────────────────────────────

function switchView(viewId) {
    const views = ['fleet', 'vault', 'tasks', 'channels', 'workers', 'org', 'factory'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.classList.toggle('hidden', v !== viewId);
    });

    // Sync desktop sidebar
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active', 'text-white');
        item.classList.add('text-gray-400');
        const txt = item.textContent.toLowerCase();
        const map = { fleet: 'fleet', vault: 'vault', tasks: 'task', channels: 'channel', workers: 'worker', org: 'organization', factory: 'factory' };
        for (const [key, val] of Object.entries(map)) {
            if (viewId === key && txt.includes(val)) {
                item.classList.add('active');
                item.classList.remove('text-gray-400');
            }
        }
    });

    // Sync bottom nav (phone)
    document.querySelectorAll('#mobile-bottom-nav a').forEach(a => {
        a.classList.toggle('active', a.dataset.view === viewId);
        if (a.dataset.view === viewId) {
            a.classList.remove('text-gray-400');
        }
    });

    // Sync mobile sidebar
    document.querySelectorAll('.mobile-sidebar-panel nav a').forEach(a => {
        const txt = a.textContent.toLowerCase();
        const map = { fleet: 'fleet', vault: 'vault', tasks: 'task', channels: 'channel', workers: 'worker', org: 'organization', factory: 'factory' };
        a.classList.remove('active');
        for (const [key, val] of Object.entries(map)) {
            if (viewId === key && txt.includes(val)) {
                a.classList.add('active');
            }
        }
    });
    if (viewId === 'fleet') refreshFleet();
    if (viewId === 'channels') refreshChannels();
    if (viewId === 'workers') refreshWorker();
    if (viewId === 'org') refreshOrg();
    if (viewId === 'vault') refreshVault();
    if (viewId === 'tasks') refreshTasks();
    if (viewId === 'factory') refreshFactory();
}

// ─── Fleet (Principals View) ───────────────────────────────────

async function refreshFleet() {
    const grid = document.getElementById('agent-grid');
    const orgText = STATE.orgId || 'No Org Linked';
    document.getElementById('display-org').innerText = orgText;
    const mobileOrg = document.getElementById('mobile-display-org');
    if (mobileOrg) mobileOrg.innerText = orgText;
    await loadPrincipals();
    const principals = STATE.principals;

    if (!principals || principals.length === 0) {
        grid.innerHTML = '<p class="col-span-full text-center py-12 text-gray-500">No principals. Create one in the Organization view.</p>';
        return;
    }

    let html = '';
    for (const p of principals) {
        // Fetch agents for this principal
        let agents = [];
        try {
            const aData = await apiRequest(`/v1/principals/${p.id}/agents`);
            agents = aData.data || [];
        } catch (e) { /* no agents yet */ }

        // Fetch channel subscriptions
        let channels = [];
        try {
            const sData = await apiRequest(`/v1/principals/${p.id}/reviewers`);
            // reviewers is the old endpoint name, channels is more useful
        } catch (e) {}

        const agentCount = agents.length;
        const models = [...new Set(agents.map(a => a.model || a.provider || 'unknown').filter(Boolean))].join(', ') || 'none assigned';

        html += `
        <div class="bg-[#0c111b] border border-[#1e2d4a] p-6 rounded-2xl hover:border-green-500/50 transition-all">
            <div class="flex justify-between items-start mb-4">
                <div class="w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center text-green-400">
                    <i data-lucide="user-check" class="w-5 h-5"></i>
                </div>
                <span class="text-[10px] font-mono px-2 py-1 bg-white/5 rounded border border-white/10 text-gray-500">${p.id}</span>
            </div>
            <h3 class="font-bold text-lg mb-1">${p.name}</h3>
            <p class="text-xs text-gray-400 mb-4">${agentCount} agent${agentCount !== 1 ? 's' : ''} · Models: <span class="text-green-400">${models}</span></p>
            <div class="pt-4 border-t border-[#1e2d4a] space-y-2">
                <div class="flex justify-between text-xs text-gray-500">
                    <span>Agents deployed</span>
                    <span class="text-white font-bold">${agentCount}</span>
                </div>
                <div class="flex gap-2">
                    <button onclick="managePrincipalSubs('${p.id}','${p.name}')" class="flex-1 text-xs bg-white/10 hover:bg-white/20 text-gray-300 font-bold px-3 py-1.5 rounded-lg transition-all">Manage Channels</button>
                </div>
            </div>
        </div>`;
    }
    grid.innerHTML = html;
    lucide.createIcons();
}

function managePrincipalSubs(principalId, name) {
    switchView('channels');
}

// ─── Channels ──────────────────────────────────────────────────

async function refreshChannels() {
    const grid = document.getElementById('channels-grid');
    await loadPrincipals();

    let channels;
    try {
        const cData = await apiRequest('/v1/channels');
        channels = cData.data?.channels || cData.data?.data || cData.data || [];
    } catch (e) {
        grid.innerHTML = '<p class="text-gray-500 col-span-full text-center py-12">Failed to load channels.</p>';
        return;
    }

    let html = '';
    for (const ch of channels) {
        const name = ch.name || ch;
        let subs = [];
        try {
            const sData = await apiRequest(`/v1/channels/${encodeURIComponent(name)}/subscribers`);
            subs = sData.data?.subscribers || [];
        } catch (e) { /* no subs */ }

        const subIds = subs.map(s => s.principalId || s.principal_id || s);
        const dimensions = ch.default_dimensions || [];

        html += `
        <div class="bg-[#0c111b] border border-[#1e2d4a] rounded-2xl p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-8 h-8 bg-green-500/10 rounded-lg flex items-center justify-center text-green-400">
                    <i data-lucide="radio" class="w-4 h-4"></i>
                </div>
                <div>
                    <h3 class="font-bold text-lg">${name}</h3>
                    <p class="text-xs text-gray-500">${ch.description || ''}</p>
                </div>
            </div>
            ${dimensions.length > 0 ? `<div class="flex flex-wrap gap-1 mb-4">${dimensions.map(d => `<span class="text-[10px] px-2 py-0.5 bg-white/5 rounded border border-white/10 text-gray-400">${d}</span>`).join('')}</div>` : ''}
            <div class="border-t border-[#1e2d4a] pt-4">
                <p class="text-xs font-bold text-gray-500 uppercase mb-2">Subscribed Principals</p>
                ${subs.length === 0 ? '<p class="text-xs text-gray-500">No principals subscribed yet.</p>' :
                subs.map(s => {
                    const pid = s.principalId || s.principal_id || s;
                    const pName = STATE.principals.find(p => p.id === pid)?.name || pid.slice(0, 16)+'...';
                    return `
                    <div class="flex justify-between items-center py-1.5 border-b border-[#1e2d4a]/50 last:border-0">
                        <div>
                            <span class="text-xs font-mono text-green-400">${pName}</span>
                            <span class="text-[10px] text-gray-500 ml-2">${pid.slice(0, 12)}...</span>
                        </div>
                        <button onclick="unsubPrincipal('${pid}','${name}')" class="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">Unsub</button>
                    </div>`;
                }).join('')}
                ${STATE.principals.length > 0 ? `
                <div class="mt-3 pt-3 border-t border-[#1e2d4a]">
                    <div class="flex gap-2">
                        <select id="sub-sel-${name.replace(/[^a-z0-9]/gi,'_')}" class="flex-1 text-xs bg-[#131a2b] border border-[#1e2d4a] p-2 rounded text-white outline-none">
                            <option value="">Select principal...</option>
                            ${STATE.principals.map(p => {
                                const already = subIds.includes(p.id);
                                const disabled = already ? 'disabled' : '';
                                return `<option value="${p.id}" ${disabled}>${p.name}${already ? ' (subscribed)' : ''}</option>`;
                            }).join('')}
                        </select>
                        <button onclick="subPrincipal('${name}')" class="bg-green-500 hover:bg-cyan-400 text-black font-bold px-3 py-1 rounded-lg text-xs transition-all">+ Sub</button>
                    </div>
                </div>` : ''}
            </div>
        </div>`;
    }
    grid.innerHTML = html;
    lucide.createIcons();
}

function getChannelName(btn) {
    // Find the channel name from the card's h3
    const card = btn.closest('[class*="bg-\\[\\#0c111b\\]"]') || btn.parentElement;
    const h3 = card?.querySelector('h3');
    return h3?.innerText || '';
}

async function subPrincipal(channelName) {
    const selectId = `sub-sel-${channelName.replace(/[^a-z0-9]/gi,'_')}`;
    const sel = document.getElementById(selectId);
    const principalId = sel?.value;
    if (!principalId) { showToast('Select a principal first.', 'warning'); return; }
    try {
        await apiRequest(`/v1/channels/${encodeURIComponent(channelName)}/subscribe`, 'POST', { principal_id: principalId });
        await refreshChannels();
    } catch (e) { showToast('Subscribe failed: ' + e.message, 'error'); }
}

async function unsubPrincipal(principalId, channelName) {
    try {
        await apiRequest(`/v1/channels/${encodeURIComponent(channelName)}/subscribe`, 'DELETE', { principal_id: principalId });
        await refreshChannels();
    } catch (e) { showToast('Unsubscribe failed: ' + e.message, 'error'); }
}

// ─── Worker Status ─────────────────────────────────────────────

async function refreshWorker() {
    const badge = document.getElementById('worker-status-badge');
    const activeEl = document.getElementById('worker-active');
    const totalEl = document.getElementById('worker-total');
    const uptimeEl = document.getElementById('worker-uptime');

    // Try to get worker status
    try {
        const data = await apiRequest('/v1/health');
        badge.innerText = 'API Online';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-green-500/20 text-green-400';
        activeEl.innerText = data?.data?.workers || '-';
        totalEl.innerText = data?.data?.version || 'conclave';
        uptimeEl.innerText = data?.data?.mode || 'cloud';
    } catch (e) {
        badge.innerText = 'API: Check';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-yellow-500/20 text-yellow-400';
    }

    // Try fleet status for worker-specific info
    try {
        const fData = await apiRequest('/v1/fleet/status');
        const f = fData.data || {};
        if (f.active) activeEl.innerText = f.active;
        if (f.total) totalEl.innerText = f.total;
        if (f.uptime) uptimeEl.innerText = f.uptime;
    } catch (e) { /* fleet endpoint may not exist */ }

    document.getElementById('worker-log').innerText =
        'The reviewer worker is a persistent process (tsx src/workers/reviewer.ts) that connects via PG LISTEN/NOTIFY.\n' +
        'It watches for new tasks, finds subscribed principals, and dispatches reviews using each principal\'s agents.\n' +
        'Status shown here is from the API health endpoint — worker-specific telemetry requires the fleet endpoint.';
}

// ─── Vault ─────────────────────────────────────────────────────

async function saveVaultKey() {
    const provider = document.getElementById('vault-provider').value;
    const key = document.getElementById('vault-key').value;
    if (!provider || !key) { showToast('Both provider and key are required.', 'warning'); return; }
    try {
        await apiRequest('/v1/vault/key', 'POST', { provider, key });
        document.getElementById('vault-provider').value = '';
        document.getElementById('vault-key').value = '';
        await refreshVault();
        showToast('Key saved to vault.', 'success');
    } catch (e) { showToast('Failed to save key to vault.', 'error'); }
}

async function refreshVault() {
    const list = document.getElementById('vault-list');
    try {
        const data = await apiRequest('/v1/vault/keys');
        const keys = data.data || [];
        list.innerHTML = keys.length ? '' : '<p class="text-gray-500 text-center py-8">No keys stored in vault.</p>';
        keys.forEach(k => {
            list.innerHTML += `
                <div class="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-lg">
                    <div class="flex items-center gap-3">
                        <i data-lucide="key" class="w-4 h-4 text-green-400"></i>
                        <span class="font-mono text-sm">${k.provider}</span>
                    </div>
                    <span class="text-[10px] text-gray-500 uppercase">Encrypted</span>
                </div>`;
        });
        lucide.createIcons();
    } catch (e) { console.error('Vault refresh failed', e); }
}

// ─── Tasks ────────────────────────────────────────────────────

function toggleSubmitTaskModal(show) {
    document.getElementById('submit-task-modal').classList.toggle('hidden', !show);
}
function toggleTaskDetailModal(show) {
    document.getElementById('task-detail-modal').classList.toggle('hidden', !show);
}

async function submitTask() {
    const channel = document.getElementById('task-channel').value;
    const description = document.getElementById('task-description').value;
    const output = document.getElementById('task-output').value;
    const requestedReviews = parseInt(document.getElementById('task-requested').value) || 2;
    const dimsRaw = document.getElementById('task-dimensions').value;
    const dimensions = dimsRaw ? dimsRaw.split(',').map(d => d.trim()).filter(Boolean) : null;

    if (!channel || !description || !output) { showToast('Channel, description, and output are required.', 'warning'); return; }

    try {
        const payload = {
            channel,
            task_description: description,
            output,
            requested_reviews: requestedReviews,
        };
        if (dimensions && dimensions.length > 0) payload.dimensions = dimensions;

        await apiRequest('/v1/tasks', 'POST', payload);
        toggleSubmitTaskModal(false);
        document.getElementById('submit-task-form').reset();
        await refreshTasks();
    } catch (e) {
        showToast('Task submission failed: ' + e.message, 'error');
    }
}

async function viewTaskDetail(taskId) {
    toggleTaskDetailModal(true);
    document.getElementById('td-task-id').innerText = taskId;
    const content = document.getElementById('td-content');
    content.innerHTML = '<p class="text-gray-500 text-center py-8">Loading...</p>';
    try {
        const data = await apiRequest(`/v1/tasks/${taskId}`);
        const task = data.data;
        if (!task) { content.innerHTML = '<p class="text-red-500">Task not found</p>'; return; }

        const reviews = task.reviews || task.review_summary || [];
        const summary = task.review_summary;

        // Show/hide Dismiss / Restore buttons
        document.getElementById('td-dismiss-btn').classList.toggle('hidden', task.status !== 'open' && task.status !== 'in_review');
        document.getElementById('td-restore-btn').classList.toggle('hidden', task.status !== 'dismissed');

        let html = `
        <div class="mb-6">
            <div class="flex items-center gap-2 mb-2">
                <span class="text-xs font-bold px-2 py-1 rounded ${task.status === 'completed' ? 'bg-green-500/20 text-green-400' : task.status === 'in_review' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-500/20 text-gray-400'} uppercase">${task.status}</span>
                <span class="text-xs text-gray-500">Channel: ${task.channel}</span>
                <span class="text-xs text-gray-500">· ${task.requested_reviews || 0} requested</span>
                ${task.priority && task.priority !== 'normal' ? `<span class="text-xs text-yellow-400">· ${task.priority}</span>` : ''}
            </div>
            ${task.dimensions && task.dimensions.length > 0 ? `
            <div class="flex flex-wrap gap-1 mb-3">
                ${task.dimensions.map(d => `<span class="text-[10px] px-2 py-0.5 bg-green-500/10 text-green-400 rounded border border-green-500/30">${d}</span>`).join('')}
            </div>` : ''}
            <p class="text-sm text-gray-300 mb-2">${task.description || task.input || task.task_description || ''}</p>
            ${task.metadata?.concern ? `<div class="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <p class="text-[10px] font-bold text-yellow-400 uppercase mb-1">Area of Concern</p>
                <p class="text-xs text-yellow-300">${task.metadata.concern}</p>
            </div>` : ''}
            ${task.output ? `<pre class="text-xs bg-[#131a2b] rounded-lg p-4 overflow-x-auto text-gray-400 font-mono whitespace-pre-wrap">${task.output.slice(0, 5000)}${task.output.length > 5000 ? '\n... (truncated)' : ''}</pre>` : ''}
            ${task.deadline ? `<p class="text-xs text-gray-500 mt-2">⏰ Deadline: ${new Date(task.deadline).toLocaleString()}</p>` : ''}
            ${task.budget_spent ? `<p class="text-xs text-gray-500 mt-1">Budget spent: ${task.budget_spent}</p>` : ''}
        </div>`;

        if (summary) {
            html += `
            <div class="border-t border-[#1e2d4a] pt-4 mb-4">
                <h4 class="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Review Summary (${summary.review_count || 0})</h4>
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div class="bg-[#131a2b] rounded-lg p-3 text-center">
                        <p class="text-2xl font-bold ${summary.approved ? 'text-green-400' : 'text-red-400'}">${summary.avg_overall || '-'}</p>
                        <p class="text-[10px] text-gray-500">Avg Score</p>
                    </div>
                    <div class="bg-[#131a2b] rounded-lg p-3 text-center">
                        <p class="text-2xl font-bold ${summary.approval_rate >= 50 ? 'text-green-400' : 'text-yellow-400'}">${summary.approval_rate || '-'}%</p>
                        <p class="text-[10px] text-gray-500">Approval Rate</p>
                    </div>
                </div>`;

            if (summary.avg_scores && Object.keys(summary.avg_scores).length > 0) {
                html += '<div class="space-y-1 mb-4">';
                for (const [dim, score] of Object.entries(summary.avg_scores)) {
                    html += `<div class="flex justify-between items-center text-xs"><span class="text-gray-500">${dim}</span><span class="font-bold">${score}/10</span></div>`;
                }
                html += '</div>';
            }

            if (summary.top_suggestions && summary.top_suggestions.length > 0) {
                html += `
                <div class="border-t border-[#1e2d4a] pt-3">
                    <p class="text-xs font-bold text-gray-500 uppercase mb-2">Top Suggestions</p>
                    <ul class="space-y-1">${summary.top_suggestions.map(s => `<li class="text-xs text-gray-400">• ${s}</li>`).join('')}</ul>
                </div>`;
            }
            html += '</div>';
        }

        // Individual reviews
        if (task.reviews && task.reviews.length > 0) {
            html += '<div class="border-t border-[#1e2d4a] pt-4"><h4 class="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Individual Reviews</h4>';
            task.reviews.forEach(r => {
                html += `
                <div class="bg-[#131a2b] border border-[#1e2d4a] rounded-lg p-4 mb-3">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[10px] font-mono text-gray-500">${r.reviewer_id || r.id}</span>
                        <span class="text-xs font-bold ${r.approved ? 'text-green-400' : 'text-red-400'}">${r.approved ? 'APPROVED' : 'DENIED'}</span>
                    </div>
                    <p class="text-xs text-gray-300 mb-2">${r.comment || ''}</p>
                    ${r.scores ? `<div class="flex flex-wrap gap-1">${Object.entries(r.scores).map(([d, s]) => `<span class="text-[10px] px-2 py-0.5 bg-white/5 rounded">${d}: ${s}</span>`).join('')}</div>` : ''}
                </div>`;
            });
            html += '</div>';
        }

        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = `<p class="text-red-500">Failed to load task: ${e.message}</p>`;
    }
}

async function dismissTask(taskId) {
    if (!confirm('Dismiss this task? It will be hidden from agents and the list by default. Can be restored later.')) return;
    try {
        await apiRequest(`/v1/tasks/${taskId}/dismiss`, { method: 'POST' });
        toggleTaskDetailModal(false);
        refreshTasks();
    } catch (e) {
        showToast('Failed to dismiss task: ' + e.message, 'error');
    }
}

async function restoreTask(taskId) {
    try {
        await apiRequest(`/v1/tasks/${taskId}/restore`, { method: 'POST' });
        toggleTaskDetailModal(false);
        refreshTasks();
    } catch (e) {
        showToast('Failed to restore task: ' + e.message, 'error');
    }
}

async function refreshTasks() {
    const list = document.getElementById('task-list');
    const showDismissed = document.getElementById('show-dismissed-toggle')?.checked || false;
    try {
        const url = showDismissed ? '/v1/tasks?include_dismissed=true' : '/v1/tasks';
        const data = await apiRequest(url);
        const tasks = data.data?.tasks || data.data || [];
        list.innerHTML = tasks.length ? '' : '<p class="text-gray-500 text-center py-8">No tasks yet. Submit one to get started.</p>';
        tasks.forEach(t => {
            const isDismissed = t.status === 'dismissed';
            const statusColor = isDismissed ? 'text-gray-600' :
                t.status === 'completed' ? 'text-green-400' :
                t.status === 'in_review' ? 'text-yellow-400' : 'text-gray-400';
            list.innerHTML += `
                <div onclick="viewTaskDetail('${t.id}')" class="cursor-pointer p-4 bg-[#0c111b] border border-[#1e2d4a] rounded-xl hover:border-green-500/50 transition-all ${isDismissed ? 'opacity-50' : ''}">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-xs font-mono text-gray-500">${t.id}</span>
                        <span class="text-xs font-bold ${statusColor} uppercase">${t.status}${isDismissed ? ' <span class="text-gray-600">(hidden)</span>' : ''}</span>
                    </div>
                    <div class="text-sm mb-2 text-gray-300">${(t.description || t.input || t.task_description || '').slice(0, 120)}${(t.description || '').length > 120 ? '...' : ''}</div>
                    <div class="flex justify-between items-center text-[10px] text-gray-500">
                        <span>Channel: ${t.channel || '-'}</span>
                        <span>Reviews: ${t.reviews_received || 0}/${t.requested_reviews || '-'}</span>
                    </div>
                    ${t.dimensions && t.dimensions.length > 0 ? `<div class="flex flex-wrap gap-1 mt-2">${t.dimensions.map(d => `<span class="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">${d}</span>`).join('')}</div>` : ''}
                </div>`;
        });
    } catch (e) {
        console.error('Task feed refresh failed', e);
        list.innerHTML = '<p class="text-gray-500 text-center py-8">Failed to load tasks.</p>';
    }
}

// ─── Org / Principal Management ────────────────────────────────

async function refreshOrg() {
    const details = document.getElementById('org-details');
    const orgId = STATE.orgId;
    if (!orgId) {
        details.innerHTML = '<p class="text-gray-500">No organization linked.</p>';
        return;
    }

    await loadPrincipals();
    let orgName = 'Your Organization';
    try {
        const orgData = await apiRequest(`/v1/orgs/${orgId}`);
        if (orgData.data) orgName = orgData.data.name || orgName;
    } catch (e) { /* use default */ }

    const principals = STATE.principals;
    let principalsHtml = '';
    for (const p of STATE.principals) {
        // Fetch budget for each principal
        let budgetStr = '—';
        try {
            const bData = await apiRequest(`/v1/principals/${p.id}/budget`);
            const b = bData.data;
            if (b) budgetStr = `${b.available || 0} (${b.earned || 0}e/${b.spent || 0}s)`;
        } catch (e) { /* no budget yet */ }

        principalsHtml += `
            <div class="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-lg">
                <div class="flex-1">
                    <span class="font-mono text-sm text-green-400">${p.name}</span>
                    <span class="text-xs text-gray-500 ml-2">${p.id}</span>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-[10px] text-gray-500 uppercase">${p.roles ? (Array.isArray(p.roles) ? p.roles.join(', ') : typeof p.roles === 'string' ? JSON.parse(p.roles).join(', ') : 'general-reviewer') : 'general-reviewer'}</span>
                    <span class="text-xs font-mono text-yellow-400" title="Budget: available (earned/spent)">${budgetStr}</span>
                    <button onclick="showGrantBudgetModal('${p.id}','${p.name}')" class="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-all">+Budget</button>
                </div>
            </div>`;
    }

    details.innerHTML = `
        <div class="flex items-center justify-between mb-6">
            <div>
                <h3 class="text-lg font-bold">${orgName}</h3>
                <p class="text-xs text-gray-500 font-mono">${orgId}</p>
            </div>
        </div>
        <div class="border-t border-[#1e2d4a] pt-4 mb-4">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-sm font-bold text-gray-400 uppercase tracking-wider">Principals (${principals.length})</h4>
                <button onclick="showCreatePrincipalModal()" class="text-xs bg-green-500 hover:bg-cyan-400 text-black font-bold px-3 py-1.5 rounded-lg transition-all">+ New Principal</button>
            </div>
            <div class="space-y-2">
                ${principalsHtml || '<p class="text-gray-500 text-sm">No principals. Create one to register agents.</p>'}
            </div>
        </div>
        <div class="border-t border-[#1e2d4a] pt-4 flex gap-2">
            <button onclick="showCreateOrgModal()" class="text-xs bg-white/10 hover:bg-white/20 text-gray-300 font-bold px-3 py-1.5 rounded-lg transition-all">+ New Org</button>
        </div>`;
}

// ─── Principal/Org Modals ──────────────────────────────────────

function showCreatePrincipalModal() { document.getElementById('principal-modal').classList.remove('hidden'); }
function hideCreatePrincipalModal() { document.getElementById('principal-modal').classList.add('hidden'); }

async function createPrincipal() {
    const name = document.getElementById('principal-name').value;
    if (!name) { showToast('Principal name is required.', 'warning'); return; }
    try {
        await apiRequest('/v1/principals', 'POST', { org_id: STATE.orgId, name });
        document.getElementById('principal-name').value = '';
        hideCreatePrincipalModal();
        await loadPrincipals();
        refreshOrg();
    } catch (e) { showToast('Failed to create principal: ' + (e.message || 'Unknown error'), 'error'); }
}

function showCreateOrgModal() { document.getElementById('org-modal').classList.remove('hidden'); }
function hideCreateOrgModal() { document.getElementById('org-modal').classList.add('hidden'); }

async function createOrg() {
    const name = document.getElementById('new-org-name').value;
    if (!name) { showToast('Organization name is required.', 'warning'); return; }
    try {
        const data = await apiRequest('/v1/orgs', 'POST', { name });
        if (data.data) {
            STATE.orgId = data.data.id;
            localStorage.setItem('clv_orgId', data.data.id);
            document.getElementById('new-org-name').value = '';
            hideCreateOrgModal();
            await loadPrincipals();
            refreshOrg();
            refreshFleet();
        }
    } catch (e) { showToast('Failed to create org: ' + (e.message || 'Unknown error'), 'error'); }
}

// ─── Agent Factory (unchanged from original) ───────────────────

function toggleFactoryModal(show) {
    document.getElementById('factory-modal').classList.toggle('hidden', !show);
    if (show && STATE.defaultPrincipalId) {
        document.getElementById('factory-principal-id').value = STATE.defaultPrincipalId;
    }
}

async function refreshFactory() {
    const list = document.getElementById('factory-agent-list');
    try {
        const data = await apiRequest('/v1/agents');
        const agents = data.data || [];
        list.innerHTML = agents.length ? '' : '<tr><td colspan="6" class="p-8 text-center text-gray-500">No agents registered.</td></tr>';
        agents.forEach(agent => {
            const owner = STATE.principals.find(p => p.id === agent.principal_id);
            const ownerName = owner ? owner.name : (agent.principal_id ? agent.principal_id.slice(0,16)+'...' : '-');
            list.innerHTML += `
                <tr class="border-b border-[#1e2d4a] hover:bg-white/5 transition-all">
                    <td data-label="Agent Name" class="p-4 font-medium">${agent.name}</td>
                    <td data-label="Provider/Model" class="p-4 text-sm text-gray-400">${agent.provider || 'custom'}/${agent.model || 'unknown'}</td>
                    <td data-label="Principal" class="p-4 text-xs text-gray-500 font-mono">${ownerName}</td>
                    <td data-label="Status" class="p-4 text-xs ${agent.status === 'active' ? 'text-green-400' : 'text-red-400'}">${agent.status}</td>
                    <td data-label="ID" class="p-4 font-mono text-xs text-gray-500">${agent.id}</td>
                    <td data-label="Actions" class="p-4 text-right space-x-2">
                        <button onclick="editAgent('${agent.id}')" class="text-xs text-cyan-400 hover:text-cyan-300">Edit</button>
                        <button onclick="decommissionAgent('${agent.id}')" class="text-xs text-red-500 hover:text-red-400">Decommission</button>
                    </td>
                </tr>`;
        });
    } catch (e) { console.error('Factory refresh failed', e); }
}

async function decommissionAgent(id) {
    if (!confirm('Decommission this agent?')) return;
    try {
        await apiRequest(`/v1/agents/${id}`, 'DELETE');
        refreshFactory();
    } catch (e) { showToast('Failed to decommission', 'error'); }
}

// ─── Agent Edit / Token Management ─────────────────────────────

function toggleEditAgentModal(show) {
    document.getElementById('edit-agent-modal').classList.toggle('hidden', !show);
}

async function editAgent(agentId) {
    try {
        const data = await apiRequest(`/v1/agents/${agentId}`);
        const agent = data.data;
        document.getElementById('edit-agent-id').value = agent.id;
        document.getElementById('edit-agent-name').value = agent.name || '';
        populateProviderSelect('edit-agent-provider', agent.provider || '');
        document.getElementById('edit-agent-instructions').value = agent.instructions || '';
        document.getElementById('edit-agent-token').value = '••••••••••••••••';

        // Preload model list if the agent has a provider
        const modelSel = document.getElementById('edit-agent-model');
        if (agent.provider) {
            await loadProviderModels(agent.provider, 'edit-agent-model');
            // Select the agent's current model in the dropdown
            const opt = modelSel.querySelector(`option[value="${agent.model}"]`);
            if (opt) {
                opt.selected = true;
            } else if (agent.model) {
                // If the model isn't in the list (e.g., custom), add it
                modelSel.innerHTML += `<option value="${agent.model}" selected>${agent.model}</option>`;
            }
        } else {
            modelSel.innerHTML = '<option value="">Custom</option>';
        }

        // Load vault keys for the vault-key selector
        const vaultData = await apiRequest('/v1/vault/keys');
        const keys = vaultData.data || [];
        const vaultSelect = document.getElementById('edit-agent-vault-key');
        vaultSelect.innerHTML = '<option value="">Use agent-specific key (enter below)</option>';
        keys.forEach(k => {
            vaultSelect.innerHTML += `<option value="${k.provider}">${k.provider} (stored in vault)</option>`;
        });

        // Pre-select if the agent's provider matches a vault key
        if (agent.provider && keys.some(k => k.provider === agent.provider)) {
            vaultSelect.value = agent.provider;
        }

        toggleEditAgentModal(true);
    } catch (e) {
        showToast('Failed to load agent: ' + e.message, 'error');
    }
}

async function saveEditAgent() {
    const agentId = document.getElementById('edit-agent-id').value;
    const vaultKey = document.getElementById('edit-agent-vault-key').value;
    const payload = {
        name: document.getElementById('edit-agent-name').value,
        provider: document.getElementById('edit-agent-provider').value,
        model: document.getElementById('edit-agent-model').value,
        instructions: document.getElementById('edit-agent-instructions').value,
        use_vault_key: vaultKey || undefined,
    };
    try {
        await apiRequest(`/v1/agents/${agentId}`, 'PATCH', payload);
        toggleEditAgentModal(false);
        refreshFactory();
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

async function regenerateAgentToken() {
    const agentId = document.getElementById('edit-agent-id').value;
    if (!confirm('Regenerate token? The old token will stop working immediately.')) return;
    try {
        const data = await apiRequest(`/v1/agents/${agentId}/regenerate-token`, 'POST');
        const newToken = data.data?.token;
        if (newToken) {
            document.getElementById('edit-agent-token').value = newToken;
            document.getElementById('edit-agent-token').type = 'text';
            alert(`New token: ${newToken}\n\nCopy this now — it won't be shown again after closing.`);
        }
    } catch (e) {
        showToast('Failed to regenerate token: ' + e.message, 'error');
    }
}

// ─── Budget Management ─────────────────────────────────────────

function showGrantBudgetModal(principalId, principalName) {
    document.getElementById('grant-principal-id').value = principalId;
    document.getElementById('grant-principal-name').innerText = principalName;
    document.getElementById('grant-amount').value = '';
    document.getElementById('grant-reason').value = '';
    document.getElementById('grant-budget-modal').classList.remove('hidden');
}

function hideGrantBudgetModal() {
    document.getElementById('grant-budget-modal').classList.add('hidden');
}

async function grantBudget() {
    const principalId = document.getElementById('grant-principal-id').value;
    const amount = parseInt(document.getElementById('grant-amount').value);
    const reason = document.getElementById('grant-reason').value || 'manual_grant';
    if (!amount || amount <= 0) { showToast('Enter a positive amount.', 'warning'); return; }
    try {
        await apiRequest(`/v1/principals/${principalId}/budget/grant`, 'POST', { amount, reason });
        hideGrantBudgetModal();
        refreshOrg();
    } catch (e) { showToast('Grant failed: ' + e.message, 'error'); }
}

// ─── Provider / Model Helpers ──────────────────────────────────

let STATE_PROVIDERS = [];

async function loadProviders() {
    try {
        const data = await apiRequest('/v1/providers');
        STATE_PROVIDERS = data.data?.providers || [];
    } catch (e) { console.warn('Failed to load providers', e); }
}

async function loadProviderModels(provider, selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading models...</option>';
    sel.disabled = true;
    try {
        const data = await apiRequest(`/v1/providers/${provider}/models`);
        const models = data.data || [];
        sel.innerHTML = '<option value="">Select model...</option>';
        models.forEach(m => {
            sel.innerHTML += `<option value="${m.id}">${m.id}</option>`;
        });
    } catch (e) {
        sel.innerHTML = '<option value="">No models available</option>';
    }
    sel.disabled = false;
}

async function onProviderChange(providerSelectId, modelSelectId) {
    const provider = document.getElementById(providerSelectId)?.value;
    const modelSel = document.getElementById(modelSelectId);
    if (!modelSel) return;
    if (provider) {
        await loadProviderModels(provider, modelSelectId);
    } else {
        modelSel.innerHTML = '<option value="">Custom</option>';
        modelSel.disabled = false;
    }
}

function populateProviderSelect(selectId, defaultVal) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Custom URL</option>';
    STATE_PROVIDERS.forEach(p => {
        sel.innerHTML += `<option value="${p.name}" ${p.name === defaultVal ? 'selected' : ''}>${p.name}</option>`;
    });
    // Default to ollama
    if (!defaultVal) {
        const opt = sel.querySelector('option[value="ollama"]');
        if (opt) opt.selected = true;
    }
}

document.getElementById('principal-form').onsubmit = async (e) => {
    e.preventDefault();
    await createPrincipal();
};
document.getElementById('org-form').onsubmit = async (e) => {
    e.preventDefault();
    await createOrg();
};
document.getElementById('submit-task-form').onsubmit = async (e) => {
    e.preventDefault();
    await submitTask();
};
document.getElementById('factory-reg-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const payload = Object.fromEntries(formData.entries());
    try {
        const res = await apiRequest('/v1/agents/register', 'POST', payload);
        if (res.success === undefined || res.success === true) {
            toggleFactoryModal(false);
            e.target.reset();
            refreshFactory();
            showToast('Agent created successfully.', 'success');
        } else { showToast('Error: ' + (res.error || 'Unknown'), 'error'); }
    } catch (e) { showToast('Network Error: ' + e.message, 'error'); }
};

document.getElementById('btn-login').onclick = handleLogin;
document.getElementById('btn-logout').onclick = () => { localStorage.clear(); window.location.reload(); };
document.getElementById('btn-save-key').onclick = saveVaultKey;

window.onload = async () => {    initPulse();
    
    lucide.createIcons();
    applySummaryMode();
    registerServiceWorker();
    setupPullToRefresh(() => {
        // Refresh the current view
        const currentView = document.querySelector('[id^="view-"]:not(.hidden)');
        if (currentView) {
            const id = currentView.id.replace('view-', '');
            const fns = { fleet: refreshFleet, vault: refreshVault, tasks: refreshTasks, channels: refreshChannels, workers: refreshWorker, org: refreshOrg, factory: refreshFactory };
            return fns[id] ? fns[id]() : Promise.resolve();
        }
    });
    if (!STATE.token) showAuth();
    else {
        await loadPrincipals();
        await loadProviders();
        populateProviderSelect('fact-provider', 'ollama');
        // Load models for default ollama selection
        await loadProviderModels('ollama', 'fact-model');
        switchView('fleet');
    }
};
