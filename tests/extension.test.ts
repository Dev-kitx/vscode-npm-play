import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";

// IMPORTANT: mock fs BEFORE importing the extension module
vi.mock("fs", () => {
  return {
    readFileSync: vi.fn(),
    accessSync: vi.fn(),
    constants: { F_OK: 0 },
  };
});

// Mock vscode BEFORE importing the extension module
vi.mock("vscode", () => {
  // Minimal VS Code surface needed for unit tests
  class MarkdownString {
    value: string;
    isTrusted = false;
    constructor(value: string) {
      this.value = value;
    }
  }
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  class CodeLens {
    constructor(public range: Range, public command?: any) {}
  }
  class EventEmitter<T> {
    private _listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this._listeners.push(listener);
      return { dispose: () => {} };
    };
    fire = (e: T) => {
      for (const l of this._listeners) l(e);
    };
    dispose() {}
  }

  // Task-related minimal mocks
  class ShellExecution {
    constructor(public commandLine: string, public options: any) {}
  }
  class Task {
    public presentationOptions: any;
    public isBackground = false;
    constructor(
      public definition: any,
      public scope: any,
      public name: string,
      public source: string,
      public execution: any
    ) {}
  }

  class TreeItem {
    label: string;
    collapsibleState: number;
    description?: string;
    iconPath?: any;
    tooltip?: any;
    command?: any;
    contextValue?: string;
    constructor(label: string, collapsibleState: number = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class ThemeIcon {
    constructor(public id: string, public color?: any) {}
  }

  class ThemeColor {
    constructor(public id: string) {}
  }

  const configStore = new Map<string, any>();

  const vscodeMock = {
    MarkdownString,
    Position,
    Range,
    CodeLens,
    EventEmitter,
    ShellExecution,
    Task,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TaskScope: { Workspace: "Workspace" },
    TaskRevealKind: { Always: "Always" },
    TaskPanelKind: { Dedicated: "Dedicated", Shared: "Shared" },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (key: string, def: any) => {
          return configStore.has(key) ? configStore.get(key) : def;
        },
      })),
      getWorkspaceFolder: vi.fn(() => undefined),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(),
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        dispose: vi.fn(),
      })),
      onDidChangeConfiguration: vi.fn(),
      findFiles: vi.fn(async () => []),
      asRelativePath: vi.fn((u: any) => u.fsPath ?? String(u)),
    },
    window: {
      showWarningMessage: vi.fn(async () => "Cancel"),
      showInformationMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined),
      createStatusBarItem: vi.fn(() => ({
        text: "",
        tooltip: "",
        command: "",
        show: vi.fn(),
      })),
      registerTreeDataProvider: vi.fn(() => ({ dispose: () => {} })),
    },
    tasks: {
      executeTask: vi.fn(async () => undefined),
      onDidStartTaskProcess: vi.fn(),
      onDidEndTaskProcess: vi.fn(),
    },
    languages: {
      registerCodeLensProvider: vi.fn(() => ({ dispose: () => {} })),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: () => {} })),
    },
    StatusBarAlignment: { Left: 1 },
  };

  // helper for tests to set config
  (vscodeMock as any).__setConfig = (key: string, value: any) => {
    configStore.set(key, value);
  };
  (vscodeMock as any).__clearConfig = () => configStore.clear();

  return vscodeMock;
});

import * as fs from "fs";
import * as vscode from "vscode";
import { __test__ } from "../src/extension";

