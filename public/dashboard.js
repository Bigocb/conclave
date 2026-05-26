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
            alert('Login failed. Please check your credentials.');
        }
    } else {
        const fullName = document.getElementById('reg-name').value;
        const orgName = document.getElementById('reg-org').value;
        if (!fullName || !orgName) return alert('Name and Organization are required.');
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
            alert('Registration failed: ' + (e.message || 'Email might be taken.'));
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
    if (viewId === 'fleet') refreshFleet();
    if (viewId === 'channels') refreshChannels();
    if (viewId === 'workers') refreshWorker();
    if (viewId === 'org') refreshOrg();
    if (viewId === 'vault') refreshVault();
    if (viewId === 'tasks') refreshTasks();
}

// ─── Fleet (Principals View) ───────────────────────────────────

async function refreshFleet() {
    const grid = document.getElementById('agent-grid');
    document.getElementById('display-org').innerText = STATE.orgId || 'No Org Linked';
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
    // Switch to channels view and auto-refresh
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

    // For each channel, get subscribers
    let html = '';
    for (const ch of channels) {
        const name = ch.name || ch;
        let subs = [];
        try {
            const sData = await apiRequest(`/v1/channels/${encodeURIComponent(name)}/subscribers`);
            subs = sData.data?.subscribers || [];
        } catch (e) { /* no subs */ }

        const subPrincipalIds = subs.map((s) => s.principal_id || s);
        const dimensions = ch.default_dimensions
            ? (Array.isArray(ch.default_dimensions) ? ch.default_dimensions : JSON.parse(ch.default_dimensions || '[]'))
            : [];

        html += `
        <div class="bg-[#0c111b] border border-[#1e2d4a] rounded-2xl p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-8 h-8 bg-green-500/10 rounded-lg flex items-center justify-center text-green-400">
                    <i data-lucide="radio" class="w-4 h-4"></i>
                </div>
                <div>
                    <h3 class="font-bold text-lg">${name}</h3>
                    <p class="text-xs text-gray-500">${ch.description || 'No description'}</p>
                </div>
            </div>
            ${dimensions.length > 0 ? `<div class="flex flex-wrap gap-1 mb-4">${dimensions.map(d => `<span class="text-[10px] px-2 py-0.5 bg-white/5 rounded border border-white/10 text-gray-400">${d}</span>`).join('')}</div>` : ''}
            <div class="border-t border-[#1e2d4a] pt-4">
                <p class="text-xs font-bold text-gray-500 uppercase mb-2">Subscribed Principals</p>
                ${subs.length === 0 ? '<p class="text-xs text-gray-500">No principals subscribed yet.</p>' :
                subs.map(s => `
                    <div class="flex justify-between items-center py-1.5">
                        <span class="text-xs font-mono text-green-400">${s.principal_id || s}</span>
                        <button onclick="unsubPrincipal('${s.principal_id || s}','${name}')" class="text-[10px] text-red-500 hover:text-red-400">Unsub</button>
                    </div>
                `).join('')}
                ${STATE.principals.length > 0 ? `
                <div class="mt-3 border-t border-[#1e2d4a] pt-3">
                    <select id="sub-principal-${name.replace(/[^a-z0-9]/gi,'_')}" class="w-full text-xs bg-[#131a2b] border border-[#1e2d4a] p-2 rounded text-white outline-none mb-2">
                        <option value="">Select principal...</option>
                        ${STATE.principals.filter(p => !subPrincipalIds.includes(p.id)).map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                    </select>
                    <button onclick="subPrincipal('${name}')" class="w-full text-xs bg-green-500 hover:bg-cyan-400 text-black font-bold px-3 py-1.5 rounded-lg transition-all">Subscribe</button>
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
    const selectId = `sub-principal-${channelName.replace(/[^a-z0-9]/gi,'_')}`;
    const sel = document.getElementById(selectId);
    const principalId = sel?.value;
    if (!principalId) return alert('Select a principal first.');
    try {
        await apiRequest(`/v1/channels/${encodeURIComponent(channelName)}/subscribe`, 'POST', { principal_id: principalId });
        await refreshChannels();
    } catch (e) { alert('Subscribe failed: ' + e.message); }
}

async function unsubPrincipal(principalId, channelName) {
    try {
        await apiRequest(`/v1/channels/${encodeURIComponent(channelName)}/subscribe`, 'DELETE', { principal_id: principalId });
        await refreshChannels();
    } catch (e) { alert('Unsubscribe failed: ' + e.message); }
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
    if (!provider || !key) return alert('Both provider and key are required.');
    try {
        await apiRequest('/v1/vault/key', 'POST', { provider, key });
        document.getElementById('vault-provider').value = '';
        document.getElementById('vault-key').value = '';
        await refreshVault();
    } catch (e) { alert('Failed to save key to vault.'); }
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

    if (!channel || !description || !output) return alert('Channel, description, and output are required.');

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
        alert('Task submission failed: ' + e.message);
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

        let html = `
        <div class="mb-6">
            <div class="flex items-center gap-2 mb-2">
                <span class="text-xs font-bold px-2 py-1 rounded ${task.status === 'completed' ? 'bg-green-500/20 text-green-400' : task.status === 'in_review' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-500/20 text-gray-400'} uppercase">${task.status}</span>
                <span class="text-xs text-gray-500">Channel: ${task.channel}</span>
                <span class="text-xs text-gray-500">· ${task.requested_reviews || 0} requested</span>
            </div>
            <p class="text-sm text-gray-300 mb-2">${task.description || task.input || ''}</p>
            ${task.output ? `<pre class="text-xs bg-[#131a2b] rounded-lg p-4 overflow-x-auto text-gray-400 font-mono">${task.output.slice(0, 1000)}${task.output.length > 1000 ? '...' : ''}</pre>` : ''}
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

async function refreshTasks() {
    const list = document.getElementById('task-list');
    try {
        const data = await apiRequest('/v1/tasks');
        const tasks = data.data?.tasks || data.data || [];
        list.innerHTML = tasks.length ? '' : '<p class="text-gray-500 text-center py-8">No tasks yet. Submit one to get started.</p>';
        tasks.forEach(t => {
            const statusColor = t.status === 'completed' ? 'text-green-400' :
                t.status === 'in_review' ? 'text-yellow-400' : 'text-gray-400';
            list.innerHTML += `
                <div onclick="viewTaskDetail('${t.id}')" class="cursor-pointer p-4 bg-[#0c111b] border border-[#1e2d4a] rounded-xl hover:border-green-500/50 transition-all">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-xs font-mono text-gray-500">${t.id}</span>
                        <span class="text-xs font-bold ${statusColor} uppercase">${t.status}</span>
                    </div>
                    <div class="text-sm mb-2 text-gray-300">${(t.description || t.input || t.task_description || '').slice(0, 120)}${(t.description || '').length > 120 ? '...' : ''}</div>
                    <div class="flex justify-between items-center text-[10px] text-gray-500">
                        <span>Channel: ${t.channel || '-'}</span>
                        <span>Reviews: ${t.reviews_received || 0}/${t.requested_reviews || '-'}</span>
                    </div>
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
    STATE.principals.forEach(p => {
        principalsHtml += `
            <div class="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-lg">
                <div>
                    <span class="font-mono text-sm text-green-400">${p.name}</span>
                    <span class="text-xs text-gray-500 ml-2">${p.id}</span>
                </div>
                <span class="text-[10px] text-gray-500 uppercase">${p.roles ? (Array.isArray(p.roles) ? p.roles.join(', ') : typeof p.roles === 'string' ? JSON.parse(p.roles).join(', ') : 'general-reviewer') : 'general-reviewer'}</span>
            </div>`;
    });

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
    if (!name) return alert('Principal name is required.');
    try {
        await apiRequest('/v1/principals', 'POST', { org_id: STATE.orgId, name });
        document.getElementById('principal-name').value = '';
        hideCreatePrincipalModal();
        await loadPrincipals();
        refreshOrg();
    } catch (e) { alert('Failed to create principal: ' + (e.message || 'Unknown error')); }
}

function showCreateOrgModal() { document.getElementById('org-modal').classList.remove('hidden'); }
function hideCreateOrgModal() { document.getElementById('org-modal').classList.add('hidden'); }

async function createOrg() {
    const name = document.getElementById('new-org-name').value;
    if (!name) return alert('Organization name is required.');
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
    } catch (e) { alert('Failed to create org: ' + (e.message || 'Unknown error')); }
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
        list.innerHTML = agents.length ? '' : '<tr><td colspan="5" class="p-8 text-center text-gray-500">No agents registered.</td></tr>';
        agents.forEach(agent => {
            list.innerHTML += `
                <tr class="border-b border-[#1e2d4a] hover:bg-white/5 transition-all">
                    <td class="p-4 font-medium">${agent.name}</td>
                    <td class="p-4 text-sm text-gray-400">${agent.provider || 'custom'}/${agent.model || 'unknown'}</td>
                    <td class="p-4 text-xs ${agent.status === 'active' ? 'text-green-400' : 'text-red-400'}">${agent.status}</td>
                    <td class="p-4 font-mono text-xs text-gray-500">${agent.id}</td>
                    <td class="p-4 text-right"><button onclick="decommissionAgent('${agent.id}')" class="text-xs text-red-500 hover:text-red-400">Decommission</button></td>
                </tr>`;
        });
    } catch (e) { console.error('Factory refresh failed', e); }
}

async function decommissionAgent(id) {
    if (!confirm('Decommission this agent?')) return;
    try {
        await apiRequest(`/v1/agents/${id}`, 'DELETE');
        refreshFactory();
    } catch (e) { alert('Failed to decommission'); }
}

// ─── Event Wiring ──────────────────────────────────────────────

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
        } else { alert('Error: ' + (res.error || 'Unknown')); }
    } catch (e) { alert('Network Error: ' + e.message); }
};

document.getElementById('btn-login').onclick = handleLogin;
document.getElementById('btn-logout').onclick = () => { localStorage.clear(); window.location.reload(); };
document.getElementById('btn-save-key').onclick = saveVaultKey;

window.onload = async () => {
    lucide.createIcons();
    if (!STATE.token) showAuth();
    else {
        await loadPrincipals();
        switchView('fleet');
    }
};
