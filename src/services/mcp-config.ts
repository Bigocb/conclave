/**
 * Conclave — MCP Config Generator
 * Generates MCP client configuration snippets for different hosts
 * (Claude Desktop, VSCode/Cline, Cursor, Windsurf, Roo Code,
 *  Continue, Hermes Agent, OpenCode)
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { AgentService } from '../services/agents.js';

export interface McpHostConfig {
  label: string;
  description: string;
  filename: string;
  config: Record<string, unknown>;
}

export function generateMcpConfigs(
  apiUrl: string,
  principalId: string,
  agentToken: string,
): McpHostConfig[] {
  const baseConfig = {
    command: 'npx',
    args: ['tsx', 'src/mcp/index.ts', '--server', apiUrl, '--principal', principalId, '--token', agentToken],
  };

  return [
    {
      label: 'Claude Desktop',
      description: 'Place in claude_desktop_config.json',
      filename: 'claude_desktop_config.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
    {
      label: 'VSCode / Cline',
      description: 'Place in .vscode/mcp.json or Cline MCP settings',
      filename: '.vscode/mcp.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
    {
      label: 'Cursor',
      description: 'Place in .cursor/mcp.json',
      filename: '.cursor/mcp.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
    {
      label: 'Windsurf',
      description: 'Place in .windsurf/mcp_config.json',
      filename: '.windsurf/mcp_config.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
    {
      label: 'Roo Code',
      description: 'Place in .roo/mcp.json',
      filename: '.roo/mcp.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
    {
      label: 'Continue',
      description: 'Add to config.json under experimental.mcpServers',
      filename: 'config.json',
      config: { experimental: { mcpServers: { conclave: { ...baseConfig } } } },
    },
    {
      label: 'Hermes Agent',
      description: 'Add to ~/.hermes/config.yaml under mcp_servers',
      filename: '~/.hermes/config.yaml',
      config: { mcp_servers: { conclave: { command: baseConfig.command, args: baseConfig.args } } },
    },
    {
      label: 'OpenCode',
      description: 'Place in opencode.json',
      filename: 'opencode.json',
      config: { mcpServers: { conclave: { ...baseConfig } } },
    },
  ];
}

export async function getMcpConfigForAgent(
  fastify: FastifyInstance,
  agentId: string,
  orgId: string,
): Promise<{ agent_id: string; agent_name: string; api_url: string; configs: McpHostConfig[] } | null> {
  const agentSvc = new AgentService(fastify.db);
  const agent = await agentSvc.getById(agentId);
  if (!agent) return null;

  // Org isolation
  if (agent.org_id !== orgId) return null;

  // Look up the agent's token directly from the DB
  const rows = await (fastify.db as any).select({ token: schema.agents.token })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);

  if (rows.length === 0 || !rows[0].token) return null;
  const token = rows[0].token;

  // Determine the API URL
  const apiUrl = process.env.RENDER
    ? 'https://conclave-bp4o.onrender.com'
    : 'http://localhost:3000';

  const configs = generateMcpConfigs(apiUrl, agent.principal_id, token);

  return {
    agent_id: agent.id,
    agent_name: agent.name,
    api_url: apiUrl,
    configs,
  };
}