describe("npm-play / Devkitx Script Runner - unit tests", () => {
  beforeEach(() => {
    (vscode as any).__clearConfig?.();
    vi.clearAllMocks();
  });

  describe("readJsonFile", () => {
    it("returns parsed JSON for valid file", () => {
      (fs.readFileSync as any).mockReturnValueOnce(JSON.stringify({ scripts: { test: "vitest" } }));
      const out = __test__.readJsonFile<{ scripts: Record<string, string> }>("package.json");
      expect(out?.scripts?.test).toBe("vitest");
    });

    it("returns undefined on read/parse error", () => {
      (fs.readFileSync as any).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      const out = __test__.readJsonFile<any>("missing.json");
      expect(out).toBeUndefined();
    });
  });

  describe("fileExists", () => {
    it("returns true when accessSync succeeds", () => {
      (fs.accessSync as any).mockImplementationOnce(() => {});
      expect(__test__.fileExists("/x")).toBe(true);
    });

    it("returns false when accessSync throws", () => {
      (fs.accessSync as any).mockImplementationOnce(() => {
        throw new Error("nope");
      });
      expect(__test__.fileExists("/x")).toBe(false);
    });
  });

  describe("detectPackageManager", () => {
    it("returns pnpm if pnpm-lock.yaml exists", () => {
      const cwd = "/repo";
      (fs.accessSync as any).mockImplementation((p: string) => {
        if (p === path.join(cwd, "pnpm-lock.yaml")) return;
        throw new Error("no");
      });
      expect(__test__.detectPackageManager(cwd)).toBe("pnpm");
    });

    it("returns yarn if yarn.lock exists", () => {
      const cwd = "/repo";
      (fs.accessSync as any).mockImplementation((p: string) => {
        if (p === path.join(cwd, "yarn.lock")) return;
        throw new Error("no");
      });
      expect(__test__.detectPackageManager(cwd)).toBe("yarn");
    });

    it("returns npm if package-lock.json exists", () => {
      const cwd = "/repo";
      (fs.accessSync as any).mockImplementation((p: string) => {
        if (p === path.join(cwd, "package-lock.json")) return;
        throw new Error("no");
      });
      expect(__test__.detectPackageManager(cwd)).toBe("npm");
    });

    it("defaults to npm if no lock files exist", () => {
      (fs.accessSync as any).mockImplementation(() => {
        throw new Error("no");
      });
      expect(__test__.detectPackageManager("/repo")).toBe("npm");
    });
  });

  describe("getConfiguredPackageManager", () => {
    it("returns configured value when set to npm/yarn/pnpm", () => {
      (vscode as any).__setConfig("npmPlay.packageManager", "yarn");
      expect(__test__.getConfiguredPackageManager("/repo")).toBe("yarn");
    });

    it("uses auto detection when config is auto", () => {
      (vscode as any).__setConfig("npmPlay.packageManager", "auto");
      (fs.accessSync as any).mockImplementation((p: string) => {
        if (p.endsWith("pnpm-lock.yaml")) return;
        throw new Error("no");
      });
      expect(__test__.getConfiguredPackageManager("/repo")).toBe("pnpm");
    });
  });

  describe("makeScriptKey", () => {
    it("creates stable key", () => {
      expect(__test__.makeScriptKey("/repo", "build")).toBe("/repo::build");
    });
  });

  describe("getOrInitStatus", () => {
    it("initializes missing status", () => {
      const map: any = {};
      const st = __test__.getOrInitStatus(map, "k1");
      expect(st.running).toBe(false);
      expect(st.runCount).toBe(0);
      expect(map.k1).toBeDefined();
    });

    it("returns existing status unchanged", () => {
      const map: any = { k1: { running: true, runCount: 7, lastExitCode: 0 } };
      const st = __test__.getOrInitStatus(map, "k1");
      expect(st.running).toBe(true);
      expect(st.runCount).toBe(7);
      expect(st.lastExitCode).toBe(0);
    });
  });

  describe("isDangerous", () => {
    it("flags dangerous names/commands", () => {
      expect(__test__.isDangerous("clean")).toBe(true);
      expect(__test__.isDangerous("build", "rm -rf dist")).toBe(true);
      expect(__test__.isDangerous("migrate:reset")).toBe(true);
    });

    it("does not flag normal scripts", () => {
      expect(__test__.isDangerous("build", "tsc -p .")).toBe(false);
      expect(__test__.isDangerous("test", "vitest run")).toBe(false);
    });
  });

  describe("formatWhen", () => {
    it("returns 'never' when no timestamp", () => {
      expect(__test__.formatWhen(undefined)).toBe("never");
    });

    it("formats seconds/minutes/hours/days", () => {
      const now = Date.now();
      expect(__test__.formatWhen(now - 5_000)).toMatch(/s ago$/);
      expect(__test__.formatWhen(now - 120_000)).toMatch(/m ago$/);
      expect(__test__.formatWhen(now - 3_600_000)).toMatch(/h ago$/);
      expect(__test__.formatWhen(now - 3 * 24 * 3_600_000)).toMatch(/d ago$/);
    });
  });

  describe("buildRunCommand / buildDebugCommand", () => {
    it("buildRunCommand uses correct package manager format", () => {
      expect(__test__.buildRunCommand("npm", "build")).toBe("npm run build");
      expect(__test__.buildRunCommand("yarn", "build")).toBe("yarn build");
      expect(__test__.buildRunCommand("pnpm", "build")).toBe("pnpm build");
    });

    it("buildDebugCommand adds NODE_OPTIONS prefix", () => {
      const cmd = __test__.buildDebugCommand("npm", "dev");
      expect(cmd).toContain("inspect-brk");
      expect(cmd).toContain("npm run dev");
    });
  });

  describe("findScriptKeyLine", () => {
    it("returns correct line for script key", () => {
      const txt = [
        "{",
        '  "scripts": {',
        '    "build": "tsc -p .",',
        '    "test": "vitest"',
        "  }",
        "}",
      ].join("\n");

      expect(__test__.findScriptKeyLine(txt, "build")).toBe(2);
      expect(__test__.findScriptKeyLine(txt, "test")).toBe(3);
      expect(__test__.findScriptKeyLine(txt, "missing")).toBeUndefined();
    });
  });

  describe("confirmDanger", () => {
    it("returns true when dangerConfirm disabled", async () => {
      (vscode as any).__setConfig("npmPlay.dangerConfirm", false);
      const ok = await __test__.confirmDanger("clean");
      expect(ok).toBe(true);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("shows modal and returns true only when user picks Run", async () => {
      (vscode as any).__setConfig("npmPlay.dangerConfirm", true);
      (vscode.window.showWarningMessage as any).mockResolvedValueOnce("Run");
      const ok = await __test__.confirmDanger("clean");
      expect(ok).toBe(true);

      (vscode.window.showWarningMessage as any).mockResolvedValueOnce("Cancel");
      const ok2 = await __test__.confirmDanger("clean");
      expect(ok2).toBe(false);
    });
  });

  describe("formatDuration", () => {
    it("formats milliseconds below 1s", () => {
      expect(__test__.formatDuration(500)).toBe("500ms");
    });

    it("formats seconds with one decimal", () => {
      expect(__test__.formatDuration(3500)).toBe("3.5s");
    });

    it("formats minutes and seconds", () => {
      expect(__test__.formatDuration(90_000)).toBe("1m 30s");
      expect(__test__.formatDuration(60_000)).toBe("1m");
    });
  });

  describe("pruneStatsMap", () => {
    it("removes entries older than 30 days", () => {
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const map: any = {
        "a::build": { running: false, runCount: 1, lastRunAt: old },
        "a::test": { running: false, runCount: 1, lastRunAt: Date.now() },
      };
      const pruned = __test__.pruneStatsMap(map);
      expect(pruned["a::build"]).toBeUndefined();
      expect(pruned["a::test"]).toBeDefined();
    });

    it("keeps entries with no lastRunAt (never run externally)", () => {
      const map: any = {
        "a::build": { running: false, runCount: 0 },
      };
      const pruned = __test__.pruneStatsMap(map);
      expect(pruned["a::build"]).toBeDefined();
    });
  });

  describe("loadPinnedSet / savePinnedSet", () => {
    it("returns empty set when nothing stored", () => {
      const fakeCtx = {
        workspaceState: {
          get: vi.fn((_k: string, def: any) => def),
          update: vi.fn(),
        },
      } as any;
      const set = __test__.loadPinnedSet(fakeCtx);
      expect(set.size).toBe(0);
    });

    it("round-trips pinned keys", async () => {
      const store = new Map<string, any>();
      const fakeCtx = {
        workspaceState: {
          get: vi.fn((k: string, def: any) => store.get(k) ?? def),
          update: vi.fn(async (k: string, v: any) => { store.set(k, v); }),
        },
      } as any;

      const set = new Set(["/repo::build", "/repo::test"]);
      await __test__.savePinnedSet(fakeCtx, set);
      const loaded = __test__.loadPinnedSet(fakeCtx);
      expect(loaded.has("/repo::build")).toBe(true);
      expect(loaded.has("/repo::test")).toBe(true);
      expect(loaded.size).toBe(2);
    });
  });

  describe("ScriptHistoryProvider", () => {
    it("returns items sorted by lastRunAt descending", () => {
      const now = Date.now();
      const fakeCtx = {
        workspaceState: {
          get: vi.fn((_k: string, def: any) => ({
            "/repo::build": { running: false, runCount: 2, lastRunAt: now - 5000, lastExitCode: 0 },
            "/repo::test": { running: false, runCount: 1, lastRunAt: now - 1000, lastExitCode: 1 },
          })),
        },
      } as any;

      const hp = new __test__.ScriptHistoryProvider();
      hp.setContext(fakeCtx);
      const children = hp.getChildren();

      expect(children.length).toBe(2);
      // test ran more recently so should be first
      expect(children[0].scriptName).toBe("test");
      expect(children[1].scriptName).toBe("build");
    });

    it("excludes scripts that have never run", () => {
      const fakeCtx = {
        workspaceState: {
          get: vi.fn((_k: string, def: any) => ({
            "/repo::build": { running: false, runCount: 0 }, // no lastRunAt
          })),
        },
      } as any;

      const hp = new __test__.ScriptHistoryProvider();
      hp.setContext(fakeCtx);
      expect(hp.getChildren().length).toBe(0);
    });
  });

  describe("CodeLens provider", () => {
    it("creates lenses for each script and includes badge based on status map", () => {
      // mock package.json content
      (fs.readFileSync as any).mockReturnValueOnce(
        JSON.stringify({ scripts: { build: "tsc -p .", test: "vitest" } })
      );

      const provider = new __test__.PackageJsonScriptsCodeLensProvider();

      const fakeContext = {
        workspaceState: {
          get: vi.fn((_k: string, def: any) => ({
            "/repo::build": { running: false, runCount: 1, lastExitCode: 0, lastRunAt: Date.now() - 1000 },
            "/repo::test": { running: true, runCount: 3, lastRunAt: Date.now() - 1000 },
          })),
          update: vi.fn(),
        },
      } as any;

      provider.setContext(fakeContext);

      const document = {
        uri: { fsPath: "/repo/package.json", toString: () => "file:///repo/package.json" },
        getText: () =>
          [
            "{",
            '  "scripts": {',
            '    "build": "tsc -p .",',
            '    "test": "vitest"',
            "  }",
            "}",
          ].join("\n"),
      } as any;

      const token = { isCancellationRequested: false } as any;

      (vscode as any).__setConfig("npmPlay.showDebugLens", false);

      const lenses = provider.provideCodeLenses(document, token);

      expect(lenses.length).toBe(2);

      const titles = lenses.map((l: any) => l.command?.title);
      // build should have ✔, test should have ●
      // duration suffix may or may not appear (no lastDurationMs in this fixture → no suffix)
      expect(titles.find((t: string) => t.includes("build"))).toContain("✔");
      expect(titles.find((t: string) => t.includes("test"))).toContain("●");

      // With lastDurationMs set, duration appears in the title
      const fakeCtxWithDuration = {
        workspaceState: {
          get: vi.fn((_k: string, def: any) => ({
            "/repo::build": { running: false, runCount: 1, lastExitCode: 0, lastRunAt: Date.now() - 1000, lastDurationMs: 3500 },
          })),
          update: vi.fn(),
        },
      } as any;
      provider.setContext(fakeCtxWithDuration);
      (fs.readFileSync as any).mockReturnValueOnce(
        JSON.stringify({ scripts: { build: "tsc -p ." } })
      );
      const lenses2 = provider.provideCodeLenses(document, token);
      expect(lenses2[0].command?.title).toContain("3.5s");
    });
  });
});
