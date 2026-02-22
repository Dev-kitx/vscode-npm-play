import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type PackageJson = { scripts?: Record<string, string> };

type ScriptLensData = {
  fileUri: string;
  cwd: string;
  scriptName: string;
  scriptCmd?: string;
};

type ScriptKey = string;

type ScriptRunStatus = {
  running: boolean;
  lastExitCode?: number; // 0 = success, nonzero = fail
  lastRunAt?: number; // epoch ms
  runCount: number;
};

const STATE_SCRIPT_STATS = "devkitxScripts.stats.v1"; // workspaceState (map)
const TASK_TYPE = "devkitxScripts";

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  if (fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fileExists(path.join(cwd, "package-lock.json"))) return "npm";
  return "npm";
}

function getConfiguredPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  const cfg = vscode.workspace.getConfiguration();
  const setting = cfg.get<string>("devkitxScripts.packageManager", "auto");
  if (setting === "npm" || setting === "yarn" || setting === "pnpm") return setting;
  return detectPackageManager(cwd);
}

function makeScriptKey(cwd: string, scriptName: string): ScriptKey {
  return `${cwd}::${scriptName}`;
}

function loadStatsMap(
  context: vscode.ExtensionContext
): Record<ScriptKey, ScriptRunStatus> {
  return context.workspaceState.get<Record<ScriptKey, ScriptRunStatus>>(
    STATE_SCRIPT_STATS,
    {}
  );
}

async function saveStatsMap(
  context: vscode.ExtensionContext,
  map: Record<ScriptKey, ScriptRunStatus>
): Promise<void> {
  await context.workspaceState.update(STATE_SCRIPT_STATS, map);
}

function getOrInitStatus(
  map: Record<ScriptKey, ScriptRunStatus>,
  key: ScriptKey
): ScriptRunStatus {
  if (!map[key]) {
    map[key] = { running: false, runCount: 0 };
  }
  return map[key];
}

function isDangerous(scriptName: string, scriptCmd?: string): boolean {
  const s = `${scriptName} ${scriptCmd ?? ""}`.toLowerCase();

  const keywords = [
    "rm",
    "remove",
    "delete",
    "clean",
    "purge",
    "prune",
    "reset",
    "wipe",
    "nuke",
    "uninstall",
    "reinstall",
    "format",
    "drop",
    "migrate:reset"
  ];

  return keywords.some((k) => s.includes(k));
}

function formatWhen(ts?: number): string {
  if (!ts) return "never";
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Args are intentionally NOT supported (user asked to remove). */
function buildRunCommand(pm: "npm" | "yarn" | "pnpm", scriptName: string): string {
  if (pm === "npm") return `npm run ${scriptName}`;
  if (pm === "yarn") return `yarn ${scriptName}`;
  return `pnpm ${scriptName}`;
}

/** Debug is "best effort" via NODE_OPTIONS; still no args support. */
function buildDebugCommand(
  pm: "npm" | "yarn" | "pnpm",
  scriptName: string
): string {
  const debugPrefix =
    process.platform === "win32"
      ? `set NODE_OPTIONS=--inspect-brk && `
      : `NODE_OPTIONS="--inspect-brk" `;

  return debugPrefix + buildRunCommand(pm, scriptName);
}

function makeTask(
  cwd: string,
  label: string,
  commandLine: string,
  perScriptTerminal: boolean
): vscode.Task {
  const definition: vscode.TaskDefinition = {
    type: TASK_TYPE,
    cwd,
    label
  };

  const exec = new vscode.ShellExecution(commandLine, { cwd });

  const wsFolder =
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) ?? undefined;

  const task = new vscode.Task(
    definition,
    wsFolder ?? vscode.TaskScope.Workspace,
    label,
    "Devkitx Script Runner",
    exec
  );

  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: perScriptTerminal
      ? vscode.TaskPanelKind.Dedicated
      : vscode.TaskPanelKind.Shared,
    clear: false,
    focus: false
  };

  task.isBackground = false;
  return task;
}

async function confirmDanger(scriptName: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration();
  const enabled = cfg.get<boolean>("devkitxScripts.dangerConfirm", true);
  if (!enabled) return true;

  const pick = await vscode.window.showWarningMessage(
    `This script looks potentially destructive: "${scriptName}". Run anyway?`,
    { modal: true },
    "Run",
    "Cancel"
  );
  return pick === "Run";
}

class PackageJsonScriptsCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("devkitxScripts.packageManager") ||
        e.affectsConfiguration("devkitxScripts.showDebugLens") ||
        e.affectsConfiguration("devkitxScripts.dangerConfirm") ||
        e.affectsConfiguration("devkitxScripts.terminalPerScript")
      ) {
        this._onDidChangeCodeLenses.fire();
      }
    });

    const watcher = vscode.workspace.createFileSystemWatcher("**/package.json");
    watcher.onDidChange(() => this._onDidChangeCodeLenses.fire());
    watcher.onDidCreate(() => this._onDidChangeCodeLenses.fire());
    watcher.onDidDelete(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (token.isCancellationRequested) return [];

    const filePath = document.uri.fsPath;
    const cwd = path.dirname(filePath);

    const pkg = readJsonFile<PackageJson>(filePath);
    const scripts = pkg?.scripts;
    if (!scripts || Object.keys(scripts).length === 0) return [];

    const showDebug = vscode.workspace
      .getConfiguration()
      .get<boolean>("devkitxScripts.showDebugLens", false);

    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];

    // Status map (for badges + tooltips)
    const map = (this._context?.workspaceState
      ? this._context.workspaceState.get<Record<ScriptKey, ScriptRunStatus>>(
          STATE_SCRIPT_STATS,
          {}
        )
      : {}) as Record<ScriptKey, ScriptRunStatus>;

    for (const [name, cmd] of Object.entries(scripts)) {
      const line = findScriptKeyLine(text, name);
      const range =
        line !== undefined
          ? new vscode.Range(
              new vscode.Position(line, 0),
              new vscode.Position(line, 0)
            )
          : new vscode.Range(
              new vscode.Position(0, 0),
              new vscode.Position(0, 0)
            );

      const key = makeScriptKey(cwd, name);
      const st = map[key];

      const badge = st?.running
        ? "●"
        : st?.lastExitCode === 0
        ? "✔"
        : typeof st?.lastExitCode === "number"
        ? "✖"
        : "";

      const runCount = st?.runCount ?? 0;
      const lastRun = formatWhen(st?.lastRunAt);
      const lastResult = st?.running
        ? "running"
        : st?.lastExitCode === 0
        ? "last: success"
        : typeof st?.lastExitCode === "number"
        ? `last: fail (${st.lastExitCode})`
        : "last: unknown";

      const tooltip = new vscode.MarkdownString(
        [
          `**${name}**`,
          "",
          `\`${cmd}\``,
          "",
          `**Status:** ${lastResult}`,
          `**Last run:** ${lastRun}`,
          `**Run count:** ${runCount}`
        ]
          .filter(Boolean)
          .join("\n")
      );
      tooltip.isTrusted = false;

      const data: ScriptLensData = {
        fileUri: document.uri.toString(),
        cwd,
        scriptName: name,
        scriptCmd: cmd
      };

      lenses.push(
        new vscode.CodeLens(range, {
          title: `▶ ${name}${badge ? `  ${badge}` : ""}`,
          tooltip: tooltip.value,
          command: "devkitxScripts.runScript",
          arguments: [data]
        })
      );

      if (showDebug) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `🐞 Debug`,
            tooltip: new vscode.MarkdownString(
              "Runs with `NODE_OPTIONS=--inspect-brk` (best-effort)."
            ).value,
            command: "devkitxScripts.runScriptDebug",
            arguments: [data]
          })
        );
      }
    }

    return lenses;
  }

  private _context?: vscode.ExtensionContext;
  public setContext(ctx: vscode.ExtensionContext) {
    this._context = ctx;
    this._onDidChangeCodeLenses.fire();
  }
}

function findScriptKeyLine(fileText: string, scriptName: string): number | undefined {
  const needle = `"${scriptName}"`;
  const idx = fileText.indexOf(needle);
  if (idx < 0) return undefined;
  let line = 0;
  for (let i = 0; i < idx; i++) {
    if (fileText.charCodeAt(i) === 10) line++; // '\n'
  }
  return line;
}

async function runScript(
  context: vscode.ExtensionContext,
  cwd: string,
  scriptName: string,
  scriptCmd?: string,
  debug?: boolean
): Promise<void> {
  const pm = getConfiguredPackageManager(cwd);

  // Danger-zone confirm
  if (isDangerous(scriptName, scriptCmd)) {
    const ok = await confirmDanger(scriptName);
    if (!ok) return;
  }

  const perScriptTerminal = vscode.workspace
    .getConfiguration()
    .get<boolean>("devkitxScripts.terminalPerScript", true);

  const cmdLine = debug
    ? buildDebugCommand(pm, scriptName)
    : buildRunCommand(pm, scriptName);

  const folderName = path.basename(cwd);
  const label = perScriptTerminal
    ? `npm-play: ${scriptName} (${folderName})`
    : `npm-play Scripts`;

  const task = makeTask(cwd, label, cmdLine, perScriptTerminal);

  // Update status: running + counts
  const key = makeScriptKey(cwd, scriptName);
  const map = loadStatsMap(context);
  const st = getOrInitStatus(map, key);
  st.running = true;
  st.runCount = (st.runCount ?? 0) + 1;
  st.lastRunAt = Date.now();
  await saveStatsMap(context, map);

  await vscode.tasks.executeTask(task);
}

