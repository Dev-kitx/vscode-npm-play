# 🚀 npm-play — Run npm scripts like a pro

**npm-play** is a lightweight VS Code extension that lets you run, debug, and monitor
`package.json` scripts directly from the editor — with zero config and zero friction.

Think of it as **npm scripts, but actually pleasant**.

---

## ✨ Features

### ▶ Run scripts inline (CodeLens)

Every script in `package.json` gets a **▶ Run** button above it — no terminal typing, no
argument prompts. Just click and go.

---

### 🟢 Script status badges

Each script shows a live status badge inline, updated after every run:

| Badge | Meaning            |
|-------|--------------------|
| ●     | Currently running  |
| ✔     | Last run succeeded |
| ✖     | Last run failed    |
| ⊘     | Last run cancelled |

Duration is shown alongside the badge when available, e.g. `✔ 3.5s`.

Hover over any script to see a tooltip with:

- Last run time
- Run count
- Exit status
- Duration

---

### 📋 Script history sidebar

A **Script History** panel in the Explorer sidebar shows your 50 most recently run scripts,
sorted by last run time. Each entry displays:

- Status icon (✔ pass / ✖ error / ⊘ cancelled / ● running)
- Script name and duration
- Package folder and relative time

Click any entry to **re-run** the script instantly.

---

### ⭐ Favorite scripts (pin / unpin)

Pin your most-used scripts so they always appear at the top of the launcher.

Open the Command Palette and run: **Devkitx: Pin / Unpin Script**

- `⭐` marks currently pinned scripts
- `☆` marks unpinned scripts
- Pinned scripts appear in a dedicated **Pinned** section at the top of the launcher
- Pins are saved per workspace

---

### 🧭 Script launcher

Search and run scripts across your entire workspace from a single quick-pick.

Open the Command Palette and run: **Devkitx: Script Launcher**

- Scripts are **grouped by package** with separators showing the package name
- Pinned scripts float to the top in their own section
- Works great in monorepos
- Fast fuzzy search across script names and commands

---

### 🔔 Long-run notifications

Optionally get a notification when a slow script finishes (useful for builds running in the
background). Set `npmPlay.notifyAfterMs` to the threshold in milliseconds.

Example — notify after 10 seconds:

```json
"npmPlay.notifyAfterMs": 10000
```

The notification shows the script name, result badge, and how long it took.
Set to `0` (default) to disable.

---

### 🐞 Debug scripts

Enable an optional **🐞 Debug** CodeLens next to each script:

- Runs scripts with `NODE_OPTIONS=--inspect-brk`
- Best-effort debugging — works when the script runs Node directly

Enable via `npmPlay.showDebugLens: true`.

---

### 🛑 Danger-zone protection

Scripts that look destructive (e.g. `clean`, `rm`, `reset`, `prune`, `drop`) trigger a
confirmation dialog before running. Configurable via `npmPlay.dangerConfirm`.

---

### 📍 Status bar launcher

A quick-access launcher button in the status bar (configurable text and visibility).

---

### 🧠 Smart package manager detection

When set to `auto`, npm-play detects your package manager from lock files:

- `pnpm-lock.yaml` → `pnpm`
- `yarn.lock` → `yarn`
- `package-lock.json` → `npm`

If multiple lock files are detected in the same folder, npm-play warns you and tells you
which one it picked.

---

## ⚙️ Configuration

All settings are optional. Defaults work out of the box.

Open: **Settings → Extensions → Devkitx Script Runner**  
Or edit `.vscode/settings.json` directly.

```json
{
  "npmPlay.packageManager": "auto",
  "npmPlay.showDebugLens": false,
  "npmPlay.enableStatusBar": true,
  "npmPlay.statusBarText": "npm-play ▶",
  "npmPlay.dangerConfirm": true,
  "npmPlay.terminalPerScript": true,
  "npmPlay.notifyAfterMs": 0
}
```

### Setting details

| Setting | Default | Description |
|---------|---------|-------------|
| `npmPlay.packageManager` | `"auto"` | `auto`, `npm`, `yarn`, or `pnpm` |
| `npmPlay.showDebugLens` | `false` | Show 🐞 Debug CodeLens next to scripts |
| `npmPlay.enableStatusBar` | `true` | Show the status bar launcher |
| `npmPlay.statusBarText` | `"npm-play ▶"` | Customize the status bar label |
| `npmPlay.dangerConfirm` | `true` | Ask before running destructive scripts |
| `npmPlay.terminalPerScript` | `true` | Use a dedicated terminal per script |
| `npmPlay.notifyAfterMs` | `0` | Notify when a script takes longer than N ms (0 = off) |

---

## 🚫 What npm-play intentionally does NOT do

- ❌ No argument prompts
- ❌ No task configuration required
- ❌ No background daemons
- ❌ No telemetry
- ❌ No magic config files

Fast. Predictable. Explicit.

---

## 🧩 Perfect for

- Monorepos with multiple packages
- Frontend + backend projects
- Open source maintainers
- Anyone tired of retyping `npm run build`

---

## 🛠 Development

```bash
npm install
npm run bundle       # production build
npm run bundle:watch # rebuild on save
npm test             # unit tests (Vitest)
npm run typecheck    # TypeScript check without emit
```

> [!NOTE]
> Bundled with esbuild, tested with Vitest. Reload the Extension Host after rebuilding
> (`Developer: Restart Extension Host` in the Command Palette).
