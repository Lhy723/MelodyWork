import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkPiAgentScheduleCompatibility } from "./pi-agent-schedule-compatibility.mjs";
import { checkPiModelPolicyCompatibility } from "./pi-model-policy-compatibility.mjs";
import { checkTauriCommandPermissions } from "./tauri-command-permission-check.mjs";
import { checkPiResourceCompatibility } from "./pi-resource-compatibility.mjs";
import { checkPiSubagentPolicyCompatibility } from "./pi-subagent-policy-compatibility.mjs";
import { checkPiTerminalCompatibility } from "./pi-terminal-compatibility.mjs";
import { checkPiQuestionTimeoutCompatibility } from "./pi-question-timeout-compatibility.mjs";
import { checkPiMemoryToolsCompatibility } from "./pi-memory-tools-compatibility.mjs";
import { checkPiMcpInventoryCompatibility } from "./pi-mcp-inventory-compatibility.mjs";
import { checkPiMcpTransportsCompatibility } from "./pi-mcp-transports-compatibility.mjs";
import { checkPiWebToolsCompatibility } from "./pi-web-tools-compatibility.mjs";
import { checkPiLspCompatibility } from "./pi-lsp-compatibility.mjs";
import { checkPiCodebaseIndexCompatibility } from "./pi-codebase-index-compatibility.mjs";
import { checkPiHooksCompatibility } from "./pi-hooks-compatibility.mjs";
import { checkPiCompactionCompatibility } from "./pi-compaction-compatibility.mjs";
import { checkPiToolNamesCompatibility } from "./pi-tool-names-compatibility.mjs";
import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const root = process.cwd();
const failures = [];
failures.push(...checkTauriCommandPermissions(root));

const readJsonObject = (relativePath) => {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: 无法读取 JSON（${error.message}）`);
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${relativePath}: JSON 根节点必须是对象。`);
    return undefined;
  }

  return value;
};

const manifest = readJsonObject(
  "docs/architecture/pi-migration/pi-compatibility-manifest.json",
);

const workerPackage = readJsonObject("packages/agent-worker/package.json");
const adapterPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-adapter.ts",
);
const sessionResourceLoaderPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-resource-loader.ts",
);
const sessionResourceRefreshPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-resource-refresh-runtime.ts",
);
const sessionOpenRuntimePath = resolve(
  root,
  "packages/agent-worker/src/pi/session-open-runtime.ts",
);
const resourceDiscoveryPath = resolve(
  root,
  "packages/agent-worker/src/pi/resource-discovery.ts",
);
const skillDiscoveryPath = resolve(
  root,
  "packages/agent-worker/src/pi/skill-discovery.ts",
);
const promptDiscoveryPath = resolve(
  root,
  "packages/agent-worker/src/pi/prompt-discovery.ts",
);
const resourcePolicyPath = resolve(
  root,
  "packages/agent-worker/src/pi/resource-policy-snapshot.ts",
);
const modelPolicyPath = resolve(
  root,
  "packages/agent-worker/src/pi/model-policy.ts",
);
const modelCatalogRuntimePath = resolve(
  root,
  "packages/agent-worker/src/pi/model-catalog-runtime.ts",
);
const subagentRecordsPath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-records.ts",
);
const subagentSessionBoundariesPath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-session-boundaries.ts",
);
const subagentRuntimePath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-runtime.ts",
);
const todoExtensionPath = resolve(
  root,
  "packages/agent-worker/src/pi/todo-extension.ts",
);
const goalExtensionPath = resolve(
  root,
  "packages/agent-worker/src/pi/goal-extension.ts",
);
const goalStatePath = resolve(
  root,
  "packages/agent-worker/src/pi/goal-state.ts",
);
const goalGuardsPath = resolve(
  root,
  "packages/agent-worker/src/pi/goal-guards.ts",
);
const importPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-import.ts",
);
const modesPath = resolve(root, "packages/agent-contract/src/session-modes.ts");
const toolGatewayPath = resolve(root, "src-tauri/src/pi_tool_gateway.rs");
const requestPolicyPath = resolve(
  root,
  "src-tauri/src/pi_tool_gateway/request_policy.rs",
);
const workspaceToolsPath = resolve(
  root,
  "src-tauri/src/pi_tool_gateway/workspace_tools.rs",
);
const terminalTasksPath = resolve(
  root,
  "src-tauri/src/pi_tool_gateway/terminal_tasks.rs",
);
const toolOutputArchivePath = resolve(
  root,
  "src-tauri/src/pi_tool_output_archive.rs",
);
const monitorToolsPath = resolve(
  root,
  "src-tauri/src/pi_tool_gateway/monitor_tools.rs",
);
const schedulerToolsPath = resolve(
  root,
  "src-tauri/src/pi_tool_gateway/scheduler_tools.rs",
);
const workerToolGatewayPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-gateway.ts",
);
const workerToolNamesPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-names.ts",
);
const workerToolAccessPolicyPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-access-policy.ts",
);
const workerToolSchemasPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-schemas.ts",
);
const workerToolRequestLifecyclePath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-request-lifecycle.ts",
);
const workerToolPermissionPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-permission.ts",
);
const workerTaskToolsPath = resolve(
  root,
  "packages/agent-worker/src/pi/task-tools.ts",
);
const configExtensionsPath = resolve(
  root,
  "src-tauri/src/config_extensions.rs",
);
const configPiPolicyPath = resolve(root, "src-tauri/src/config_pi_policy.rs");
const configPiResourcesPath = resolve(
  root,
  "src-tauri/src/config_pi_resources.rs",
);
const configPromptResourcesPath = resolve(
  root,
  "src-tauri/src/config_prompt_resources.rs",
);
const configPluginCatalogPath = resolve(
  root,
  "src-tauri/src/config_plugin_catalog.rs",
);
const configRuntimePath = resolve(root, "src-tauri/src/config_runtime.rs");
const workerRuntimePath = resolve(root, "src-tauri/src/pi_worker_runtime.rs");
const webRuntimePath = resolve(root, "src-tauri/src/pi_web_runtime.rs");
const workerMemoryLifecyclePath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/memory_lifecycle.rs",
);
const workerProtocolPath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/protocol.rs",
);
const workerSessionCommandsPath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/session_commands.rs",
);
const workerEventAcceptancePath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/event_acceptance.rs",
);
const workerEventPipelinePath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/event_pipeline.rs",
);
const workerEnvrcPath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/envrc.rs",
);
const workerLaunchPath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/launch.rs",
);
const workerToolRoutingPath = resolve(
  root,
  "src-tauri/src/pi_worker_runtime/host_tool_routing.rs",
);
const memoryRuntimePath = resolve(root, "src-tauri/src/pi_memory_runtime.rs");
const memoryStorePath = resolve(
  root,
  "src-tauri/src/pi_memory_runtime/store.rs",
);
const memoryStoreSearchIndexPath = resolve(
  root,
  "src-tauri/src/pi_memory_runtime/store/search_index.rs",
);
const browserRuntimePath = resolve(root, "src-tauri/src/pi_browser_runtime.rs");
const browserPolicyPath = resolve(
  root,
  "src-tauri/src/pi_browser_runtime/browser_policy.rs",
);
const browserPageToolsPath = resolve(
  root,
  "src-tauri/src/pi_browser_runtime/page_tools.rs",
);
const browserScreenshotPath = resolve(
  root,
  "src-tauri/src/pi_browser_runtime/screenshot.rs",
);
const browserSessionLifecyclePath = resolve(
  root,
  "src-tauri/src/pi_browser_runtime/session_lifecycle.rs",
);
const mcpRuntimePath = resolve(root, "src-tauri/src/pi_mcp_runtime.rs");
const mcpConfigPath = resolve(
  root,
  "src-tauri/src/pi_mcp_runtime/mcp_config.rs",
);
const mcpStdioTransportPath = resolve(
  root,
  "src-tauri/src/pi_mcp_runtime/stdio_transport.rs",
);
const mcpRemoteTransportPath = resolve(
  root,
  "src-tauri/src/pi_mcp_runtime/remote_transport.rs",
);
const lspRuntimePath = resolve(root, "src-tauri/src/pi_lsp_runtime.rs");
const lspConfigPath = resolve(root, "src-tauri/src/pi_lsp_config.rs");
const lspProjectionPath = resolve(root, "src-tauri/src/pi_lsp_projection.rs");
const codebaseRuntimePath = resolve(
  root,
  "src-tauri/src/pi_codebase_runtime.rs",
);
const codebaseParserPath = resolve(
  root,
  "src-tauri/src/pi_codebase_runtime/parser.rs",
);
const codebaseRequestPath = resolve(
  root,
  "src-tauri/src/pi_codebase_runtime/request.rs",
);
const codebaseIndexPath = resolve(
  root,
  "src-tauri/src/pi_codebase_runtime/index.rs",
);
const hookRuntimePath = resolve(root, "src-tauri/src/pi_hook_runtime.rs");
const hookConfigPath = resolve(
  root,
  "src-tauri/src/pi_hook_runtime/hook_config.rs",
);
const hookExecutionPath = resolve(
  root,
  "src-tauri/src/pi_hook_runtime/hook_execution.rs",
);
const configPluginDetailsPath = resolve(
  root,
  "src-tauri/src/config_plugin_details.rs",
);
const configSubagentsPath = resolve(root, "src-tauri/src/config_subagents.rs");
const subagentMarkdownPath = resolve(
  root,
  "src-tauri/src/config_subagent_markdown.rs",
);
const workerPolicyPath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-policy.ts",
);
const workerPolicyNormalizationPath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-policy-normalization.ts",
);

