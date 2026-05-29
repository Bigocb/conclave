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
            break;
        case 'REVIEW_SUBMITTED':
            showToast(`New review submitted for task ${payload.taskId.slice(0,8)}`, 'success');
            if (document.getElementById('view-tasks')?.classList.contains('hidden') === false) {
                refreshTasks();
            }
            break;
    }

    if (typeof appendToVoid === 'function') {
        if (type.startsWith('FLEET_')) {
            appendToVoid(type, payload);
        }
        if (type === 'FLEET_HEARTBEAT') {
            handleNOCHeartbeat(payload);
        }
    }
}

// ─── War Room / NOC Controller ──────────────────────────────────────

const NOC_STATE = {
    metrics: { active: 0, completed: 0, faults: 0 },
    fleet: new Map(), 
};

function handleNOCHeartbeat(payload) {
    NOC_STATE.fleet.set(payload.principalId, { 
        name: payload.reviewerName, 
        lastSeen: Date.now() 
    });
    updateNOCFleetList();
}

function updateNOCMetric(key, value) {
    if (NOC_STATE.metrics[key] === value) return;
    NOC_STATE.metrics[key] = value;
    const el = document.getElementById(`metric-${key}`);
    if (el) {
        el.innerText = value;
        el.classList.add('text-white');
        setTimeout(() => el.classList.remove('text-white'), 100);
    }
}

function appendToVoid(type, payload) {
    const stream = document.getElementById('noc-stream');
    if (!stream) return;

    const time = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
    const row = document.createElement('div');
    row.className = 'flex gap-3 py-0.5 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors';
    
    let color = 'text-gray-400';
    let prefix = '[INFO]';

    if (type.includes('ERROR') || type.includes('FAULT')) {
        color = 'text-red-500';
        prefix = '[FAIL]';
    } else if (type.includes('FOUND') || type.includes('START')) {
        color = 'text-green-400';
        prefix = '[PICK]';
    } else if (type.includes('SUBMITTED') || type.includes('QUEUED')) {
        color = 'text-amber-400';
        prefix = '[SYNC]';
    } else if (type === 'FLEET_HEARTBEAT') {
        return; 
    }

    const message = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    
    row.innerHTML = `
        <span class="text-gray-600 shrink-0">${time}</span>
        <span class="font-bold ${color} shrink-0 w-12">${prefix}</span>
        <span class="text-gray-300">${message}</span>
    `;

    stream.appendChild(row);
    stream.scrollTop = stream.scrollHeight;

    while (stream.children.length > 100) {
        stream.removeChild(stream.firstChild);
    }

    if (type === 'FLEET_TASK_FOUND') {
        updateNOCMetric('active', NOC_STATE.metrics.active + 1);
    } else if (type === 'FLEET_REVIEW_SUBMITTED') {
        updateNOCMetric('completed', NOC_STATE.metrics.completed + 1);
        updateNOCMetric('active', Math.max(0, NOC_STATE.metrics.active - 1));
    } else if (type === 'FLEET_FETCH_ERROR') {
        updateNOCMetric('faults', NOC_STATE.metrics.faults + 1);
    }
}

function updateNOCFleetList() {
    const listEl = document.getElementById('noc-fleet-list');
    if (!listEl) return;

    const items = Array.from(NOC_STATE.fleet.entries())
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
        .map(([id, data]) => {
            const since = Math.floor((Date.now() - data.lastSeen) / 1000);
            const statusColor = since < 60 ? 'text-green-500' : since < 300 ? 'text-amber-500' : 'text-red-500';
            return `<div class="flex justify-between items-center">
                <span class="truncate">${data.name}</span>
                <span class="${statusColor}">${since}s ago</span>
            </div>`;
        }).join('\n');
    
    if (listEl.innerText !== items) {
        listEl.innerHTML = items || 'No active cores...';
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

// ─── Navigation & View Controller ──────────────────────────────────────

function switchView(viewId) {
    console.log(`[UI] Switching to view: ${viewId}`);
    
    const views = ['fleet', 'vault', 'tasks', 'channels', 'workers', 'org', 'factory', 'profiles', 'noc', 'fleet-manager'];
    if (!views.includes(viewId)) {
        console.error(`[UI] View ID '${viewId}' is not in the whitelist.`);
        return;
    }

    const target = document.getElementById(`view-${viewId}`);
    if (!target) {
        console.error(`[UI] Target element #view-${viewId} not found in DOM.`);
        return;
    }

    document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
    target.classList.remove('hidden');
    
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('onclick')?.includes(`switchView('${viewId}')`)) {
            item.classList.add('active');
        }
    });
    
    if (viewId === 'profiles') profileController.loadProfiles();
    if (viewId === 'fleet-manager') fleetController.reload();
    if (viewId === 'noc') initPulse();
}

// ─── Mobile Sidebar ──────────────────────────────────────────

