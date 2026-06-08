/**
 * Conclave — MCP Config Generator Tests
 */
import { describe, it, expect } from 'vitest';
import { generateMcpConfigs, type McpHostConfig } from '../services/mcp-config.js';

describe('MCP Config Generator', () => {
  const apiUrl = 'https://conclave-bp4o.onrender.com';
  const principalId = 'prn_test';
  const agentToken = 'clv_test_token_abc123';

  it('generates configs for all supported hosts', () => {
    const configs = generateMcpConfigs(apiUrl, principalId, agentToken);

    const labels = configs.map(c => c.label);
    expect(labels).toContain('Claude Desktop');
    expect(labels).toContain('VSCode / Cline');
    expect(labels).toContain('Cursor');
    expect(labels).toContain('Windsurf');
    expect(labels).toContain('Roo Code');
    expect(labels).toContain('Continue');
    expect(labels).toContain('Hermes Agent');
    expect(labels).toContain('OpenCode');
    expect(configs.length).toBe(8);
  });

  it('includes the API URL in the args for all configs', () => {
    const configs = generateMcpConfigs(apiUrl, principalId, agentToken);
    for (const host of configs) {
      // Check the nested transport config
      const innerConfig = (host.config as any).mcpServers?.conclave
        || (host.config as any).mcp_servers?.conclave
        || (host.config as any).experimental?.mcpServers?.conclave;

      expect(innerConfig).toBeDefined();
      expect(innerConfig.command).toBe('npx');
      expect(innerConfig.args).toContain(apiUrl);
      expect(innerConfig.args).toContain(agentToken);
    }
  });

  it('uses the correct JSON key structure for each host', () => {
    const configs = generateMcpConfigs(apiUrl, principalId, agentToken);

    // Claude Desktop: mcpServers.conclave
    const claude = configs.find(c => c.label === 'Claude Desktop')!;
    expect((claude.config as any).mcpServers?.conclave).toBeDefined();
    expect((claude.config as any).experimental).toBeUndefined();

    // Continue: experimental.mcpServers.conclave
    const continueCfg = configs.find(c => c.label === 'Continue')!;
    expect((continueCfg.config as any).experimental?.mcpServers?.conclave).toBeDefined();

    // Hermes: mcp_servers.conclave (snake_case)
    const hermes = configs.find(c => c.label === 'Hermes Agent')!;
    expect((hermes.config as any).mcp_servers?.conclave).toBeDefined();
    expect((hermes.config as any).mcpServers).toBeUndefined();
  });

  it('each config has a filename and description', () => {
    const configs = generateMcpConfigs(apiUrl, principalId, agentToken);
    for (const host of configs) {
      expect(host.filename).toBeTruthy();
      expect(host.description).toBeTruthy();
    }
  });
});