let adapter = "";
let sessionResourceLoader = "";
let sessionResourceRefresh = "";
let sessionOpenRuntime = "";
let resourceDiscovery = "";
let skillDiscovery = "";
let promptDiscovery = "";
let resourcePolicy = "";
let modelPolicy = "";
let modelCatalogRuntime = "";
let subagentRecords = "";
let subagentSessionBoundaries = "";
let subagentRuntime = "";
let todoExtension = "";
let goalExtension = "";
let goalState = "";
let goalGuards = "";
let importModule = "";
let modesModule = "";
let toolGateway = "";
let requestPolicy = "";
let workspaceTools = "";
let terminalTasks = "";
let toolOutputArchive = "";
let monitorTools = "";
let schedulerTools = "";
let workerToolGateway = "";
let workerToolGatewayEntry = "";
let workerToolNames = "";
let workerToolAccessPolicy = "";
let workerToolSchemas = "";
let workerToolRequestLifecycle = "";
let workerToolPermission = "";
let workerTaskTools = "";
let configExtensions = "";
let configExtensionsWiring = "";
let configPiPolicy = "";
let configPiResources = "";
let configPromptResources = "";
let configPluginCatalog = "";
let configRuntime = "";
let workerRuntime = "";
let webRuntime = "";
let workerMemoryLifecycle = "";
let workerProtocol = "";
let workerSessionCommands = "";
let workerEventAcceptance = "";
let workerEventPipeline = "";
let workerEnvrc = "";
let workerLaunch = "";
let workerToolRouting = "";
let memoryRuntime = "";
let memoryStoreRuntime = "";
let memoryStoreSearchIndex = "";
let browserRuntime = "";
let browserPolicy = "";
let browserPageTools = "";
let browserScreenshot = "";
let browserSessionLifecycle = "";
let lspRuntime = "";
let lspConfig = "";
let lspProjection = "";
let codebaseRuntime = "";
let codebaseParser = "";
let codebaseRequest = "";
let codebaseIndex = "";
let hookRuntime = "";
let hookConfig = "";
let hookExecution = "";
let mcpRuntime = "";
let mcpConfig = "";
let mcpStdioTransport = "";
let mcpRemoteTransport = "";
let configPluginDetails = "";
let configSubagents = "";
let subagentMarkdown = "";
let workerPolicy = "";
let workerPolicyNormalization = "";
try {
  adapter = readFileSync(adapterPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-adapter.ts: ${error.message}`,
  );
}
try {
  sessionResourceLoader = readFileSync(sessionResourceLoaderPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-resource-loader.ts: ${error.message}`,
  );
}
try {
  sessionResourceRefresh = readFileSync(sessionResourceRefreshPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-resource-refresh-runtime.ts: ${error.message}`,
  );
}
try {
  sessionOpenRuntime = readFileSync(sessionOpenRuntimePath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-open-runtime.ts: ${error.message}`,
  );
}
try {
  resourceDiscovery = readFileSync(resourceDiscoveryPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/resource-discovery.ts: ${error.message}`,
  );
}
try {
  skillDiscovery = readFileSync(skillDiscoveryPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/skill-discovery.ts: ${error.message}`,
  );
}
try {
  promptDiscovery = readFileSync(promptDiscoveryPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/prompt-discovery.ts: ${error.message}`,
  );
}
try {
  resourcePolicy = readFileSync(resourcePolicyPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/resource-policy-snapshot.ts: ${error.message}`,
  );
}
try {
  modelPolicy = readFileSync(modelPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/model-policy.ts: ${error.message}`,
  );
}
try {
  modelCatalogRuntime = readFileSync(modelCatalogRuntimePath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/model-catalog-runtime.ts: ${error.message}`,
  );
}
try {
  subagentRecords = readFileSync(subagentRecordsPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/subagent-records.ts: ${error.message}`,
  );
}
try {
  subagentSessionBoundaries = readFileSync(
    subagentSessionBoundariesPath,
    "utf8",
  );
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/subagent-session-boundaries.ts: ${error.message}`,
  );
}
try {
  subagentRuntime = readFileSync(subagentRuntimePath, "utf8");
} catch (error) {
  failures.push(
    "packages/agent-worker/src/pi/subagent-runtime.ts: " + error.message,
  );
}
if (
  !adapter.includes('from "./session-resource-loader.ts"') ||
  !sessionResourceLoader.includes('from "./resource-discovery.ts"') ||
  !sessionResourceLoader.includes('from "./skill-discovery.ts"') ||
  !sessionResourceLoader.includes('from "./prompt-discovery.ts"') ||
  !sessionResourceLoader.includes("new pi.DefaultResourceLoader") ||
  !sessionResourceLoader.includes("additionalSkillPaths") ||
  !sessionResourceLoader.includes("additionalPromptTemplatePaths")
) {
  failures.push(
    "Pi session resource-loader owner is not wired to the resource-root, Skill, and prompt discovery owners.",
  );
}
if (
  !adapter.includes('from "./resource-policy-snapshot.ts"') ||
  !adapter.includes('from "./session-resource-refresh-runtime.ts"') ||
  !adapter.includes("new PiSessionResourceRefreshRuntime") ||
  !adapter.includes(
    "this.sessionResourceRefresh.refresh(command, requestId)",
  ) ||
  !adapter.includes("parsePiRuntimePolicyEnvironment(process.env)") ||
  !sessionResourceRefresh.includes('from "./resource-policy-snapshot.ts"') ||
  !sessionResourceRefresh.includes("normalizePiResourcePolicySnapshot(") ||
  !sessionResourceRefresh.includes("applyPolicySnapshot(normalizedManifest)") ||
  !sessionResourceLoader.includes('from "./resource-policy-snapshot.ts"') ||
  !sessionResourceLoader.includes("normalizePiResourcePolicySnapshot(") ||
  !sessionResourceLoader.includes("applyPolicySnapshot(normalized)") ||
  !resourcePolicy.includes("export const normalizePiResourcePolicySnapshot") ||
  !resourcePolicy.includes("export const parsePiRuntimePolicyEnvironment")
) {
  failures.push(
    "Pi session adapter is not wired to the resource/policy snapshot owner.",
  );
}
const normalizedRootArguments =
  resourcePolicy.match(/normalizePiResourceRoots\(([\s\S]*?)\n\s*\);/u)?.[1] ??
  "";