async function runLauncher(context: vscode.ExtensionContext): Promise<void> {
  // Find package.json files (avoid node_modules)
  const files = await vscode.workspace.findFiles(
    "**/package.json",
    "**/node_modules/**",
    50
  );

  const items: Array<{
    label: string;
    description: string;
    detail: string;
    data: ScriptLensData;
  }> = [];

  for (const uri of files) {
    const filePath = uri.fsPath;
    const cwd = path.dirname(filePath);
    const pkg = readJsonFile<PackageJson>(filePath);
    const scripts = pkg?.scripts;
    if (!scripts) continue;

    const rel = vscode.workspace.asRelativePath(uri);

    for (const [name, cmd] of Object.entries(scripts)) {
      items.push({
        label: `▶ ${name}`,
        description: rel,
        detail: cmd,
        data: { fileUri: uri.toString(), cwd, scriptName: name, scriptCmd: cmd }
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage("No package.json scripts found in workspace.");
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Pick a script to run",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!pick) return;

  await runScript(
    context,
    pick.data.cwd,
    pick.data.scriptName,
    pick.data.scriptCmd,
    false
  );
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PackageJsonScriptsCodeLensProvider();
  provider.setContext(context);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "json", pattern: "**/package.json" },
      provider
    )
  );

  // Task lifecycle: update badges (running/success/fail)
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess(async (e) => {
      const t = e.execution.task;
      if (t.definition?.type !== TASK_TYPE) return;

      provider.setContext(context);
    }),

    vscode.tasks.onDidEndTaskProcess(async (e) => {
      const t = e.execution.task;
      if (t.definition?.type !== TASK_TYPE) return;

      const def = t.definition as any;
      const cwd: string | undefined = def.cwd;
      const label: string | undefined = def.label;

      if (!cwd || !label) {
        provider.setContext(context);
        return;
      }

      // Try to extract script name from label "npm-play: <script> (<folder>)"
      let scriptName = label;
      const m = label.match(/^npm-play:\s(.+?)\s\(/);
      if (m?.[1]) scriptName = m[1];

      const key = makeScriptKey(cwd, scriptName);
      const map = loadStatsMap(context);
      const st = getOrInitStatus(map, key);

      st.running = false;
      st.lastExitCode = typeof e.exitCode === "number" ? e.exitCode : undefined;
      st.lastRunAt = Date.now();

      await saveStatsMap(context, map);
      provider.setContext(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "devkitxScripts.runScript",
      async (data: ScriptLensData) => {
        if (!data?.cwd || !data?.scriptName) return;
        await runScript(context, data.cwd, data.scriptName, data.scriptCmd, false);
        provider.setContext(context);
      }
    ),

    vscode.commands.registerCommand(
      "devkitxScripts.runScriptDebug",
      async (data: ScriptLensData) => {
        if (!data?.cwd || !data?.scriptName) return;
        await runScript(context, data.cwd, data.scriptName, data.scriptCmd, true);
        provider.setContext(context);
      }
    ),

    vscode.commands.registerCommand("devkitxScripts.launcher", async () => {
      await runLauncher(context);
      provider.setContext(context);
    })
  );

  // Status bar launcher (now "npm-play" by default)
  const enableStatusBar = vscode.workspace
    .getConfiguration()
    .get<boolean>("devkitxScripts.enableStatusBar", true);

  if (enableStatusBar) {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );

    const statusText = vscode.workspace
      .getConfiguration()
      .get<string>("devkitxScripts.statusBarText", "npm-play ▶");

    item.text = statusText;
    item.tooltip = "npm-play: Script Launcher";
    item.command = "devkitxScripts.launcher";
    item.show();
    context.subscriptions.push(item);
  }
}

export function deactivate() {}

// ---- test exports (no runtime impact) ----
export const __test__ = {
  readJsonFile,
  fileExists,
  detectPackageManager,
  getConfiguredPackageManager,
  makeScriptKey,
  loadStatsMap,
  saveStatsMap,
  getOrInitStatus,
  isDangerous,
  formatWhen,
  buildRunCommand,
  buildDebugCommand,
  findScriptKeyLine,
  makeTask,
  confirmDanger,
  PackageJsonScriptsCodeLensProvider,
};
