import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type PackageJson = { name?: string; scripts?: Record<string, string> };

type ScriptLensData = {
  fileUri: string;
  cwd: string;
  scriptName: string;
  scriptCmd?: string;
};

type ScriptKey = string;

type ScriptRunStatus = {
  running: boolean;
  lastExitCode?: number; // 0 = success, positive = fail, -1 = cancelled/killed
  lastRunAt?: number; // epoch ms
  runCount: number;
  lastDurationMs?: number; // how long the last run took
};

const STATE_SCRIPT_STATS = "npmPlay.stats.v1"; // workspaceState (map)
const STATE_PINNED = "npmPlay.pinned.v1"; // workspaceState (string[])
const TASK_TYPE = "npmPlay";
const STATS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATS_MAX_ENTRIES = 200;

// In-memory start times for duration tracking (session only, not persisted)
const _taskStartTimes = new Map<ScriptKey, number>();

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
  const hasPnpm = fileExists(path.join(cwd, "pnpm-lock.yaml"));
  const hasYarn = fileExists(path.join(cwd, "yarn.lock"));
  const hasNpm = fileExists(path.join(cwd, "package-lock.json"));

  if ([hasPnpm, hasYarn, hasNpm].filter(Boolean).length > 1) {
    const chosen = hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
    vscode.window.showWarningMessage(
      `npm-play: Multiple lock files detected in "${path.basename(cwd)}". Using ${chosen}. Consider removing extra lock files or setting npmPlay.packageManager explicitly.`
    );
  }

  if (hasPnpm) return "pnpm";
  if (hasYarn) return "yarn";
  if (hasNpm) return "npm";
  return "npm";
}

function getConfiguredPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  const cfg = vscode.workspace.getConfiguration();
  const setting = cfg.get<string>("npmPlay.packageManager", "auto");
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

