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

function showAuth() {
    document.getElementById('auth-overlay')?.classList.remove('hidden');
}

async function handleLogin() {
    const token = document.getElementById('auth-token')?.value;
    const orgId = document.getElementById('auth-orgid')?.value;

    if (!token || !orgId) {
        showToast('Both token and Org ID are required', 'warning');
        return;
    }

    try {
        // Verify token with a simple API call
        await apiRequest('/v1/org');
        
        // Save to local storage
        localStorage.setItem('clv_token', token);
        localStorage.setItem('clv_orgId', orgId);
        
        // Update state
        STATE.token = token;
        STATE.orgId = orgId;
        
        document.getElementById('auth-overlay')?.classList.add('hidden');
        showToast('Authenticated successfully', 'success');
        switchView('fleet');
    } catch (e) {
        showToast('Login failed: ' + e.message, 'error');
    }
}

function handleLogout() {
    localStorage.removeItem('clv_token');
    localStorage.removeItem('clv_orgId');
    window.location.reload();
}

// ─── Real-time Pulse Infrastructure ────────────────────────────

function initPulse() {
    if (!STATE.token || !STATE.orgId) return;
    const daemonUrl = 'https://conclave-bp4o.onrender.com';
    const eventSource = new EventSource(`${daemonUrl}/pulse?token=${STATE.token}&orgId=${STATE.orgId}`);
    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handlePulseEvent(data);
        } catch (e) { console.error('Pulse parse error:', e); }
    };
}

function handlePulseEvent(event) {
    const { type, payload } = event;
    switch (type) {
        case 'TASK_CREATED':
            showToast(`New task in ${payload.channel}`, 'info');
            if (document.getElementById('view-tasks')?.classList.contains('hidden') === false) refreshTasks();
            break;
        case 'REVIEW_SUBMITTED':
            showToast(`New review for ${payload.taskId.slice(0,8)}`, 'success');
            if (document.getElementById('view-tasks')?.classList.contains('hidden') === false) refreshTasks();
            break;
    }
}

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) { alert(message); return; }
    const icons = { success: 'check-circle', error: 'alert-circle', info: 'info', warning: 'alert-triangle' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i data-lucide="${icons[type] || 'info'}" class="w-4 h-4 flex-shrink-0"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    lucide.createIcons({ attrs: { root: toast } });
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 250);
    }, duration);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Navigation & View Controller ──────────────────────────────────────

function switchView(viewId) {
    const views = ['fleet', 'vault', 'tasks', 'channels', 'workers', 'org', 'factory', 'profiles', 'noc', 'fleet-manager'];
    if (!views.includes(viewId)) return;

    const target = document.getElementById(`view-${viewId}`);
    if (!target) return;

    document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
    target.classList.remove('hidden');
    
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('onclick')?.includes(`switchView('${viewId}')`)) item.classList.add('active');
    });
    
    if (viewId === 'fleet') refreshFleet();
    if (viewId === 'vault') refreshVault();
    if (viewId === 'tasks') refreshTasks();
    if (viewId === 'channels') refreshChannels();
    if (viewId === 'workers') refreshWorker();
    if (viewId === 'org') refreshOrg();
    if (viewId === 'factory') refreshFactory();
    if (viewId === 'profiles') profileController.loadProfiles();
    if (viewId === 'fleet-manager') fleetController.reload();
    if (viewId === 'noc') initPulse();
}

