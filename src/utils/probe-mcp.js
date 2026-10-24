// src/utils/probe-mcp.js
// usage: node src/utils/probe-mcp.js path/to/mcp-config.json [serverName]
const fs = require('node:fs');
(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const servers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers;
  const only = process.argv[3];
  for (const [name, s] of Object.entries(servers)) {
    if (only && name !== only) continue;
    const [command, ...args] = s.command;
    const t0 = Date.now();
    const client = new Client({ name: 'probe', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command, args, stderr: 'pipe',
      env: { ...process.env, ...(s.environment || {}) },
    });
    transport.stderr?.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    try {
      await client.connect(transport);
      const connectMs = Date.now() - t0;
      const { tools } = await client.listTools();
      console.log(JSON.stringify({ server: name, connectMs, tools: tools.map((t) => t.name) }));
    } catch (e) {
      console.log(JSON.stringify({ server: name, error: String(e.message || e), afterMs: Date.now() - t0 }));
    } finally {
      await client.close().catch(() => {});
    }
  }
})();
