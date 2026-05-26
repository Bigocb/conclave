const STATE = {
    token: localStorage.getItem('clv_token'),
    orgId: localStorage.getItem('clv_orgId'),
    principals: null,
    apiBase: window.location.origin,
};

async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (STATE.token) headers['Authorization'] = `Bearer ${STATE.token}`;

    const config = {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
    };

    const url = `${STATE.apiBase}${endpoint}`;
    const res = await fetch(url, config);
    if (res.status === 401) {
        showAuth();
        throw new Error('Unauthorized');
    }
    return res.json();
}

let AUTH_MODE = 'login';

function toggleAuthMode(mode) {
    AUTH_MODE = mode;
    const isReg = mode === 'register';
    document.getElementById('auth-title').innerText = isReg ? 'Join Conclave' : 'Conclave Identity';
    document.getElementById('auth-subtitle').innerText = isReg ? 'Establish your identity and organization.' : 'Enter credentials to access your fleet control plane.';
    document.getElementById('reg-fields').classList.toggle('hidden', !isReg);
    document.getElementById('btn-login').innerText = isReg ? 'Create Account' : 'Access Dashboard';
}

function showAuth() {
    document.getElementById('auth-overlay').classList.remove('hidden');
}

function hideAuth() {
    document.getElementById('auth-overlay').classList.add('hidden');
}

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
            refreshUI();
        } catch (e) {
            alert('Login failed. Please check your credentials.');
        }
    } else {
        const fullName = document.getElementById('reg-name').value;
        const orgName = document.getElementById('reg-org').value;
        if (!fullName || !orgName) return alert('Name and Organization are required.');

        try {
            const data = await apiRequest('/v1/auth/register', 'POST', { 
                email, 
                password, 
                fullName,
                orgName,
                displayName: fullName,
            });
            STATE.token = data.token;
            STATE.orgId = data.orgId;
            localStorage.setItem('clv_token', data.token);
            localStorage.setItem('clv_orgId', data.orgId);
            hideAuth();
            await loadPrincipals();
            refreshUI();
        } catch (e) {
            alert('Registration failed: ' + (e.message || 'Email might be taken.'));
        }
    }
}

async function loadPrincipals() {
    try {
        const data = await apiRequest('/v1/principals');
        const principals = data.data || [];
        STATE.principals = principals.map(p => p.id);
        if (principals.length > 0) {
            STATE.defaultPrincipalId = principals[0].id;
        }
    } catch (e) {
        console.warn('Could not load principals', e);
    }
}

function switchView(viewId) {
    const views = ['fleet', 'vault', 'tasks', 'org', 'factory'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.classList.toggle('hidden', v !== viewId);
    });

    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active', 'text-white');
        item.classList.add('text-gray-400');
        if (item.textContent.toLowerCase().includes(viewId)) {
            item.classList.add('active');
            item.classList.remove('text-gray-400');
        }
    });
}

async function saveVaultKey() {
    const provider = document.getElementById('vault-provider').value;
    const key = document.getElementById('vault-key').value;
    if (!provider || !key) return alert('Both provider and key are required.');
    try {
        await apiRequest('/v1/vault/key', 'POST', { provider, key });
        document.getElementById('vault-provider').value = '';
        document.getElementById('vault-key').value = '';
        await refreshVault();
    } catch (e) {
        alert('Failed to save key to vault.');
    }
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
    } catch (e) {
        console.error('Vault refresh failed', e);
    }
}

async function refreshTasks() {
    const list = document.getElementById('task-list');
    try {
        const data = await apiRequest('/v1/tasks');
        const tasks = data.data || [];
        list.innerHTML = tasks.length ? '' : '<p class="text-gray-500 text-center py-8">No tasks found in the feed.</p>';
        tasks.forEach(t => {
            const statusColor = t.status === 'completed' ? 'text-green-400' : 'text-yellow-400';
            list.innerHTML += `
                <div class="p-4 bg-[#0c111b] border border-[#1e2d4a] rounded-xl">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-xs font-mono text-gray-500">${t.id}</span>
                        <span class="text-xs font-bold ${statusColor} uppercase">${t.status}</span>
                    </div>
                    <div class="text-sm mb-4 text-gray-300">${t.input}</div>
                    <div class="flex justify-between items-center text-xs">
                        <span class="text-gray-500">Agent: ${t.agent_id}</span>
                        <span class="font-bold text-green-400">Score: ${t.score || 'N/A'}</span>
                    </div>
                </div>`;
        });
    } catch (e) {
        console.error('Task feed refresh failed', e);
    }
}

