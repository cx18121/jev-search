import { createMcpAdapter } from "pi-mcp-adapter";

const mutatingBetterStackTools = [
	"create_*",
	"update_*",
	"remove_*",
	"delete_*",
	"add_*",
	"configure_*",
	"set_*",
	"move_*",
	"import_*",
	"invite_*",
	"change_*",
	"acknowledge_*",
	"escalate_*",
	"resolve_*",
	"reopen_*",
	"pause_*",
];

const slackScopes = [
	"search:read.public",
	"search:read.private",
	"search:read.mpim",
	"search:read.im",
	"search:read.files",
	"search:read.users",
	"files:read",
	"emoji:read",
	"channels:history",
	"groups:history",
	"mpim:history",
	"im:history",
	"canvases:read",
	"users:read",
	"users:read.email",
	"channels:read",
	"groups:read",
	"mpim:read",
].join(" ");

const mutatingSlackTools = [
	"send_*",
	"create_*",
	"update_*",
	"add_*",
	"remove_*",
	"delete_*",
	"archive_*",
];

export default createMcpAdapter({
	config: {
		mcpServers: {
			linear: {
				url: "https://mcp.linear.app/mcp",
				auth: "oauth",
				lifecycle: "lazy",
				directTools: false,
			},
			exa: {
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run",
				headers: {
					"x-api-key": "!/usr/bin/security find-generic-password -a charliexue -s pi-web-access-exa -w",
				},
				lifecycle: "lazy",
				requestTimeoutMs: 480000,
				directTools: false,
				includeTools: [
					"web_search_exa",
					"web_fetch_exa",
					"web_search_advanced_exa",
					"agent_run",
				],
			},
			betterstack: {
				url: "https://mcp.betterstack.com",
				auth: "oauth",
				oauth: {
					scope: "read",
				},
				lifecycle: "lazy",
				directTools: false,
				excludeTools: mutatingBetterStackTools,
			},
			ecotone: {
				url: "https://docs.ecotone.tech/~gitbook/mcp",
				lifecycle: "lazy",
				directTools: false,
			},
			clickhouse: {
				command:
					"/Users/charliexue/.local/share/mise/installs/ubi-astral-sh-uv/0.11.28/uv",
				args: ["tool", "run", "--python", "3.12", "mcp-clickhouse==0.6.0"],
				inheritEnv: false,
				env: {
					CLICKHOUSE_HOST: "pa2zn43s8j.eu-central-1.aws.clickhouse.cloud",
					CLICKHOUSE_PORT: "8443",
					CLICKHOUSE_USER: "pango_mcp_readonly",
					CLICKHOUSE_PASSWORD:
						"!/usr/bin/security find-generic-password -a pango_mcp_readonly -s pi-clickhouse-readonly -w",
					CLICKHOUSE_DATABASE: "pango-analytics",
					CLICKHOUSE_SECURE: "true",
					CLICKHOUSE_VERIFY: "true",
					CLICKHOUSE_ALLOW_WRITE_ACCESS: "false",
					CLICKHOUSE_MCP_SERVER_TRANSPORT: "stdio",
					CHDB_ENABLED: "false",
				},
				lifecycle: "lazy",
				directTools: false,
			},
			context7: {
				url: "https://mcp.context7.com/mcp/oauth",
				auth: "oauth",
				lifecycle: "lazy",
				directTools: false,
			},
			slack: {
				url: "https://mcp.slack.com/mcp",
				auth: "oauth",
				oauth: {
					clientId: "9158050576082.11832346008660",
					clientSecret:
						"!security find-generic-password -s pi-slack-mcp-client-secret -w",
					redirectUri: "http://localhost:3118/callback",
					scope: slackScopes,
				},
				lifecycle: "lazy",
				directTools: false,
				excludeTools: mutatingSlackTools,
			},
		},
		settings: {
			hostConfigDiscovery: "off",
			mcpFooterStatus: "off",
			notifyOnStartupConnect: false,
			directTools: false,
			scriptMode: false,
			autoAuth: false,
			sampling: false,
			elicitation: false,
			outputGuard: true,
		},
	},
});
