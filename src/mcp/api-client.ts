/**
 * Conclave MCP Server — API Client
 * Thin REST client that wraps all Conclave /v1/ endpoints.
 * Used by MCP tool handlers to communicate with a running Conclave server.
 */

interface ConclaveConfig {
  serverUrl: string;  // e.g. http://localhost:3000
  principalId?: string; // optional — token resolves it server-side
  agentId?: string;    // optional — token resolves it server-side
  token?: string;      // auth token (clv_ for agent, JWT for user)
}

interface ApiResponse {
  status: string;
  data: any;
  meta?: { request_id: string; timestamp: string };
}

export class ConclaveApiClient {
  private baseUrl: string;
  private principalId?: string;
  private agentId?: string;
  private token?: string;

  constructor(configOrUrl: ConclaveConfig | string, principalId?: string) {
    if (typeof configOrUrl === 'string') {
      this.baseUrl = configOrUrl.replace(/\/$/, '');
      this.principalId = principalId ?? 'prn_dev';
      this.agentId = 'agt_dev';
      this.token = undefined;
    } else {
      this.baseUrl = configOrUrl.serverUrl.replace(/\/$/, '');
      this.principalId = configOrUrl.principalId;
      this.agentId = configOrUrl.agentId;
      this.token = configOrUrl.token;
    }
  }