function toggleDeployModal() {
    document.getElementById('deploy-modal').classList.toggle('hidden');
}

async function deployAgent() {
    const name = document.getElementById('deploy-name').value;
    const model = document.getElementById('deploy-model').value;
    if (!name) return alert('Agent name is required.');
    const principalId = STATE.principals && STATE.principals[0];
    if (!principalId) return alert('No principal available. Create an organization principal first.');
    try {
        await apiRequest('/v1/agents/register', 'POST', { 
            principal_id: principalId, 
            name, 
            model 
        });
        toggleDeployModal();
        refreshUI();
    } catch (e) {
        alert('Deployment failed: ' + (e.message || 'Check logs.'));
    }
}

async function refreshUI() {
    document.getElementById('display-org').innerText = STATE.orgId || 'No Org Linked';
    const grid = document.getElementById('agent-grid');
    try {
        const data = await apiRequest('/v1/agents');
        const agents = data.data || [];
        grid.innerHTML = agents.length ? '' : '<p class="text-gray-500 col-span-full text-center py-12">No agents deployed in this organization.</p>';
        agents.forEach(agent => {
            grid.innerHTML += `
                <div class="bg-[#0c111b] border border-[#1e2d4a] p-6 rounded-2xl hover:border-green-500/50 transition-all group">
                    <div class="flex justify-between items-start mb-4">
                        <div class="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-gray-400 group-hover:text-green-400 transition-colors">
                            <i data-lucide="bot" class="w-5 h-5"></i>
                        </div>
                        <span class="text-[10px] font-mono px-2 py-1 bg-white/5 rounded border border-white/10 text-gray-500">${agent.id}</span>
                    </div>
                    <h3 class="font-bold text-lg mb-1">${agent.name}</h3>
                    <p class="text-xs text-gray-400 mb-4">Model: <span class="text-green-400">${agent.model}</span></p>
                    <div class="flex items-center justify-between pt-4 border-t border-[#1e2d4a]">
                        <span class="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Status: Active</span>
                        <button class="p-2 hover:bg-white/10 rounded-md transition-all">
                            <i data-lucide="settings" class="w-4 h-4 text-gray-500"></i>
                        </button>
                    </div>
                </div>`;
        });
        lucide.createIcons();
    } catch (e) {
        console.error('Failed to load agents', e);
    }
    refreshFactory();
}

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
    if(!confirm('Decommission this agent?')) return;
    try {
        await apiRequest(`/v1/agents/${id}`, 'DELETE');
        refreshFactory();
    } catch (e) { alert('Failed to decommission'); }
}

document.getElementById('factory-reg-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const payload = Object.fromEntries(formData.entries());
    try {
        const res = await apiRequest('/v1/agents/register', 'POST', payload);
        if (res.success) {
            toggleFactoryModal(false);
            e.target.reset();
            refreshFactory();
        } else { alert('Error: ' + res.error); }
    } catch (e) { alert('Network Error'); }
};

document.getElementById('btn-login').onclick = handleLogin;
document.getElementById('btn-logout').onclick = () => {
    localStorage.clear();
    window.location.reload();
};
document.getElementById('btn-save-key').onclick = saveVaultKey;
document.getElementById('btn-add-agent').onclick = toggleDeployModal;
document.getElementById('btn-confirm-deploy').onclick = deployAgent;

window.onload = async () => {
    lucide.createIcons();
    if (!STATE.token) showAuth();
    else {
        await loadPrincipals();
        refreshUI();
    }
};
