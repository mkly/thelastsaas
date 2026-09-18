import { Hono } from "hono";
import type { AppEnvironment } from "../env";
import { escapeHtml, getExternalOrigin, htmlPage } from "../html";

export const installRouter = new Hono<AppEnvironment>();

installRouter.get("/install", async (context) => {
  const session = await context
    .get("services")
    .auth.api.getSession({ headers: context.req.raw.headers });
  const server = getExternalOrigin(
    context.req.raw,
    context.get("config").betterAuthUrl,
  );
  const endpoint = `${server}/v1/mcp`;
  const code = (value: string) =>
    `<pre><code>${escapeHtml(value)}</code></pre>`;
  const auth =
    "Sign in to The Last SaaS and approve account access. Once connected, your assistant can select or create an organization.";
  const instructions = (name: string, body: string) =>
    `<details class="install-client"><summary>${name}</summary><div class="install-instructions">${body}</div></details>`;
  const downloads = [
    ["Linux x64", "linux-x64", "saas"],
    ["Linux arm64", "linux-arm64", "saas"],
    ["macOS x64 (Intel)", "darwin-x64", "saas"],
    ["macOS arm64 (Apple Silicon)", "darwin-arm64", "saas"],
    ["Windows x64", "windows-x64", "saas.exe"],
  ]
    .map(
      ([label, platform, file]) =>
        `<li class="record"><span class="record__body">${label}</span><a class="button secondary" href="/dl/${platform}/${file}">Download</a></li>`,
    )
    .join("");
  const message = context.req.query("message");
  return context.html(
    htmlPage(
      "Install",
      `
    ${message ? `<p class="alert">${escapeHtml(message)}</p>` : ""}
    <div class="install-guide">
    <nav class="button-row" aria-label="Installation methods"><a class="button secondary" href="#mcp">Connect over MCP</a><a class="button secondary" href="#cli">Install the CLI</a></nav>
    <section class="install-section" aria-labelledby="mcp">
    <h2 id="mcp">Connect over MCP</h2>
    <p>Add this remote server URL to your assistant. No CLI or copied token is required.</p>
    <div class="install-endpoint"><span class="small muted">MCP server URL</span>${code(endpoint)}</div>
    <p class="small muted">Choose your app for connection instructions.</p>
    ${instructions(
      "Claude",
      `<ol>
      <li>Open <strong>Customize → Connectors</strong>, then choose <strong>+ → Add custom connector</strong>.</li>
      <li>Name it <strong>The Last SaaS</strong> and enter the server URL above.</li>
      <li>Add the connector and click <strong>Connect</strong>. ${auth}</li>
      <li>Enable The Last SaaS in your conversation’s tools menu.</li>
    </ol><p class="small muted">On a team plan, an owner may need to add the connector first. <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp">Claude’s connection guide</a></p>`,
    )}
    ${instructions(
      "ChatGPT",
      `<ol>
      <li>On the web, open <strong>Settings → Security and login</strong> and enable <strong>Developer mode</strong>.</li>
      <li>Open <a href="https://chatgpt.com/apps">Apps / Plugins</a> and use the plus button to create a developer-mode app. Name it <strong>The Last SaaS</strong>, choose <strong>OAuth</strong>, and enter the server URL above.</li>
      <li>${auth}</li>
      <li>In a new conversation, choose <strong>Developer mode</strong> from the plus menu and select The Last SaaS.</li>
    </ol><p class="small muted">Requires a plan with Developer mode. Workspace settings may require administrator approval. <a href="https://developers.openai.com/api/docs/guides/developer-mode">ChatGPT’s connection guide</a></p>`,
    )}
    ${instructions(
      "Codex",
      `<ol>
      <li>With Codex CLI installed, add the server:${code(`codex mcp add lastsaas --url ${endpoint}`)}</li>
      <li>If sign-in hasn’t opened, run:${code("codex mcp login lastsaas")}${auth}</li>
      <li>Start a new Codex session. In the app, use the same local environment where you added the server.</li>
    </ol><p><a href="https://developers.openai.com/codex/mcp/">Codex’s MCP guide</a></p>`,
    )}
    ${instructions(
      "Claude Code",
      `<ol>
      <li>With Claude Code installed, add the server:${code(`claude mcp add --transport http --scope user lastsaas ${endpoint}`)}</li>
      <li>Start Claude Code, run <code>/mcp</code>, and select <strong>lastsaas</strong> to authenticate. ${auth}</li>
      <li>Return to your conversation with The Last SaaS tools enabled.</li>
    </ol><p><a href="https://code.claude.com/docs/en/mcp">Claude Code’s MCP guide</a></p>`,
    )}
    ${instructions(
      "Cursor",
      `<ol>
      <li>Add the <strong>lastsaas</strong> entry to <code>mcpServers</code> in <code>~/.cursor/mcp.json</code>, preserving existing servers:${code(JSON.stringify({ mcpServers: { lastsaas: { url: endpoint } } }, null, 2))}</li>
      <li>Open Cursor’s MCP settings, enable <strong>lastsaas</strong>, and complete sign-in. ${auth}</li>
      <li>Open an Agent conversation with The Last SaaS tools enabled.</li>
    </ol><p><a href="https://cursor.com/docs/mcp">Cursor’s MCP guide</a></p>`,
    )}
    ${instructions(
      "Gemini CLI",
      `<ol>
      <li>Add the server:${code(`gemini mcp add --transport http --scope user lastsaas ${endpoint}`)}</li>
      <li>Start Gemini CLI and run <code>/mcp auth lastsaas</code>. ${auth}</li>
      <li>Use <code>/mcp</code> to check the connection.</li>
    </ol><p><a href="https://geminicli.com/docs/tools/mcp-server/">Gemini CLI’s MCP guide</a></p>`,
    )}
    ${instructions("Other MCP clients", `<p>Use a client supporting remote Streamable HTTP and OAuth. Add the server URL above, connect using OAuth, and enable its tools in a conversation. ${auth}</p>`)}
    </section>
    <section class="install-section" aria-labelledby="cli">
    <h2 id="cli">Install the CLI</h2>
    <p>Install <code>saas</code> on the same machine as your terminal or local agent.</p>
    <h3>Linux / macOS</h3>${code(`curl -fsSL ${server}/install.sh | sh`)}
    <p>The installer detects your platform and installs to <code>$HOME/.local/bin/saas</code>. Add that directory to your PATH if needed. Set <code>LASTSAAS_INSTALL_DIR</code> to choose another directory.</p>
    <details class="install-client"><summary>Manual downloads</summary><div class="install-instructions"><ul class="record-list">${downloads}</ul>
    <p>On Linux or macOS, run <code>chmod +x saas</code> and move the binary to a directory on your PATH. On Windows, add the folder containing <code>saas.exe</code> to your PATH.</p></div></details>
    <h3>Sign in and select an organization</h3>${code(`saas login --server ${server}\nsaas orgs list`)}
    <p>Approve sign-in in your browser. If you have no organization, create one:</p>${code('saas orgs create "My Workspace"')}
    <p>Otherwise select an organization using its ID from the list:</p>${code("saas orgs use YOUR_ORGANIZATION_ID\nsaas whoami")}
    <p>For an agent with terminal access, have it read <code>saas skills print</code> for the available commands.</p>
    </section></div>
  `,
      {
        authenticated: Boolean(session?.user),
        current: "/install",
        description: "Connect your assistant or install the CLI.",
      },
    ),
  );
});