function openMobileSidebar() {
    document.getElementById('mobile-sidebar-overlay').classList.add('open');
    document.getElementById('mobile-sidebar-panel').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeMobileSidebar() {
    document.getElementById('mobile-sidebar-overlay').classList.remove('open');
    document.getElementById('mobile-sidebar-panel').classList.remove('open');
    document.body.style.overflow = '';
}

// ─── Data Fetchers (The "Engine") ─────────────────────────────────────

async function refreshFleet() {
    const grid = document.getElementById('agent-grid');
    if (!grid) return;
    try {
        const data = await apiRequest('/v1/principals');
        const principals = data.data || data;
        grid.innerHTML = principals.length ? '' : '<p class=\"col-span-full text-center py-12 text-gray-500\">No principals found.</p>';
        principals.forEach(p => {
            grid.innerHTML += `
                <div class=\"bg-[#0c111b] border border-[#1e2d4a] p-6 rounded-2xl hover:border-green-500/50 transition-all\">
                    <div class=\"flex justify-between items-start mb-4\">
                        <div class=\"w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center text-green-400\">
                            <i data-lucide=\"user-check\" class=\"w-5 h-5\"></i>
                        </div>
                        <span class=\"text-[10px] font-mono px-2 py-1 bg-white/5 rounded border border-white/10 text-gray-500\">${p.id}</span
                    </div>
                    <h3 class=\"font-bold text-lg mb-1\">${p.name}</h3>
                    <p class=\"text-xs text-gray-400 mb-4\">Principal Identity</p>
                    <div class=\"pt-4 border-t border-[#1e2d4a] flex gap-2\">
                        <button onclick=\"managePrincipalSubs('${p.id}','${p.name}')\" class=\"text-xs bg-white/10 hover:bg-white/20 text-gray-300 px-3 py-1.5 rounded-lg\">Manage Channels</button>
                    </div>
                </div>`;
        });
        lucide.createIcons();
    } catch (e) {
        grid.innerHTML = `<p class=\"col-span-full text-center py-12 text-red-400\">Error: ${e.message}</p>`;
    }
}

async function refreshTasks() {
    const list = document.getElementById('task-list');
    if (!list) return;
    try {
        const data = await apiRequest('/v1/tasks');
        const tasks = data.data?.tasks || data.data || data || [];
        list.innerHTML = tasks.length ? '' : '<p class=\"text-gray-500 text-center py-8\">No tasks found.</p>';
        tasks.forEach(t => {
            list.innerHTML += `
                <div onclick=\"viewTaskDetail('${t.id}')\" class=\"cursor-pointer p-4 bg-[#0c111b] border border-[#1e2d4a] rounded-xl hover:border-green-500/50 transition-all\">
                    <div class=\"flex justify-between items-center mb-2\">
                        <span class=\"text-xs font-mono text-gray-500\">${t.id}</span>
                        <span class=\"text-xs font-bold text-gray-400 uppercase\">${t.status}</span>
                    </div>
                    <div class=\"text-sm mb-2 text-gray-300\">${(t.description || t.task_description || '').slice(0,120)}</div>
                </div>`;
        });
    } catch (e) { list.innerHTML = `<p class=\"text-red-400 text-center py-8\">Error: ${e.message}</p>`; }
}

async function refreshChannels() {
    const grid = document.getElementById('channels-grid');
    if (!grid) return;
    try {
        const data = await apiRequest('/v1/channels');
        const channels = data.data?.channels || data.data || data || [];
        grid.innerHTML = channels.length ? '' : '<p class=\"col-span-full text-center py-12 text-gray-500\">No channels found.</p>';
        channels.forEach(ch => {
            grid.innerHTML += `
                <div class=\"bg-[#0c111b] border border-[#1e2d4a] rounded-2xl p-6\">
                    <div class=\"flex items-center gap-3 mb-4\">
                        <div class=\"w-8 h-8 bg-green-500/10 rounded-lg flex items-center justify-center text-green-400\">
                            <i data-lucide=\"radio\" class=\"w-4 h-4\"></i>
                        </div>
                        <h3 class=\"font-bold text-lg\">${ch.name || ch}</h3>
                    </div>
                    <p class=\"text-xs text-gray-500 mb-4\">${ch.description || 'No description'}</p>
                </div>`;
        });
        lucide.createIcons();
    } catch (e) { grid.innerHTML = `<p class=\"col-span-full text-center py-12 text-red-400\">Error: ${e.message}</p>`; }
}

async function refreshVault() {
    const list = document.getElementById('vault-list');
    if (!list) return;
    try {
        const data = await apiRequest('/v1/vault/keys');
        const keys = data.data || data || [];
        list.innerHTML = keys.length ? '' : '<p class=\"text-gray-500 text-center py-8\">No keys stored.</p>';
        keys.forEach(k => {
            list.innerHTML += `
                <div class=\"flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-lg\">
                    <div class=\"flex items-center gap-3\">
                        <i data-lucide=\"key\" class=\"w-4 h-4 text-green-400\"></i>
                        <span class=\"font-mono text-sm\">${k.provider}</span>
                    </div>
                    <span class=\"text-[10px] text-gray-500 uppercase\">Encrypted</span>
                </div>`;
        });
        lucide.createIcons();
    } catch (e) { list.innerHTML = `<p class=\"text-red-400 text-center py-8\">Error: ${e.message}</p>`; }
}

async function refreshWorker() {
    const badge = document.getElementById('worker-status-badge');
    if (!badge) return;
    try {
        const data = await apiRequest('/v1/health');
        badge.innerText = 'API Online';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-green-500/20 text-green-400';
    } catch (e) {
        badge.innerText = 'API Offline';
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-400';
    }
}

async function refreshOrg() {
    const el = document.getElementById('org-name');
    if (!el) return;
    try {
        const data = await apiRequest('/v1/org');
        el.innerText = data.data?.name || data.name || 'Unknown Org';
    } catch (e) { el.innerText = 'Error loading org'; }
}

function refreshFactory() {
    showToast('Agent Factory is ready', 'info');
}

// ─── Controllers for Special Views ─────────────────────────────────────

const profileController = {
    async loadProfiles() {
        const listEl = document.getElementById('profiles-list');
        if (!listEl) return;
        try {
            const profiles = await apiRequest('/v1/profiles');
            listEl.innerHTML = profiles.length ? '' : '<p class=\"text-center py-12 text-gray-500\">No profiles found.</p>';
            profiles.forEach(p => {
                listEl.innerHTML += `
                    <div class=\"bg-zinc-900 border border-white/10 p-4 rounded-xl\">
                        <h3 class=\"font-bold text-white\">${p.name}</h3>
                        <p class=\"text-xs text-gray-500 font-mono\">${p.model} / ${p.provider}</p>
                    </div>`;
            });
            lucide.createIcons();
        } catch (e) { listEl.innerHTML = `<p class=\"text-red-400 text-center py-12\">Error: ${e.message}</p>`; }
    }
};

const fleetController = {
    async reload() {
        const grid = document.getElementById('fleet-grid');
        if (!grid) return;
        try {
            const reviewers = await apiRequest('/v1/fleet/reviewers');
            grid.innerHTML = reviewers.length ? '' : '<p class=\"text-center py-12 text-gray-500\">No reviewers configured.</p>';
            review reviewers.forEach(r => {
                grid.innerHTML += `
                    <div class=\"bg-zinc-900 border border-white/10 p-6 rounded-xl\">
                        <h3 class=\"font-bold text-white\">${r.channel}</h3>
                        <p class=\"text-xs text-green-400\">Active</p>
                    </div>`;
            });
        } catch (e) { grid.innerHTML = `<p class=\"text-red-400 text-center py-12\">Error: ${e.message}</p>`; }
    }
};

window.onload = async () => {
    initPulse();
    lucide.createIcons();
    
    // Bind login/logout buttons
    document.getElementById('btn-access-dashboard')?.addEventListener('click', handleLogin);
    document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

    if (!STATE.token) showAuth();
    else switchView('fleet');
};