function pruneStatsMap(
  map: Record<ScriptKey, ScriptRunStatus>
): Record<ScriptKey, ScriptRunStatus> {
  const cutoff = Date.now() - STATS_MAX_AGE_MS;
  let entries = Object.entries(map).filter(
    ([, st]) => !st.lastRunAt || st.lastRunAt > cutoff
  );
  if (entries.length > STATS_MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].lastRunAt ?? 0) - (a[1].lastRunAt ?? 0));
    entries = entries.slice(0, STATS_MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

async function saveStatsMap(
  context: vscode.ExtensionContext,
  map: Record<ScriptKey, ScriptRunStatus>
): Promise<void> {
  await context.workspaceState.update(STATE_SCRIPT_STATS, pruneStatsMap(map));
}

function loadPinnedSet(context: vscode.ExtensionContext): Set<ScriptKey> {
  const keys = context.workspaceState.get<string[]>(STATE_PINNED, []);
  return new Set(keys);
}

async function savePinnedSet(
  context: vscode.ExtensionContext,
  set: Set<ScriptKey>
): Promise<void> {
  await context.workspaceState.update(STATE_PINNED, [...set]);
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${min}m${s > 0 ? ` ${s}s` : ""}`;
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
  const enabled = cfg.get<boolean>("npmPlay.dangerConfirm", true);
  if (!enabled) return true;

  const pick = await vscode.window.showWarningMessage(
    `This script looks potentially destructive: "${scriptName}". Run anyway?`,
    { modal: true },
    "Run",
    "Cancel"
  );
  return pick === "Run";
}

class PackageJsonScriptsCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _configListener: vscode.Disposable;

  constructor() {
    this._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("npmPlay.packageManager") ||
        e.affectsConfiguration("npmPlay.showDebugLens") ||
        e.affectsConfiguration("npmPlay.dangerConfirm") ||
        e.affectsConfiguration("npmPlay.terminalPerScript")
      ) {
        this._onDidChangeCodeLenses.fire();
      }
    });

    this._watcher = vscode.workspace.createFileSystemWatcher("**/package.json");
    this._watcher.onDidChange(() => this._onDidChangeCodeLenses.fire());
    this._watcher.onDidCreate(() => this._onDidChangeCodeLenses.fire());
    this._watcher.onDidDelete(() => this._onDidChangeCodeLenses.fire());
  }

  dispose() {
    this._watcher.dispose();
    this._configListener.dispose();
    this._onDidChangeCodeLenses.dispose();
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
      .get<boolean>("npmPlay.showDebugLens", false);

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
        : st?.lastExitCode === -1
        ? "⊘"
        : typeof st?.lastExitCode === "number"
        ? "✖"
        : "";

      const durationStr =
        badge && typeof st?.lastDurationMs === "number"
          ? ` ${formatDuration(st.lastDurationMs)}`
          : "";

      const runCount = st?.runCount ?? 0;
      const lastRun = formatWhen(st?.lastRunAt);
      const lastResult = st?.running
        ? "running"
        : st?.lastExitCode === 0
        ? "last: success"
        : st?.lastExitCode === -1
        ? "last: cancelled"
        : typeof st?.lastExitCode === "number"
        ? `last: fail (${st.lastExitCode})`
        : "last: unknown";

      const tooltipLines = [
        `**${name}**`,
        "",
        `\`${cmd}\``,
        "",
        `**Status:** ${lastResult}`,
        `**Last run:** ${lastRun}`,
        `**Run count:** ${runCount}`
      ];
      if (typeof st?.lastDurationMs === "number") {
        tooltipLines.push(`**Duration:** ${formatDuration(st.lastDurationMs)}`);
      }

      const tooltip = new vscode.MarkdownString(
        tooltipLines.filter(Boolean).join("\n")
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
          title: `▶ ${name}${badge ? `  ${badge}${durationStr}` : ""}`,
          tooltip: tooltip.value,
          command: "npmPlay.runScript",
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
            command: "npmPlay.runScriptDebug",
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

// ---- Script History Sidebar ----

class HistoryItem extends vscode.TreeItem {
  constructor(
    public readonly cwd: string,
    public readonly scriptName: string,
    public readonly status: ScriptRunStatus
  ) {
    super(scriptName, vscode.TreeItemCollapsibleState.None);

    const badge = status.running
      ? "●"
      : status.lastExitCode === 0
      ? "✔"
      : status.lastExitCode === -1
      ? "⊘"
      : typeof status.lastExitCode === "number"
      ? "✖"
      : "○";

    const dur =
      typeof status.lastDurationMs === "number"
        ? ` · ${formatDuration(status.lastDurationMs)}`
        : "";

    this.description = `${badge}${dur} · ${path.basename(cwd)} · ${formatWhen(status.lastRunAt)}`;

    this.iconPath = status.running
      ? new vscode.ThemeIcon("loading~spin")
      : status.lastExitCode === 0
      ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
      : status.lastExitCode === -1
      ? new vscode.ThemeIcon("circle-slash")
      : typeof status.lastExitCode === "number"
      ? new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"))
      : new vscode.ThemeIcon("circle-outline");

    const tooltipLines = [
      `**${scriptName}**`,
      "",
      `📁 ${path.basename(cwd)}`,
      `⏱ Last run: ${formatWhen(status.lastRunAt)}${typeof status.lastDurationMs === "number" ? ` (took ${formatDuration(status.lastDurationMs)})` : ""}`,
      `🔁 ${status.runCount} run${status.runCount !== 1 ? "s" : ""}`
    ];
    this.tooltip = new vscode.MarkdownString(tooltipLines.join("\n"));

    this.command = {
      command: "npmPlay.rerunFromHistory",
      title: "Re-run",
      arguments: [{ fileUri: "", cwd, scriptName } as ScriptLensData]
    };

    this.contextValue = "historyItem";
  }
}

class ScriptHistoryProvider
  implements vscode.TreeDataProvider<HistoryItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    HistoryItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _context?: vscode.ExtensionContext;

  setContext(ctx: vscode.ExtensionContext) {
    this._context = ctx;
    this._onDidChangeTreeData.fire();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HistoryItem[] {
    if (!this._context) return [];
    const map = loadStatsMap(this._context);

    return Object.entries(map)
      .filter(([, st]) => st.lastRunAt !== undefined)
      .sort((a, b) => (b[1].lastRunAt ?? 0) - (a[1].lastRunAt ?? 0))
      .slice(0, 50)
      .map(([key, st]) => {
        const sep = key.indexOf("::");
        const cwd = key.slice(0, sep);
        const scriptName = key.slice(sep + 2);
        return new HistoryItem(cwd, scriptName, st);
      });
  }
}

// ---- Line finder ----

function findScriptKeyLine(fileText: string, scriptName: string): number | undefined {
  // Anchor search to after the "scripts" key to avoid false matches elsewhere in the file
  const scriptsIdx = fileText.indexOf('"scripts"');
  if (scriptsIdx < 0) return undefined;

  const needle = `"${scriptName}"`;
  const idx = fileText.indexOf(needle, scriptsIdx);
  if (idx < 0) return undefined;

  let line = 0;
  for (let i = 0; i < idx; i++) {
    if (fileText.charCodeAt(i) === 10) line++; // '\n'
  }
  return line;
}

// ---- Command handlers ----

async function runScript(
  context: vscode.ExtensionContext,
  cwd: string,
  scriptName: string,
  scriptCmd?: string,
  debug?: boolean
): Promise<void> {
  const pm = getConfiguredPackageManager(cwd);

  if (isDangerous(scriptName, scriptCmd)) {
    const ok = await confirmDanger(scriptName);
    if (!ok) return;
  }

  const perScriptTerminal = vscode.workspace
    .getConfiguration()
    .get<boolean>("npmPlay.terminalPerScript", true);

  const cmdLine = debug
    ? buildDebugCommand(pm, scriptName)
    : buildRunCommand(pm, scriptName);

  const folderName = path.basename(cwd);
  const label = perScriptTerminal
    ? `npm-play: ${scriptName} (${folderName})`
    : `npm-play Scripts`;

  const task = makeTask(cwd, label, cmdLine, perScriptTerminal);

  const key = makeScriptKey(cwd, scriptName);
  const map = loadStatsMap(context);
  const st = getOrInitStatus(map, key);
  st.running = true;
  st.runCount = (st.runCount ?? 0) + 1;
  st.lastRunAt = Date.now();
  _taskStartTimes.set(key, Date.now()); // record start for duration tracking
  await saveStatsMap(context, map);

  await vscode.tasks.executeTask(task);
}

async function runLauncher(context: vscode.ExtensionContext): Promise<void> {
  const files = await vscode.workspace.findFiles(
    "**/package.json",
    "**/node_modules/**",
    50
  );

  type LauncherItem = vscode.QuickPickItem & { data?: ScriptLensData };

  // Build per-package groups
  const groups: Array<{ groupLabel: string; items: LauncherItem[] }> = [];

  for (const uri of files) {
    const filePath = uri.fsPath;
    const cwd = path.dirname(filePath);
    const pkg = readJsonFile<PackageJson>(filePath);
    const scripts = pkg?.scripts;
    if (!scripts) continue;

    const rel = vscode.workspace.asRelativePath(uri);
    const groupLabel = pkg.name ? `${pkg.name}  —  ${rel}` : rel;
    const items: LauncherItem[] = [];

    for (const [name, cmd] of Object.entries(scripts)) {
      items.push({
        label: `▶ ${name}`,
        description: cmd,
        data: { fileUri: uri.toString(), cwd, scriptName: name, scriptCmd: cmd }
      });
    }

    if (items.length > 0) groups.push({ groupLabel, items });
  }

  if (groups.length === 0) {
    vscode.window.showInformationMessage("No package.json scripts found in workspace.");
    return;
  }

  const pinned = loadPinnedSet(context);
  const allItems: LauncherItem[] = [];

  // Pinned section first
  const pinnedItems: LauncherItem[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const key = makeScriptKey(item.data!.cwd, item.data!.scriptName);
      if (pinned.has(key)) {
        pinnedItems.push({ ...item, label: `⭐ ${item.label.slice(2).trim()}` });
      }
    }
  }

  if (pinnedItems.length > 0) {
    allItems.push({ label: "Pinned", kind: vscode.QuickPickItemKind.Separator });
    allItems.push(...pinnedItems);
    allItems.push({ label: "All Scripts", kind: vscode.QuickPickItemKind.Separator });
  }

  for (const group of groups) {
    allItems.push({ label: group.groupLabel, kind: vscode.QuickPickItemKind.Separator });
    allItems.push(...group.items);
  }

  const pick = await vscode.window.showQuickPick(allItems, {
    placeHolder: "Pick a script to run",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!pick?.data) return;

  await runScript(
    context,
    pick.data.cwd,
    pick.data.scriptName,
    pick.data.scriptCmd,
    false
  );
}

async function togglePin(context: vscode.ExtensionContext): Promise<void> {
  const files = await vscode.workspace.findFiles(
    "**/package.json",
    "**/node_modules/**",
    50
  );

  const pinned = loadPinnedSet(context);

  type PinItem = vscode.QuickPickItem & { key: ScriptKey; data: ScriptLensData };
  const items: PinItem[] = [];

  for (const uri of files) {
    const filePath = uri.fsPath;
    const cwd = path.dirname(filePath);
    const pkg = readJsonFile<PackageJson>(filePath);
    const scripts = pkg?.scripts;
    if (!scripts) continue;

    for (const [name, cmd] of Object.entries(scripts)) {
      const key = makeScriptKey(cwd, name);
      items.push({
        label: `${pinned.has(key) ? "⭐" : "☆"}  ${name}`,
        description: vscode.workspace.asRelativePath(uri),
        detail: cmd,
        key,
        data: { fileUri: uri.toString(), cwd, scriptName: name, scriptCmd: cmd }
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage("No scripts found.");
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a script to pin or unpin  (⭐ = currently pinned)",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!pick) return;

  if (pinned.has(pick.key)) {
    pinned.delete(pick.key);
    vscode.window.showInformationMessage(`npm-play: Unpinned "${pick.data.scriptName}"`);
  } else {
    pinned.add(pick.key);
    vscode.window.showInformationMessage(`npm-play: Pinned "${pick.data.scriptName}" ⭐`);
  }

  await savePinnedSet(context, pinned);
}

// ---- Extension lifecycle ----

export function activate(context: vscode.ExtensionContext) {
  const provider = new PackageJsonScriptsCodeLensProvider();
  provider.setContext(context);
  context.subscriptions.push(provider); // ensures watcher + listeners are disposed on deactivation

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "json", pattern: "**/package.json" },
      provider
    )
  );

  const historyProvider = new ScriptHistoryProvider();
  historyProvider.setContext(context);
  context.subscriptions.push(historyProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("npmPlay.historyView", historyProvider)
  );

  // Task lifecycle: update badges + history
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess(async (e) => {
      const t = e.execution.task;
      if (t.definition?.type !== TASK_TYPE) return;
      provider.setContext(context);
      historyProvider.refresh();
    }),

    vscode.tasks.onDidEndTaskProcess(async (e) => {
      const t = e.execution.task;
      if (t.definition?.type !== TASK_TYPE) return;

      const def = t.definition as any;
      const cwd: string | undefined = def.cwd;
      const label: string | undefined = def.label;

      if (!cwd || !label) {
        provider.setContext(context);
        historyProvider.refresh();
        return;
      }

      // Extract script name from label "npm-play: <script> (<folder>)"
      let scriptName = label;
      const m = label.match(/^npm-play:\s(.+?)\s\(/);
      if (m?.[1]) scriptName = m[1];

      const key = makeScriptKey(cwd, scriptName);
      const map = loadStatsMap(context);
      const st = getOrInitStatus(map, key);

      st.running = false;
      // -1 = cancelled/killed; undefined exit means process was terminated externally
      st.lastExitCode = typeof e.exitCode === "number" ? e.exitCode : -1;
      st.lastRunAt = Date.now();

      // Compute duration from the in-memory start time
      const startTime = _taskStartTimes.get(key);
      if (startTime !== undefined) {
        st.lastDurationMs = Date.now() - startTime;
        _taskStartTimes.delete(key);
      }

      await saveStatsMap(context, map);
      provider.setContext(context);
      historyProvider.refresh();

      // Notify if the script ran longer than the configured threshold
      const notifyAfterMs = vscode.workspace
        .getConfiguration()
        .get<number>("npmPlay.notifyAfterMs", 0);
      if (notifyAfterMs > 0 && (st.lastDurationMs ?? 0) >= notifyAfterMs) {
        const icon =
          st.lastExitCode === 0 ? "✔" : st.lastExitCode === -1 ? "⊘" : "✖";
        const dur =
          st.lastDurationMs !== undefined
            ? formatDuration(st.lastDurationMs)
            : "unknown duration";
        vscode.window.showInformationMessage(
          `npm-play: "${scriptName}" finished ${icon} in ${dur}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "npmPlay.runScript",
      async (data: ScriptLensData) => {
        if (!data?.cwd || !data?.scriptName) return;
        await runScript(context, data.cwd, data.scriptName, data.scriptCmd, false);
        provider.setContext(context);
        historyProvider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "npmPlay.runScriptDebug",
      async (data: ScriptLensData) => {
        if (!data?.cwd || !data?.scriptName) return;
        await runScript(context, data.cwd, data.scriptName, data.scriptCmd, true);
        provider.setContext(context);
        historyProvider.refresh();
      }
    ),

    vscode.commands.registerCommand("npmPlay.launcher", async () => {
      await runLauncher(context);
    }),

    vscode.commands.registerCommand("npmPlay.togglePin", async () => {
      await togglePin(context);
    }),

    vscode.commands.registerCommand(
      "npmPlay.rerunFromHistory",
      async (data: ScriptLensData) => {
        if (!data?.cwd || !data?.scriptName) return;
        await runScript(context, data.cwd, data.scriptName, data.scriptCmd, false);
        provider.setContext(context);
        historyProvider.refresh();
      }
    )
  );

  // Status bar launcher
  const enableStatusBar = vscode.workspace
    .getConfiguration()
    .get<boolean>("npmPlay.enableStatusBar", true);

  if (enableStatusBar) {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );

    const statusText = vscode.workspace
      .getConfiguration()
      .get<string>("npmPlay.statusBarText", "npm-play ▶");

    item.text = statusText;
    item.tooltip = "npm-play: Script Launcher";
    item.command = "npmPlay.launcher";
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
  pruneStatsMap,
  loadPinnedSet,
  savePinnedSet,
  getOrInitStatus,
  isDangerous,
  formatWhen,
  formatDuration,
  buildRunCommand,
  buildDebugCommand,
  findScriptKeyLine,
  makeTask,
  confirmDanger,
  PackageJsonScriptsCodeLensProvider,
  ScriptHistoryProvider,
  HistoryItem,
};