  /** Set the auth token (e.g. after registration) */
  setToken(token: string): void {
    this.token = token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const url = `${this.baseUrl}/v1${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    // Only send X-Agent-Id when there's no token — with a clv_ or JWT token,
    // the server resolves agent/principal/org server-side. Sending X-Agent-Id
    // overrides that resolution and causes FORBIDDEN/org mismatch errors.
    if (!this.token && this.agentId) {
      headers['X-Agent-Id'] = this.agentId;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err: any) {
      throw new Error(`Conclave API connection failed (${method} ${url}): ${err.message || err}. Check that --server URL is reachable.`);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      throw new Error(`Conclave API returned ${res.status} ${res.statusText} for ${method} ${url}: ${detail}`);
    }

    const json = await res.json() as ApiResponse;

    if (json.status !== 'success') {
      throw new Error(`Conclave API error: ${JSON.stringify(json)}`);
    }

    return json;
  }

  // ─── Health ────────────────────────────────────────

  async health() {
    const res = await fetch(`${this.baseUrl}/v1/health`);
    return res.json();
  }

  // ─── Principals ────────────────────────────────────

  async getPrincipal(id?: string) {
    return this.request('GET', `/principals/${id ?? this.principalId}`);
  }

  async listPrincipals() {
    return this.request('GET', '/principals');
  }

  async createPrincipal(data: { id?: string; name: string; org_id?: string; roles?: string[]; capabilities?: string[]; metadata?: Record<string, unknown>; initial_budget?: number }) {
    return this.request('POST', '/principals', data);
  }

  async updatePrincipal(id: string, data: { name?: string; roles?: string[]; capabilities?: string[]; metadata?: Record<string, unknown> }) {
    return this.request('PUT', `/principals/${id}`, data);
  }

  // ─── Agents ────────────────────────────────────────

  async registerAgentUnderPrincipal(principalId: string, data: { name: string; type?: string; model?: string; provider?: string; llm_url?: string; command?: string; instructions?: string; skills?: string[] }) {
    return this.request('POST', `/principals/${principalId}/agents`, {
      principal_id: principalId,
      ...data,
    });
  }

  /** Resolve own identity from auth token (clv_ or JWT) via GET /v1/agents/me */
  async resolveSelf(): Promise<{ agent_id: string | null; principal_id: string | null; org_id: string | null }> {
    try {
      const res = await this.request('GET', '/agents/me');
      return {
        agent_id: res.data?.agent_id ?? null,
        principal_id: res.data?.principal_id ?? null,
        org_id: res.data?.org_id ?? null,
      };
    } catch {
      // Fall back to configured IDs when no token or token fails
      return { agent_id: this.agentId, principal_id: this.principalId, org_id: null };
    }
  }

  // ─── Tasks ──────────────────────────────────────

  async listAgentsUnderPrincipal(principalId: string) {
    return this.request('GET', `/principals/${principalId}/agents`);
  }

  async listAgents() {
    return this.request('GET', '/agents');
  }

  async getAgent(id: string) {
    return this.request('GET', `/agents/${id}`);
  }

  // ─── Tasks ─────────────────────────────────────────

  async submitTask(data: {
    task_description: string;
    dimensions: string[];
    output: string;
    output_format?: string;
    channel: string;
    requested_reviews?: number;
    priority?: string;
    deadline?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request('POST', '/tasks', data);
  }

  async getTask(id: string) {
    return this.request('GET', `/tasks/${id}`);
  }

  async listTasks(filters?: { status?: string; channel?: string; principal_id?: string }) {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.channel) params.set('channel', filters.channel);
    if (filters?.principal_id) params.set('principal_id', filters.principal_id);
    const qs = params.toString();
    return this.request('GET', `/tasks${qs ? `?${qs}` : ''}`);
  }

  async submitReview(taskId: string, data: {
    scores: Record<string, number>;
    weighted_overall: number;
    reviewer_confidence: number;
    comment?: string;
    suggestions?: string[];
    approved?: boolean;
  }) {
    return this.request('POST', `/tasks/${taskId}/reviews`, data);
  }

  async markHelpful(taskId: string, reviewId: string) {
    return this.request('POST', `/tasks/${taskId}/helpful`, { review_id: reviewId });
  }

  // ─── Opinions ──────────────────────────────────────

  async askOpinion(data: {
    question: string;
    context?: string;
    channel: string;
    requested_opinions?: number;
    deadline?: string;
  }) {
    return this.request('POST', '/opinions', data);
  }

  async getOpinion(id: string) {
    return this.request('GET', `/opinions/${id}`);
  }

  async listOpinions(filters?: { channel?: string }) {
    const params = new URLSearchParams();
    if (filters?.channel) params.set('channel', filters.channel);
    const qs = params.toString();
    return this.request('GET', `/opinions${qs ? `?${qs}` : ''}`);
  }

  async respondToOpinion(opinionId: string, data: {
    response: string;
    confidence: number;
    reasoning?: string;
    references?: string[];
  }) {
    return this.request('POST', `/opinions/${opinionId}/responses`, data);
  }

  // ─── Channels ──────────────────────────────────────

  async listChannels() {
    return this.request('GET', '/channels');
  }

  async getChannel(name: string) {
    return this.request('GET', `/channels/${name}`);
  }

  async subscribeToChannel(name: string) {
    return this.request('POST', `/channels/${name}/subscribe`, {});
  }

  async unsubscribeFromChannel(name: string) {
    return this.request('DELETE', `/channels/${name}/subscribe`);
  }

  async getChannelFeed(name: string, limit?: number) {
    const params = limit ? `?limit=${limit}` : '';
    return this.request('GET', `/channels/${name}/feed${params}`);
  }

  // ─── Budget ────────────────────────────────────────

  async getBudget(principalId?: string) {
    return this.request('GET', `/principals/${principalId ?? this.principalId}/budget`);
  }

  // ─── Reputation ────────────────────────────────────

  async getReputation(id?: string) {
    return this.request('GET', `/reputation/${id ?? this.principalId}`);
  }

  async getLeaderboard(dimension?: string) {
    const params = dimension ? `?dimension=${dimension}` : '';
    return this.request('GET', `/leaderboard${params}`);
  }

  // ─── Spot Check ────────────────────────────────────

  async submitSpotCheck(data: {
    review_id: string;
    accuracy: number;
    fairness: number;
    comment?: string;
  }) {
    return this.request('POST', '/spot-check', data);
  }

  // ─── Orgs ──────────────────────────────────────────

  async getOrg(id: string) {
    return this.request('GET', `/orgs/${id}`);
  }
}