if (
  !normalizedRootArguments.includes("environment") ||
  !resourceDiscovery.includes(
    "environment: PiResourceRootEnvironment = process.env",
  ) ||
  !resourceDiscovery.includes("skillRootsFor(cwd, pluginRoots, environment)") ||
  !resourceDiscovery.includes("promptRootsFor(cwd, pluginRoots, environment)")
) {
  failures.push(
    "Pi resource roots are not validated with the explicit policy environment snapshot.",
  );
}
if (
  !adapter.includes('from "./session-open-runtime.ts"') ||
  !adapter.includes("new PiSessionOpenRuntime") ||
  !adapter.includes("this.sessionOpen.open(command, requestId, emitLifecycle)")
) {
  failures.push("Pi session adapter is not wired to the session-open owner.");
}
if (
  !sessionOpenRuntime.includes('from "./model-policy.ts"') ||
  !sessionOpenRuntime.includes("applyModelPolicyOverrides(")
) {
  failures.push(
    "Pi session open owner is not wired to the model-policy module.",
  );
}
if (!adapter.includes('from "./model-catalog-runtime.ts"')) {
  failures.push(
    "Pi session adapter is not wired to the model-catalog runtime owner.",
  );
}
for (const marker of [
  "ModelRuntime.create(",
  "mapPiModelCatalog(",
  "MELODY_PI_MODEL_",
  "catalogRevision",
  "enqueueCatalog(",
]) {
  if (!modelCatalogRuntime.includes(marker)) {
    failures.push(`Pi model catalog runtime owner is missing ${marker}.`);
  }
}
if (
  adapter.includes("ModelRuntime.create(") ||
  adapter.includes("mapPiModelCatalog(")
) {
  failures.push(
    "Pi model runtime/catalog logic must remain owned by model-catalog-runtime.ts.",
  );
}
if (!subagentRuntime.includes('from "./subagent-records.ts"')) {
  failures.push(
    "Pi subagent runtime is not wired to the subagent-records module.",
  );
}
if (!adapter.includes('from "./subagent-session-boundaries.ts"')) {
  failures.push(
    "Pi session adapter is not wired to the subagent session-boundaries module.",
  );
}
for (const marker of [
  "normalizePiResumeFrom",
  "normalizePiSubagentCwd",
  "assertPiResumeTarget",
  "assertPiResumeScope",
  "assertPiResumeIdentity",
  "parsePiWorktreeResponse",
]) {
  if (!subagentSessionBoundaries.includes(marker)) {
    failures.push(`Pi subagent session-boundaries owner is missing ${marker}.`);
  }
}
for (const marker of [
  "PI_SUBAGENT_RECORD_DIRECTORY",
  "MAX_PERSISTED_MCP_TOOLS",
  "PI_MCP_TOOL_PATTERN",
  "parsePersistedPiSubagentRecord",
  "loadPiSubagentRecord",
  "savePiSubagentRecord",
  "isPiSubagentType",
  "isPiThinkingLevel",
]) {
  if (!subagentRecords.includes(marker)) {
    failures.push(`Pi subagent record owner is missing ${marker}.`);
  }
}
try {
  todoExtension = readFileSync(todoExtensionPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/todo-extension.ts: ${error.message}`,
  );
}
try {
  goalExtension = readFileSync(goalExtensionPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/goal-extension.ts: ${error.message}`,
  );
}
try {
  goalState = readFileSync(goalStatePath, "utf8");
} catch (error) {
  failures.push(`packages/agent-worker/src/pi/goal-state.ts: ${error.message}`);
}
try {
  goalGuards = readFileSync(goalGuardsPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/goal-guards.ts: ${error.message}`,
  );
}
try {
  importModule = readFileSync(importPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-import.ts: ${error.message}`,
  );
}
try {
  modesModule = readFileSync(modesPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-contract/src/session-modes.ts: ${error.message}`,
  );
}
try {
  toolGateway = readFileSync(toolGatewayPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_tool_gateway.rs: ${error.message}`);
}
try {
  requestPolicy = readFileSync(requestPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_tool_gateway/request_policy.rs: ${error.message}`,
  );
}
try {
  workspaceTools = readFileSync(workspaceToolsPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_tool_gateway/workspace_tools.rs: ${error.message}`,
  );
}
try {
  terminalTasks = readFileSync(terminalTasksPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_tool_gateway/terminal_tasks.rs: ${error.message}`,
  );
}
try {
  toolOutputArchive = readFileSync(toolOutputArchivePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_tool_output_archive.rs: ${error.message}`);
}
try {
  monitorTools = readFileSync(monitorToolsPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_tool_gateway/monitor_tools.rs: ${error.message}`,
  );
}
try {
  schedulerTools = readFileSync(schedulerToolsPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_tool_gateway/scheduler_tools.rs: ${error.message}`,
  );
}
if (!toolGateway.includes("mod workspace_tools;")) {
  failures.push("Host ToolGateway is not wired to its workspace-tools module.");
}
if (!toolGateway.includes("mod request_policy;")) {
  failures.push("Host ToolGateway is not wired to its request-policy module.");
}
if (!toolGateway.includes("mod terminal_tasks;")) {
  failures.push("Host ToolGateway is not wired to its terminal-tasks module.");
}
if (
  !toolGateway.includes("mod monitor_tools;") ||
  !toolGateway.includes("mod scheduler_tools;")
) {
  failures.push(
    "Host ToolGateway is not wired to monitor/scheduler tool modules.",
  );
}
if (
  !terminalTasks.includes("struct BackgroundTerminalTask") ||
  !terminalTasks.includes("collect_terminal_output_controlled") ||
  !terminalTasks.includes("pub(super) fn run_terminal_with_policy") ||
  !toolGateway.includes("terminal_tasks::resolve_control")
) {
  failures.push(
    "Host ToolGateway is not wired to the terminal process/task lifecycle owner.",
  );
}
if (
  !monitorTools.includes("pub(super) fn start_monitor_tool") ||
  !monitorTools.includes("pub(super) fn resolve_monitor_task_control") ||
  !schedulerTools.includes("pub(super) fn scheduler_tool") ||
  !toolGateway.includes("monitor_tools::start_monitor_tool") ||
  !toolGateway.includes("scheduler_tools::scheduler_tool")
) {
  failures.push(
    "Host ToolGateway is not wired to monitor/scheduler tool owners.",
  );
}
try {
  workerToolGatewayEntry = readFileSync(workerToolGatewayPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-gateway.ts: ${error.message}`,
  );
}
try {
  workerToolNames = readFileSync(workerToolNamesPath, "utf8");
} catch (error) {
  failures.push(`packages/agent-worker/src/pi/tool-names.ts: ${error.message}`);
}
try {
  workerToolAccessPolicy = readFileSync(workerToolAccessPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-access-policy.ts: ${error.message}`,
  );
}
try {
  workerToolSchemas = readFileSync(workerToolSchemasPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-schemas.ts: ${error.message}`,
  );
}
try {
  workerToolRequestLifecycle = readFileSync(
    workerToolRequestLifecyclePath,
    "utf8",
  );
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-request-lifecycle.ts: ${error.message}`,
  );
}
try {
  workerToolPermission = readFileSync(workerToolPermissionPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-permission.ts: ${error.message}`,
  );
}
try {
  workerTaskTools = readFileSync(workerTaskToolsPath, "utf8");
} catch (error) {
  failures.push(`packages/agent-worker/src/pi/task-tools.ts: ${error.message}`);
}
if (
  !workerToolGatewayEntry.includes('export * from "./tool-names.ts"') ||
  !workerToolGatewayEntry.includes('from "./tool-access-policy.ts"') ||
  !workerToolGatewayEntry.includes(
    'from "./subagent-policy-normalization.ts"',
  ) ||
  !workerToolGatewayEntry.includes('from "./tool-schemas.ts"') ||
  !workerToolGatewayEntry.includes('from "./tool-request-lifecycle.ts"') ||
  !workerToolGatewayEntry.includes('from "./tool-permission.ts"') ||
  !workerToolGatewayEntry.includes('from "./task-tools.ts"') ||
  !workerToolGatewayEntry.includes('from "./tool-results.ts"') ||
  !workerToolGatewayEntry.includes("new PiToolRequestLifecycle(emit)")
) {
  failures.push(
    "Pi ToolGateway 没有接入稳定工具名、访问策略、schema 与 request-lifecycle 模块。",
  );
}
if (
  !workerToolGatewayEntry.includes('from "./tool-errors.ts"') ||
  !workerToolRequestLifecycle.includes('from "./tool-errors.ts"')
) {
  failures.push(
    "Pi worker gateway 与 request lifecycle 没有共享规范错误构造器。",
  );
}
for (const marker of [
  "public async request(",
  "public async requestInteraction(",
  "public resolve(",
  "public resolveInteraction(",
  "public rejectAll(",
  'type: "tool.requested"',
  'type: "tool.finished"',
  'type: "interaction.requested"',
  'type: "interaction.resolved"',
]) {
  if (!workerToolRequestLifecycle.includes(marker)) {
    failures.push(`Pi request-lifecycle module is missing ${marker}.`);
  }
}
for (const marker of [
  "export const createSubagentTools",
  "export const createTaskControlTools",
  "export interface PiTaskController",
  "name: PI_TASK,",
  "name: PI_GET_TASK_OUTPUT,",
  "name: PI_WAIT_TASKS,",
  "name: PI_KILL_TASK,",
]) {
  if (!workerTaskTools.includes(marker)) {
    failures.push(`Pi worker task-tools module is missing ${marker}.`);
  }
}
for (const marker of [
  "export const isAllowedPermissionOutcome",
  "export const permissionRawInput",
  "PI_WORKSPACE_WRITE_FILE",
  "PI_BROWSER_NAVIGATE",
]) {
  if (!workerToolPermission.includes(marker)) {
    failures.push(`Pi worker permission-contract module is missing ${marker}.`);
  }
}
for (const marker of [
  "export const intersectPiSubagentCapabilityModes",
  "export const subagentCapabilityAllowsTool",
  "export const sessionModeAllowsTool",
]) {
  if (!workerToolAccessPolicy.includes(marker)) {
    failures.push(`Pi worker access-policy module is missing ${marker}.`);
  }
}
// Keep contract checks pointed at the ownership modules after the gateway
// stops declaring these protocol names inline.
workerToolGateway = [
  workerToolGatewayEntry,
  workerToolNames,
  workerToolSchemas,
  workerToolRequestLifecycle,
  workerToolPermission,
  workerTaskTools,
].join("\n");
try {
  configExtensions = readFileSync(configExtensionsPath, "utf8");
  configExtensionsWiring = configExtensions;
} catch (error) {
  failures.push(`src-tauri/src/config_extensions.rs: ${error.message}`);
}
try {
  configPiPolicy = readFileSync(configPiPolicyPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_pi_policy.rs: ${error.message}`);
}
try {
  configPiResources = readFileSync(configPiResourcesPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_pi_resources.rs: ${error.message}`);
}
try {
  configPromptResources = readFileSync(configPromptResourcesPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_prompt_resources.rs: ${error.message}`);
}
try {
  configPluginCatalog = readFileSync(configPluginCatalogPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_plugin_catalog.rs: ${error.message}`);
}
try {
  configRuntime = readFileSync(configRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_runtime.rs: ${error.message}`);
}
if (manifest?.hostBridges?.webTools) {
  try {
    webRuntime = readFileSync(webRuntimePath, "utf8");
  } catch (error) {
    failures.push(`src-tauri/src/pi_web_runtime.rs: ${error.message}`);
  }
}
if (
  !configExtensions.includes('#[path = "config_pi_policy.rs"]') ||
  !configExtensions.includes("mod pi_runtime_policy;") ||
  !configExtensions.includes("pi_terminal_policy") ||
  !configPiPolicy.includes("pub(crate) fn pi_terminal_policy") ||
  !configPiPolicy.includes("pub(crate) fn pi_question_timeout_policy") ||
  !configPiPolicy.includes("pub(crate) fn pi_goal_policy")
) {
  failures.push(
    "Host Pi runtime-policy projections are not owned by config_pi_policy.rs or wired through config_extensions.rs.",
  );
}
if (
  !configExtensions.includes('#[path = "config_pi_resources.rs"]') ||
  !configExtensions.includes('#[path = "config_prompt_resources.rs"]') ||
  !configExtensions.includes("mod pi_resources;") ||
  !configExtensions.includes("mod prompt_resources;") ||
  !configExtensions.includes(
    "pub(crate) use self::prompt_resources::pi_prompt_paths",
  ) ||
  !configExtensions.includes("pi_resource_manifest_parts") ||
  !configPiResources.includes("pub(crate) fn pi_resource_manifest_parts") ||
  !configRuntime.includes("pub(crate) fn pi_resource_manifest") ||
  !configRuntime.includes(
    "config_subagents::pi_subagent_policy_manifest(cwd)?",
  ) ||
  configPiResources.includes("config_subagents::") ||
  !configPiResources.includes("scan_pi_skill_root_by_status") ||
  !configPiResources.includes(
    "super::prompt_resources::pi_prompt_scan_roots",
  ) ||
  configPiResources.includes("pub(crate) fn scan_pi_prompt_root") ||
  !configPromptResources.includes("pub(crate) fn scan_pi_prompt_root") ||
  !configPromptResources.includes("pub(crate) fn pi_prompt_paths") ||
  !configPromptResources.includes("pub(crate) fn pi_prompt_scan_roots")
) {
  failures.push(
    "Host Pi resource discovery or subagent manifest composition is not owned by its focused module and runtime facade.",
  );
}
if (
  !configExtensions.includes('#[path = "config_plugin_catalog.rs"]') ||
  !configExtensions.includes("mod plugin_catalog;") ||
  !configExtensions.includes("PluginEnablement") ||
  !configExtensions.includes("pi_plugin_resources") ||
  !configPluginCatalog.includes("pub(crate) struct PluginEnablement") ||
  !configPluginCatalog.includes("pub(crate) fn pi_plugin_resources")
) {
  failures.push(
    "Host plugin catalog discovery and enablement are not owned by config_plugin_catalog.rs or wired through config_extensions.rs.",
  );
}
configExtensions = [configExtensions, configPiPolicy].join("\n");
try {
  workerRuntime = readFileSync(workerRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_worker_runtime.rs: ${error.message}`);
}
try {
  workerMemoryLifecycle = readFileSync(workerMemoryLifecyclePath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/memory_lifecycle.rs: ${error.message}`,
  );
}
try {
  workerProtocol = readFileSync(workerProtocolPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/protocol.rs: ${error.message}`,
  );
}
try {
  workerSessionCommands = readFileSync(workerSessionCommandsPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/session_commands.rs: ${error.message}`,
  );
}
try {
  workerEventAcceptance = readFileSync(workerEventAcceptancePath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/event_acceptance.rs: ${error.message}`,
  );
}
try {
  workerEventPipeline = readFileSync(workerEventPipelinePath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/event_pipeline.rs: ${error.message}`,
  );
}
try {
  workerEnvrc = readFileSync(workerEnvrcPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_worker_runtime/envrc.rs: ${error.message}`);
}
try {
  workerLaunch = readFileSync(workerLaunchPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_worker_runtime/launch.rs: ${error.message}`);
}
try {
  workerToolRouting = readFileSync(workerToolRoutingPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_worker_runtime/host_tool_routing.rs: ${error.message}`,
  );
}
try {
  memoryRuntime = readFileSync(memoryRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_memory_runtime.rs: ${error.message}`);
}
try {
  memoryStoreRuntime = readFileSync(memoryStorePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_memory_runtime/store.rs: ${error.message}`);
}
try {
  memoryStoreSearchIndex = readFileSync(memoryStoreSearchIndexPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_memory_runtime/store/search_index.rs: ${error.message}`,
  );
}
try {
  browserRuntime = readFileSync(browserRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_browser_runtime.rs: ${error.message}`);
}
try {
  browserPolicy = readFileSync(browserPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_browser_runtime/browser_policy.rs: ${error.message}`,
  );
}
try {
  browserPageTools = readFileSync(browserPageToolsPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_browser_runtime/page_tools.rs: ${error.message}`,
  );
}
try {
  browserScreenshot = readFileSync(browserScreenshotPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_browser_runtime/screenshot.rs: ${error.message}`,
  );
}
try {
  browserSessionLifecycle = readFileSync(browserSessionLifecyclePath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_browser_runtime/session_lifecycle.rs: ${error.message}`,
  );
}
try {
  lspRuntime = readFileSync(lspRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_lsp_runtime.rs: ${error.message}`);
}
try {
  lspConfig = readFileSync(lspConfigPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_lsp_config.rs: ${error.message}`);
}
try {
  lspProjection = readFileSync(lspProjectionPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_lsp_projection.rs: ${error.message}`);
}
try {
  codebaseRuntime = readFileSync(codebaseRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_codebase_runtime.rs: ${error.message}`);
}
try {
  codebaseParser = readFileSync(codebaseParserPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_codebase_runtime/parser.rs: ${error.message}`,
  );
}
try {
  codebaseRequest = readFileSync(codebaseRequestPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_codebase_runtime/request.rs: ${error.message}`,
  );
}
try {
  codebaseIndex = readFileSync(codebaseIndexPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_codebase_runtime/index.rs: ${error.message}`);
}
try {
  hookRuntime = readFileSync(hookRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_hook_runtime.rs: ${error.message}`);
}
try {
  hookConfig = readFileSync(hookConfigPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_hook_runtime/hook_config.rs: ${error.message}`,
  );
}
try {
  hookExecution = readFileSync(hookExecutionPath, "utf8");
} catch (error) {
  failures.push(
    `src-tauri/src/pi_hook_runtime/hook_execution.rs: ${error.message}`,
  );
}
try {
  configPluginDetails = readFileSync(configPluginDetailsPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_plugin_details.rs: ${error.message}`);
}
try {
  configSubagents = readFileSync(configSubagentsPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_subagents.rs: ${error.message}`);
}
try {
  subagentMarkdown = readFileSync(subagentMarkdownPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_subagent_markdown.rs: ${error.message}`);
}
try {
  workerPolicyNormalization = readFileSync(
    workerPolicyNormalizationPath,
    "utf8",
  );
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/subagent-policy-normalization.ts: ${error.message}`,
  );
}
try {
  workerPolicy = readFileSync(workerPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/subagent-policy.ts: ${error.message}`,
  );
}
for (const marker of [
  "export const defaultPiSubagentCapabilityMode",
  "export const intersectPiPermissionModes",
  "defaultPiSubagentCapabilityMode(type)",
  "export const resolvePiSubagentPolicy",
  "export const resolvePiSubagentLaunchPolicy",
  "export const composePiSubagentPrompt",
]) {
  if (!workerPolicy.includes(marker)) {
    failures.push(`Pi subagent policy owner is missing ${marker}.`);
  }
}
for (const marker of [
  "export const normalizePiSubagentType",
  "export const normalizePiSubagentIsolation",
  "export const normalizePiSubagentCapabilityMode",
  "export const normalizePiSubagentPolicyManifest",
  "export const emptyPiSubagentPolicyManifest",
]) {
  if (!workerPolicyNormalization.includes(marker)) {
    failures.push(`Pi subagent normalization owner is missing ${marker}.`);
  }
}
if (
  !workerPolicy.includes('from "./subagent-policy-normalization.ts"') ||
  !workerPolicy.includes("normalizePiSubagentPolicyManifest") ||
  !workerPolicy.includes("createPiSubagentPolicyError as policyError") ||
  !workerPolicy.includes("export {\n  emptyPiSubagentPolicyManifest")
) {
  failures.push(
    "Pi subagent policy owner is not wired through the bounded normalization module.",
  );
}
if (
  !subagentRuntime.includes("resolvePiSubagentLaunchPolicy") ||
  adapter.includes("resolvePiSubagentLaunchPolicy") ||
  adapter.includes("defaultPiSubagentCapabilityMode") ||
  adapter.includes("intersectPiPermissionModes") ||
  adapter.includes("const permissionModeRank")
) {
  failures.push(
    "Pi subagent launch policy is not delegated to the subagent-policy owner.",
  );
}

for (const marker of [
  "fn validate_url",
  "fn validate_local_preview_url",
  "fn browser_url_is_allowed_for_snapshot",
  "fn is_allowed_popup_url",
]) {
  if (!browserPolicy.includes(marker)) {
    failures.push(`Pi Browser URL policy module is missing ${marker}.`);
  }
}
if (
  !browserRuntime.includes(
    '#[path = "pi_browser_runtime/browser_policy.rs"]',
  ) ||
  !browserRuntime.includes("validate_url") ||
  !browserRuntime.includes('#[path = "pi_browser_runtime/page_tools.rs"]') ||
  !browserRuntime.includes('#[path = "pi_browser_runtime/screenshot.rs"]') ||
  !browserPageTools.includes(
    "use super::browser_policy::browser_url_is_allowed_for_snapshot;",
  ) ||
  !browserPageTools.includes(
    "browser_url_is_allowed_for_snapshot(&snapshot.url, local_origin)",
  ) ||
  !browserScreenshot.includes(
    "use super::browser_policy::browser_url_is_allowed_for_snapshot;",
  ) ||
  !browserScreenshot.includes(
    "browser_url_is_allowed_for_snapshot(url.as_str(), local_origin.as_deref())",
  )
) {
  failures.push("Pi Browser runtime is not wired to its URL policy module.");
}

for (const marker of [
  "pub(super) trait BrowserTabAdapter",
  "pub(super) struct BrowserSessionLifecycle<Entry>",
  "pub(super) fn open<Adapter>",
  "pub(super) fn ensure_active_entry<Adapter>",
  "pub(super) fn select<Adapter>",
  "pub(super) fn close<Adapter>",
]) {
  if (!browserSessionLifecycle.includes(marker)) {
    failures.push(`Pi Browser session lifecycle module is missing ${marker}.`);
  }
}
if (
  !browserRuntime.includes(
    '#[path = "pi_browser_runtime/session_lifecycle.rs"]',
  ) ||
  !browserRuntime.includes(
    "impl BrowserTabAdapter<BrowserEntry> for TauriBrowserTabAdapter",
  ) ||
  !browserRuntime.includes("session.open(") ||
  !browserRuntime.includes("session.select(tab_id") ||
  !browserRuntime.includes("session.close(tab_id")
) {
  failures.push(
    "Pi Browser runtime is not wired through the shared session lifecycle and Tauri adapter.",
  );
}

for (const marker of [
  "AGENT_PROTOCOL_VERSION",
  "MAX_FRAME_BYTES",
  "fn validate_command_session_identity",
  "fn encode_command",
  "fn read_frame",
]) {
  if (!workerProtocol.includes(marker)) {
    failures.push(`Pi worker protocol module is missing ${marker}.`);
  }
}
if (
  !workerRuntime.includes("mod protocol;") ||
  !workerRuntime.includes("self::protocol") ||
  !workerRuntime.includes("encode_command") ||
  !workerRuntime.includes("read_frame")
) {
  failures.push("Pi worker supervisor is not wired to its protocol module.");
}
for (const marker of [
  "trait WorkerWorkspace",
  "impl WorkerWorkspace for PiWorkerRuntime",
  "SESSION_BOUND_PI_COMMANDS",
  "fn prepare_session_command",
  "fn authorize_for_worker",
  "async fn preflight",
  "workspace_for_generation",
  "begin_pi_session_fork",
  "validate_pi_session_open",
  "validate_pi_session_import",
  "validate_pi_session_command",
  "validate_pi_migration_import",
]) {
  if (!workerSessionCommands.includes(marker)) {
    failures.push(`Pi worker session-command module is missing ${marker}.`);
  }
}
if (
  !workerRuntime.includes("mod session_commands;") ||
  !workerRuntime.includes("session_commands::preflight(") ||
  workerRuntime.includes("SESSION_BOUND_PI_COMMANDS")
) {
  failures.push(
    "Pi worker command handling must delegate Host session preflight to its owner module.",
  );
}
for (const marker of [
  "MAX_SEEN_EVENT_IDS: usize = 4096",
  "struct PiWorkerEventAcceptance",
  "fn accept(&mut self, value: &Value)",
  "fn validate_event_metadata",
  "fn is_sequence_violation",
  "seen_events",
  "worker_epoch",
  "last_seq",
]) {
  if (!workerEventAcceptance.includes(marker)) {
    failures.push(`Pi worker event-acceptance module is missing ${marker}.`);
  }
}
if (
  !workerRuntime.includes("mod event_pipeline;") ||
  !workerRuntime.includes("event_pipeline::process_stdout_event(") ||
  !workerEventPipeline.includes(
    "process_with_port(&port, value, worker_cwd).await",
  ) ||
  !workerEventPipeline.includes(
    "self.runtime.accept_event(self.generation, value)",
  ) ||
  !workerEventPipeline.includes("PiEventPersistence::Duplicate")
) {
  failures.push(
    "Pi worker supervisor is not wired to event acceptance and SQLite duplicate arbitration.",
  );
}
for (const marker of [
  "fn parse_envrc_json",
  "async fn load_envrc",
  "ENVRC_MAX_OUTPUT_BYTES",
  "ENVRC_MAX_VALUE_BYTES",
  ".envrc",
]) {
  if (!workerEnvrc.includes(marker)) {
    failures.push(`Pi worker envrc module is missing ${marker}.`);
  }
}
if (
  !workerRuntime.includes("mod envrc;") ||
  !workerRuntime.includes("self::envrc::load_envrc") ||
  !workerRuntime.includes("INHERITED_WORKER_ENV).await")
) {
  failures.push(
    "Pi worker supervisor is not wired to its bounded envrc module.",
  );
}
for (const marker of [
  "INHERITED_WORKER_ENV",
  "MELODY_PI_WORKER_PATH",
  "fn worker_executable_names",
  "fn runtime_target_triples",
  "fn resolve_worker_binary",
  "fn configure_worker_command",
  ".env_clear()",
]) {
  if (!workerLaunch.includes(marker)) {
    failures.push(`Pi worker launch module is missing ${marker}.`);
  }
}
if (
  !workerRuntime.includes("mod launch;") ||
  !workerRuntime.includes("launch::resolve_worker_binary(app)") ||
  !workerRuntime.includes("launch::configure_worker_command(") ||
  !workerRuntime.includes("launch::INHERITED_WORKER_ENV")
) {
  failures.push("Pi worker supervisor is not wired to its launch module.");
}

if (manifest && workerPackage) {
  const packages = manifest.pi?.npmPackages ?? {};
  for (const [packageName, version] of Object.entries(packages)) {
    if (workerPackage.dependencies?.[packageName] !== version) {
      failures.push(
        `${packageName} 依赖版本漂移：清单要求 ${version}，实际为 ${workerPackage.dependencies?.[packageName] ?? "未声明"}。`,
      );
    }
  }

  const piVersion = manifest.pi?.version;
  if (!adapter.includes(`engineVersion: "${piVersion}"`)) {
    failures.push(`worker 能力声明没有同步 Pi 版本 ${piVersion}。`);
  }
  if (adapter.includes('engineVersion: "') && !piVersion) {
    failures.push("Pi 兼容清单缺少 pi.version。");
  }
  if (!adapter.includes(`protocolVersion: ${manifest.pi?.protocolVersion}`)) {
    failures.push(
      `worker 能力声明没有同步协议版本 ${manifest.pi?.protocolVersion}。`,
    );
  }
  if (!adapter.includes(`engine: "${manifest.worker?.engine}"`)) {
    failures.push(`worker 能力声明没有同步引擎 ${manifest.worker?.engine}。`);
  }

  for (const tool of manifest.worker?.tools ?? []) {
    if (
      !adapter.includes(`"${tool}"`) &&
      !todoExtension.includes(`"${tool}"`) &&
      !goalExtension.includes(`"${tool}"`) &&
      !workerToolGateway.includes(`"${tool}"`)
    ) {
      failures.push(`worker 能力声明缺少工具 ${tool}。`);
    }
  }
  // The strongest form of this check: import the worker's actual capability
  // object and compare the announced tool set with the manifest. Source-text
  // matching cannot tell a registered tool from a mentioned string, and an
  // announcement that silently omits a tool is exactly the drift that shipped a
  // duplicate tool card with raw arguments for `monitor`/`scheduler_*`.
  const runtimeCapabilities = (() => {
    const probe = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { PI_CAPABILITIES } from ${JSON.stringify(
          `file://${resolve(root, "packages/agent-worker/src/pi/session-adapter.ts")}`,
        )}; process.stdout.write(JSON.stringify({ tools: PI_CAPABILITIES.tools, limitations: PI_CAPABILITIES.limitations, diagnostics: PI_CAPABILITIES.diagnostics }));`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (probe.status !== 0) {
      failures.push(
        `无法读取 worker 运行时能力清单：${(probe.stderr || "").trim().split("\n").at(-1) ?? "unknown error"}`,
      );
      return undefined;
    }
    try {
      return JSON.parse(probe.stdout);
    } catch (error) {
      failures.push(`worker 运行时能力清单不是有效 JSON：${error.message}`);
      return undefined;
    }
  })();
  if (runtimeCapabilities) {
    const announced = new Set(runtimeCapabilities.tools ?? []);
    const declared = new Set(manifest.worker?.tools ?? []);
    for (const tool of declared) {
      if (!announced.has(tool)) {
        failures.push(`worker 运行时没有宣告工具 ${tool}（清单已声明）。`);
      }
    }
    for (const tool of announced) {
      if (!declared.has(tool)) {
        failures.push(`worker 运行时宣告了清单外的工具 ${tool}。`);
      }
    }

    // Rust cannot import the contract table, so compare the Host routing
    // constants against it here. A renamed Host constant used to pass silently.
    const contractToolNames = await import(
      `file://${resolve(root, "packages/agent-contract/src/tool-names.ts")}`
    );
    failures.push(
      ...checkPiToolNamesCompatibility({
        contract: contractToolNames,
        requestPolicy,
        codebaseRuntime,
        lspRuntime,
        manifestTools: manifest.worker?.tools ?? [],
      }),
    );

    if (manifest.worker?.runtimeFallback !== "none") {
      failures.push(
        "Pi 兼容清单必须声明 runtimeFallback=none（Pi 不得回退到 ACP）。",
      );
    }
    const fallbackClaim =
      /(?:回退到|回退|fallback|route(?:d|s)? to)\s*(?:ACP|Legacy|兼容引擎)|(?:ACP|Legacy|兼容引擎)\s*(?:fallback|回退)|ACP-backed/iu;
    for (const [index, limitation] of (
      runtimeCapabilities.limitations ?? []
    ).entries()) {
      if (fallbackClaim.test(limitation)) {
        failures.push(
          `worker limitation #${index + 1} 仍声称运行时可回退到 ACP/兼容引擎。`,
        );
      }
    }
    for (const diagnostic of runtimeCapabilities.diagnostics ?? []) {
      if (diagnostic.fallbackEngine) {
        failures.push(
          `Pi 运行时诊断 ${diagnostic.code} 仍设置 fallbackEngine=${diagnostic.fallbackEngine}。`,
        );
      }
      if (fallbackClaim.test(diagnostic.message ?? "")) {
        failures.push(
          `Pi 运行时诊断 ${diagnostic.code} 仍声称运行时可回退到 ACP/兼容引擎。`,
        );
      }
    }
    const browserLimitation = (runtimeCapabilities.limitations ?? []).find(
      (item) => item.includes("browser_"),
    );
    if (!browserLimitation) {
      failures.push("Pi Browser 能力缺少运行时限制说明。");
    } else if (
      /workspace-embedded rendering.{0,128}unsupported|(?:multiple tabs|screenshots|local preview|popup-based login).{0,48}(?:remain|are) unsupported/iu.test(
        browserLimitation,
      )
    ) {
      failures.push(
        "Pi Browser limitation 把已实现的嵌入视图、多标签、截图、本地预览或弹窗登录误报为不支持。",
      );
    }
    if (
      /(?:legacy-acp|melody-acp|legacy\s+ACP)/iu.test(
        JSON.stringify(manifest.hostBridges ?? {}),
      )
    ) {
      failures.push("Pi Host bridge 清单仍将 ACP 描述为运行时 fallback。");
    }
  }
  // The monitor tool is declared by the worker and executed by the Host
  // gateway; a drift on either side would advertise a tool that cannot run.
  // Name agreement is owned by `pi-tool-names-compatibility.mjs`; this check
  // only proves the Host actually dispatches the tool.
  if ((manifest.worker?.tools ?? []).includes("monitor")) {
    if (!toolGateway.includes("MONITOR => ")) {
      failures.push("monitor 工具没有在 worker 与 Host 之间同步。");
    }
  }
  // Same contract for the schedule tools: the worker declares them, the Host
  // owns the durable store and the per-session identity snapshot.
  const agentSchedules = manifest.hostBridges?.agentSchedules;
  if (agentSchedules) {
    const schedulesSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/database_agent_schedules.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `src-tauri/src/database_agent_schedules.rs: ${error.message}`,
        );
        return "";
      }
    })();
    const schedulePolicySource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/database_agent_schedules/policy.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `src-tauri/src/database_agent_schedules/policy.rs: ${error.message}`,
        );
        return "";
      }
    })();
    failures.push(
      ...checkPiAgentScheduleCompatibility({
        contract: agentSchedules,
        sources: {
          workerToolNames,
          workerToolSchemas,
          hostRequestPolicy: requestPolicy,
          hostToolGateway: toolGateway,
          schedulerTools,
          schedulesStore: schedulesSource,
          schedulePolicy: schedulePolicySource,
        },
      }),
    );
  }

  for (const mode of manifest.worker?.sessionModes ?? []) {
    if (!modesModule.includes(`"${mode}"`)) {
      failures.push(`worker 能力声明缺少会话模式 ${mode}。`);
    }
  }
  for (const media of manifest.worker?.media ?? []) {
    if (!adapter.includes(`"${media}"`)) {
      failures.push(`worker 能力声明缺少媒体能力 ${media}。`);
    }
  }

  const nativeFormat = manifest.pi?.nativeSessionFormat;
  if (!importModule.includes(`version: ${nativeFormat}`)) {
    failures.push(
      `Pi 导入物化格式没有同步 nativeSessionFormat ${nativeFormat}。`,
    );
  }

  const modelPolicySnapshot = manifest.hostBridges?.modelPolicySnapshot;
  if (modelPolicySnapshot) {
    let hostModelConfig = "";
    let hostModelProjection = "";
    let hostModelPolicy = "";
    try {
      hostModelConfig = readFileSync(
        resolve(root, "src-tauri/src/pi_model_config.rs"),
        "utf8",
      );
    } catch (error) {
      failures.push(`src-tauri/src/pi_model_config.rs: ${error.message}`);
    }
    try {
      hostModelProjection = readFileSync(
        resolve(root, "src-tauri/src/pi_model_config/model_projection.rs"),
        "utf8",
      );
    } catch (error) {
      failures.push(
        `src-tauri/src/pi_model_config/model_projection.rs: ${error.message}`,
      );
    }
    try {
      hostModelPolicy = readFileSync(
        resolve(root, "src-tauri/src/pi_model_config/model_policy.rs"),
        "utf8",
      );
    } catch (error) {
      failures.push(
        `src-tauri/src/pi_model_config/model_policy.rs: ${error.message}`,
      );
    }
    failures.push(
      ...checkPiModelPolicyCompatibility({
        contract: modelPolicySnapshot,
        sources: {
          workerModelPolicy: modelPolicy,
          hostModelConfig,
          hostModelProjection,
          hostModelPolicy,
          workerLaunch,
        },
      }),
    );
  }

  failures.push(
    ...checkPiResourceCompatibility({
      promptTemplates: manifest.hostBridges?.promptTemplates,
      skillPaths: manifest.hostBridges?.skillPaths,
      sources: {
        workerResourceRoots: resourceDiscovery,
        workerSkillDiscovery: skillDiscovery,
        workerPromptDiscovery: promptDiscovery,
        hostExtensions: configExtensions,
        hostPiResources: configPiResources,
        hostPromptResources: configPromptResources,
        hostPluginCatalog: configPluginCatalog,
        hostPluginDetails: configPluginDetails,
      },
    }),
  );

  failures.push(
    ...checkPiSubagentPolicyCompatibility({
      policy: manifest.hostBridges?.subagentPolicy,
      sources: {
        hostSubagentParser: subagentMarkdown,
        hostSubagentConfig: configSubagents,
        workerSessionAdapter: adapter + "\n" + subagentRuntime,
        workerPolicy: `${workerPolicyNormalization}\n${workerPolicy}`,
        workerToolGateway,
        workerToolAccessPolicy,
      },
    }),
  );

  const sandbox = manifest.hostBridges?.sandbox;
  if (sandbox) {
    const sandboxSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/workspace_sandbox.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(`src-tauri/src/workspace_sandbox.rs: ${error.message}`);
        return "";
      }
    })();
    const profileOwnerSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/workspace_sandbox/profile.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `src-tauri/src/workspace_sandbox/profile.rs: ${error.message}`,
        );
        return "";
      }
    })();
    const seatbeltOwnerSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/workspace_sandbox/seatbelt.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `src-tauri/src/workspace_sandbox/seatbelt.rs: ${error.message}`,
        );
        return "";
      }
    })();
    const libSource = (() => {
      try {
        return readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
      } catch (error) {
        failures.push(`src-tauri/src/lib.rs: ${error.message}`);
        return "";
      }
    })();
    // Follow the real platform owner through the Host decision seam so a
    // stale parent-level marker cannot pass after the wrapper moves.
    if (
      !sandboxSource.includes("mod seatbelt;") ||
      !sandboxSource.includes("seatbelt::command(&profile)") ||
      !seatbeltOwnerSource.includes(
        'const EXECUTOR: &str = "/usr/bin/sandbox-exec"',
      ) ||
      !seatbeltOwnerSource.includes("Path::new(EXECUTOR).exists()") ||
      !seatbeltOwnerSource.includes("program: PathBuf::from(EXECUTOR)") ||
      !seatbeltOwnerSource.includes("profile_rules(profile)")
    ) {
      failures.push(
        "Host 终端沙箱没有通过 Seatbelt owner 构造并 fail-close macOS 命令。",
      );
    }
    if (
      !sandboxSource.includes("resolve_profile(workspace, requested)") ||
      !profileOwnerSource.includes("fn canonical(")
    ) {
      failures.push(
        "Host 终端沙箱必须通过 profile owner 解析，并在那里 canonicalize 路径。",
      );
    }
    if (!profileOwnerSource.includes('"read-only" | "readonly" | "strict"')) {
      failures.push("Host 终端沙箱没有把网络受限 profile 判为不可执行。");
    }
    if (
      !sandboxSource.includes("pub fn read_workspace_sandbox_plan") ||
      !libSource.includes("read_workspace_sandbox_plan")
    ) {
      failures.push("Host 沙箱预检命令没有定义并注册。");
    }
    void configRuntime;
  }

  const compaction = manifest.hostBridges?.compaction;
  if (compaction) {
    const compactionSource = (() => {
      try {
        return readFileSync(
          resolve(root, "packages/agent-worker/src/pi/compaction-extension.ts"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `packages/agent-worker/src/pi/compaction-extension.ts: ${error.message}`,
        );
        return "";
      }
    })();
    failures.push(
      ...checkPiCompactionCompatibility(compaction, compactionSource),
    );
  }

  const gitignorePolicy = manifest.hostBridges?.gitignorePolicy;
  if (gitignorePolicy) {
    const environmentVariable = gitignorePolicy.environmentVariable;
    if (
      !resourcePolicy.includes(
        `const PI_RESPECT_GITIGNORE_ENV = "${environmentVariable}"`,
      )
    ) {
      failures.push("worker .gitignore 策略环境变量没有同步兼容清单。");
    }
    if (
      gitignorePolicy.manifestField &&
      !adapter.includes(gitignorePolicy.manifestField)
    ) {
      failures.push("worker .gitignore 策略清单字段没有同步。");
    }
    if (
      gitignorePolicy.implementation === "host-tool-gateway" &&
      (!toolGateway.includes("resolve_request_with_policy") ||
        !workspaceTools.includes("gitignore_walk_builder"))
    ) {
      failures.push("Host ToolGateway 没有实现清单声明的 .gitignore 策略。");
    }
    const rustConstants = {
      workspace_read_file: "WORKSPACE_READ_FILE",
      workspace_search: "WORKSPACE_SEARCH",
      workspace_list_directory: "WORKSPACE_LIST_DIRECTORY",
      workspace_edit: "WORKSPACE_EDIT",
      workspace_apply_patch: "WORKSPACE_APPLY_PATCH",
    };
    for (const tool of gitignorePolicy.appliesTo ?? []) {
      const constant = rustConstants[tool];
      if (!constant || !toolGateway.includes(constant)) {
        failures.push(`Host .gitignore 策略缺少工具映射 ${tool}。`);
      }
    }
  }

  failures.push(
    ...checkPiTerminalCompatibility({
      terminalPolicy: manifest.hostBridges?.terminalPolicy,
      backgroundTerminalTasks: manifest.hostBridges?.backgroundTerminalTasks,
      sources: {
        hostToolGateway: toolGateway,
        hostConfig: configPiPolicy,
        hostTerminalTasks: terminalTasks,
        hostToolOutputArchive: toolOutputArchive,
        workerToolSchemas,
        workerToolNames,
        workerRuntime,
      },
    }),
  );

  failures.push(
    ...checkPiQuestionTimeoutCompatibility({
      policy: manifest.hostBridges?.questionTimeoutPolicy,
      sources: {
        hostConfig: configPiPolicy,
        hostConfigExtensions: configExtensionsWiring,
        hostResourceManifest: configRuntime,
        hostWorkerLaunch: workerLaunch,
        workerToolGateway,
        workerSessionAdapter: adapter,
        workerResourceRefresh: sessionResourceRefresh,
        workerResourcePolicy: resourcePolicy,
      },
    }),
  );

  const webTools = manifest.hostBridges?.webTools;
  if (webTools) {
    failures.push(
      ...checkPiWebToolsCompatibility({
        policy: webTools,
        sources: {
          workerToolGateway,
          hostToolGateway: toolGateway,
          hostWebRuntime: webRuntime,
        },
      }),
    );
  }

  const envrcProjection = manifest.hostBridges?.envrcProjection;
  if (envrcProjection) {
    if (!configExtensions.includes("pi_load_envrc")) {
      failures.push("Host 配置层没有实现清单声明的 .envrc 投影开关。");
    }
    for (const marker of [
      "parse_envrc_json",
      "load_envrc",
      "env_clear",
      "direnv",
    ]) {
      if (!workerEnvrc.includes(marker)) {
        failures.push(`Host .envrc 投影缺少边界实现 ${marker}。`);
      }
    }
    if (
      !workerRuntime.includes("mod envrc;") ||
      !workerRuntime.includes("load_envrc(&cwd, launch::INHERITED_WORKER_ENV)")
    ) {
      failures.push("Host worker 启动链路没有接入受限 .envrc loader。");
    }
    if (
      envrcProjection.environmentVariable &&
      !configExtensions.includes(envrcProjection.environmentVariable)
    ) {
      failures.push("Host worker 启动链路没有传递 .envrc 投影环境变量。");
    }
  }

  const remoteModelCatalog = manifest.hostBridges?.remoteModelCatalog;
  if (remoteModelCatalog) {
    const modelConfigPath = resolve(root, "src-tauri/src/pi_model_config.rs");
    const remoteCatalogPath = resolve(
      root,
      "src-tauri/src/pi_remote_model_catalog.rs",
    );
    let modelConfig = "";
    let remoteCatalog = "";
    try {
      modelConfig = readFileSync(modelConfigPath, "utf8");
    } catch (error) {
      failures.push(`src-tauri/src/pi_model_config.rs: ${error.message}`);
    }
    try {
      remoteCatalog = readFileSync(remoteCatalogPath, "utf8");
    } catch (error) {
      failures.push(
        `src-tauri/src/pi_remote_model_catalog.rs: ${error.message}`,
      );
    }
    for (const marker of [
      "prepare_pi_models_with_remote",
      "remote_model_catalog::resolve_remote_catalog",
    ]) {
      if (!modelConfig.includes(marker)) {
        failures.push(`Host model projection is not wired through ${marker}.`);
      }
    }
    for (const marker of [
      "fetch_remote_catalog",
      "load_remote_catalog_cache",
      "GENERATED_REMOTE_CATALOG_FILE",
      "models_list_url",
      "models_base_url",
    ]) {
      if (!remoteCatalog.includes(marker)) {
        failures.push(`Host 远程模型目录 owner 缺少实现 ${marker}。`);
      }
    }
    if (
      !modelConfig.includes("mod remote_model_catalog;") ||
      !remoteCatalog.includes("resolve_remote_catalog")
    ) {
      failures.push(
        "Host model projection has no remote model catalog owner or wiring.",
      );
    }
    if (!workerRuntime.includes("prepare_pi_models_with_remote")) {
      failures.push("Host worker 启动链路没有接入远程模型目录投影。 ");
    }
    for (const variable of remoteModelCatalog.environmentVariables ?? []) {
      if (
        !modelConfig.includes(variable) &&
        !remoteCatalog.includes(variable) &&
        !configExtensions.includes(variable)
      ) {
        failures.push(`远程模型目录环境变量没有同步：${variable}。`);
      }
    }
  }

  const memoryTools = manifest.hostBridges?.memoryTools;
  if (memoryTools) {
    failures.push(
      ...checkPiMemoryToolsCompatibility({
        policy: memoryTools,
        sources: {
          workerToolGateway,
          hostToolGateway: toolGateway,
          hostMemoryRuntime: memoryRuntime,
          hostMemoryStore: memoryStoreRuntime,
          hostMemorySearchIndex: memoryStoreSearchIndex,
          hostConfigRuntime: configRuntime,
          hostWorkerRuntime: workerRuntime,
          workerMemoryLifecycle,
        },
      }),
    );
  }

  const goalSafety = manifest.hostBridges?.goalSafety;
  if (goalSafety) {
    if (
      goalSafety.implementation === "host-manifest-pi-extension" &&
      (!goalGuards.includes("enforceGoalGuards") ||
        !goalState.includes("startGoalState") ||
        !goalExtension.includes("createGoalExtension") ||
        !configExtensions.includes("pi_goal_policy"))
    ) {
      failures.push("Pi goal safety 没有实现清单声明的 Host/Pi bridge。");
    }
    if (
      goalSafety.manifestField &&
      (!resourcePolicy.includes(`manifest.${goalSafety.manifestField}`) ||
        !sessionResourceRefresh.includes(
          "normalizePiResourcePolicySnapshot(",
        ) ||
        !sessionResourceRefresh.includes(
          "applyPolicySnapshot(normalizedManifest)",
        ) ||
        !adapter.includes(
          `this.goalPolicy = snapshot.${goalSafety.manifestField}`,
        ))
    ) {
      failures.push("Pi goal safety 清单字段没有同步到资源刷新链路。");
    }
    if (
      goalSafety.environmentVariable &&
      (!resourcePolicy.includes(
        `const PI_GOAL_POLICY_ENV = "${goalSafety.environmentVariable}"`,
      ) ||
        !workerLaunch.includes(goalSafety.environmentVariable))
    ) {
      failures.push("Pi goal safety 环境变量没有同步到 worker 启动链路。");
    }
    for (const [name, expected, label] of [
      [
        "MAX_GOAL_TOKEN_BUDGET",
        goalSafety.maxTokenBudget,
        "goal token budget 上限",
      ],
      [
        "MAX_GOAL_STALL_TIMEOUT_SECS",
        goalSafety.maxStallTimeoutSecs,
        "goal stall timeout 上限",
      ],
    ]) {
      if (readNumericSourceConstant(goalState, name) !== expected) {
        failures.push(`worker ${label}没有同步兼容清单。`);
      }
    }
    if (
      readNumericSourceConstant(goalState, "MAX_GOAL_BLOCKED_ATTEMPTS") !==
      goalSafety.maxBlockedAttempts
    ) {
      failures.push("worker goal blocked-attempt 上限没有同步兼容清单。");
    }
    for (const variable of goalSafety.environmentVariables ?? []) {
      if (!configExtensions.includes(variable)) {
        failures.push(`goal safety 环境变量没有同步：${variable}。`);
      }
    }
  }

  const lspBridge = manifest.hostBridges?.lspBridge;
  failures.push(
    ...checkPiLspCompatibility(lspBridge, {
      workerToolGateway,
      hostLspRuntime: lspRuntime,
      hostLspConfig: lspConfig,
      hostLspProjection: lspProjection,
      workerRuntime,
      workerToolRouting,
    }),
  );

  try {
    mcpRuntime = readFileSync(mcpRuntimePath, "utf8");
  } catch (error) {
    failures.push(`src-tauri/src/pi_mcp_runtime.rs: ${error.message}`);
  }
  try {
    mcpConfig = readFileSync(mcpConfigPath, "utf8");
  } catch (error) {
    failures.push(
      `src-tauri/src/pi_mcp_runtime/mcp_config.rs: ${error.message}`,
    );
  }
  try {
    mcpStdioTransport = readFileSync(mcpStdioTransportPath, "utf8");
  } catch (error) {
    failures.push(
      `src-tauri/src/pi_mcp_runtime/stdio_transport.rs: ${error.message}`,
    );
  }
  try {
    mcpRemoteTransport = readFileSync(mcpRemoteTransportPath, "utf8");
  } catch (error) {
    failures.push(
      `src-tauri/src/pi_mcp_runtime/remote_transport.rs: ${error.message}`,
    );
  }

  failures.push(
    ...checkPiMcpTransportsCompatibility({
      transports: manifest?.hostBridges?.mcpTransports,
      sources: {
        hostMcpRuntime: mcpRuntime,
        hostMcpConfig: mcpConfig,
        hostStdioTransport: mcpStdioTransport,
        hostRemoteTransport: mcpRemoteTransport,
      },
    }),
  );

  const readMcpInventorySource = (relativePath) => {
    try {
      return readFileSync(resolve(root, relativePath), "utf8");
    } catch (error) {
      failures.push(`Pi Host MCP inventory wiring: ${error.message}`);
      return "";
    }
  };
  failures.push(
    ...checkPiMcpInventoryCompatibility({
      inventory: manifest?.hostBridges?.mcpInventory,
      sources: {
        hostMcpRuntime: mcpRuntime,
        hostMcpConfig: mcpConfig,
        hostConfigRuntime: configRuntime,
        hostTauriCommands: readMcpInventorySource("src-tauri/src/lib.rs"),
        tauriPermissions: readMcpInventorySource(
          "src-tauri/permissions/default.toml",
        ),
        rendererBridge: readMcpInventorySource(
          "src/lib/melody-bridge-config.ts",
        ),
        rendererPreflight: readMcpInventorySource(
          "src/lib/pi-compatibility.ts",
        ),
        capabilityReport: readMcpInventorySource(
          "src/domain/agent/capability-report.ts",
        ),
      },
    }),
  );

  failures.push(
    ...checkPiCodebaseIndexCompatibility(manifest.hostBridges?.codebaseIndex, {
      workerToolGateway,
      hostCodebaseRuntime: codebaseRuntime,
      hostCodebaseParser: codebaseParser,
      hostCodebaseRequest: codebaseRequest,
      hostCodebaseIndex: codebaseIndex,
      workerRuntime,
      workerToolRouting,
    }),
  );

  failures.push(
    ...checkPiHooksCompatibility(manifest.hostBridges?.hooks, {
      hostHookRuntime: hookRuntime,
      hostHookConfig: hookConfig,
      hostHookExecution: hookExecution,
      hostConfigRuntime: configRuntime,
      workerRuntime,
      workerToolRouting,
    }),
  );
}

if (failures.length > 0) {
  console.error("Pi compatibility checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Pi compatibility and Tauri command permission checks passed.");
}