function openMobileSidebar() {
    document.getElementById('mobile-sidebar-overlay').classList.add('open');
    document.getElementById('mobile-sidebar-panel').classList.add('open');
    document.body.style.overflow = 'hidden';
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

// ─── Profile Controller ────────────────────────────────────────────────

const profileController = {
    async loadProfiles() {
        const listEl = document.getElementById('profiles-list');
        if (!listEl) return;
        
        try {
            const profiles = await apiRequest('/v1/profiles');
            listEl.innerHTML = '';
            
            if (profiles.length === 0) {
                listEl.innerHTML = '<div class="col-span-full text-center py-12 text-gray-500 italic">No agent profiles found. Create one to get started.</div>';
                return;
            }

            profiles.forEach(p => {
                const card = document.createElement('div');
                card.className = 'bg-zinc-900 border border-white/10 p-4 rounded-xl hover:border-green-500/50 transition-all group';
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-3">
                        <h3 class="font-bold text-white">${p.name}</h3>
                        <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onclick="profileController.editProfile('${p.id}')" class="p-1 hover:text-green-400"><i data-lucide="edit-2" class="w-3 h-3"></i></button>
                            <button onclick="profileController.deleteProfile('${p.id}')" class="p-1 hover:text-red-400"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
                        </div>
                    </div>
                    <div class="text-[10px] space-y-1 font-mono text-gray-500">
                        <div class="flex justify-between"><span>MODEL:</span><span class="text-gray-300">${p.model}</span></div>
                        <div class="flex justify-between"><span>PROV:</span><span class="text-gray-300">${p.provider}</span></div>
                    </div>
                `;
                listEl.appendChild(card);
            });
            lucide.createIcons();
        } catch (e) {
            console.error('Failed to load profiles:', e);
            showToast('Failed to load profiles', 'error');
        }
    },

    async saveProfile(e) {
        e.preventDefault();
        const id = document.getElementById('profile-id').value;
        const profile = {
            name: document.getElementById('profile-name').value,
            model: document.getElementById('profile-model').value,
            provider: document.getElementById('profile-provider').value,
            instructions: document.getElementById('profile-instructions').value,
            skills: document.getElementById('profile-skills').value
        };

        try {
            if (id) {
                await apiRequest(`/v1/profiles/${id}`, 'PATCH', profile);
            } else {
                await apiRequest('/v1/profiles', 'POST', profile);
            }
            showToast('Profile saved', 'success');
            closeProfileModal();
            this.loadProfiles();
        } catch (err) {
            showToast(err.message, 'error');
        }
    },

    async editProfile(id) {
        try {
            const p = await apiRequest(`/v1/profiles/${id}`);
            document.getElementById('profile-id').value = p.id;
            document.getElementById('profile-name').value = p.name;
            document.getElementById('profile-model').value = p.model;
            document.getElementById('profile-provider').value = p.provider;
            document.getElementById('profile-instructions').value = p.instructions;
            document.getElementById('profile-skills').value = p.skills || '';
            document.getElementById('profile-modal-title').innerText = 'Edit Profile';
            openProfileModal();
        } catch (e) {
            showToast('Failed to load profile details', 'error');
        }
    },

    async deleteProfile(id) {
        if (!confirm('Delete this profile?')) return;
        try {
            await apiRequest(`/v1/profiles/${id}`, 'DELETE');
            showToast('Profile deleted', 'success');
            this.loadProfiles();
        } catch (e) {
            showToast('Delete failed', 'error');
        }
    }
};

// ─── Fleet Orchestration Controller ─────────────────────────────────────

const fleetController = {
    async reload() {
        const grid = document.getElementById('fleet-grid');
        if (!grid) return;
        
        try {
            const reviewers = await apiRequest('/v1/fleet/reviewers');
            grid.innerHTML = '';
            
            if (reviewers.length === 0) {
                grid.innerHTML = '<div class="col-span-full text-center py-12 text-gray-500 italic">No fleet reviewers configured.</div>';
                return;
            }

            reviewers.forEach(r => {
                const card = document.createElement('div');
                card.className = 'bg-zinc-900 border border-white/10 p-6 rounded-xl space-y-4';
                card.innerHTML = `
                    <div class="flex justify-between items-center">
                        <h3 class="font-bold text-white">${r.channel}</h3>
                        <span class="text-xs font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded">Active</span>
                    </div>
                    <div class="grid grid-cols-2 gap-4 text-xs font-mono">
                        <div class="p-3 bg-black rounded-lg border border-white/5">
                            <label class="text-gray-500 block mb-1">Profile</label>
                            <select onchange="fleetController.updateProfile('${r.id}', this.value)" class="bg-transparent text-white w-full outline-none">
                                <option value="">Select Profile...</option>\n                                ${this.getProfileOptions(r.profileId)}
                            </select>
                        </div>
                        <div class="p-3 bg-black rounded-lg border border-white/5">
                            <label class="text-gray-500 block mb-1">Replicas</label>
                            <input type="number" value="${r.replicas}" 
                                onchange="fleetController.updateReplicas('${r.id}', this.value)"
                                class="bg-transparent text-white w-full outline-none">
                        </div>
                    </div>
                `;
                grid.appendChild(card);
            });
        } catch (e) {
            console.error('Fleet reload failed:', e);
            showToast('Failed to load fleet config', 'error');
        }
    },

    async getProfileOptions(currentId) {
        try {
            const profiles = await apiRequest('/v1/profiles');
            return profiles.map(p => `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${p.name}</option>`).join('');
        } catch (e) { return ''; }
    },

    async updateProfile(id, profileId) {
        try {
            await apiRequest(`/v1/fleet/reviewers/${id}`, 'PATCH', { profileId });
            showToast('Profile linked', 'success');
        } catch (e) { showToast('Update failed', 'error'); }
    },

    async updateReplicas(id, replicas) {
        try {
            await apiRequest(`/v1/fleet/reviewers/${id}`, 'PATCH', { replicas: parseInt(replicas) });
            showToast('Scale updated', 'success');
        } catch (e) { showToast('Scale failed', 'error'); }
    }
};

function openProfileModal() {
    document.getElementById('profile-id').value = '';
    document.getElementById('profile-form').reset();
    document.getElementById('profile-modal-title').innerText = 'Create Profile';
    document.getElementById('profile-modal').classList.remove('hidden');
}

function closeProfileModal() {
    document.getElementById('profile-modal').classList.add('hidden');
}

window.onload = async () => {
    initPulse();
    lucide.createIcons();
    if (!STATE.token) showAuth();
    else {
        switchView('fleet');
    }
};
