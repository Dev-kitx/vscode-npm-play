# 🚀 npm-play — Run npm scripts like a pro

**npm-play** is a lightweight VS Code extension that lets you run, debug, and monitor
`package.json` scripts directly from the editor — with zero config and zero friction.

Think of it as **npm scripts, but actually pleasant**.

---

## ✨ Features

### ▶ Run scripts inline (CodeLens)

- Every script in `package.json` gets a **▶ Run** button
- No terminal typing
- No argument prompts
- Just click and go

---

### 🟢 Script status badges

Each script shows a live status badge:

| Badge | Meaning            |
|-------|--------------------|
| ●     | Running            |
| ✔     | Last run succeeded |
| ✖     | Last run failed    |

Hover over a script to see:
# 🚀 npm-play — Run npm scripts like a pro

**npm-play** is a lightweight VS Code extension that lets you run, debug, and monitor
`package.json` scripts directly from the editor — with zero config and zero friction.

Think of it as **npm scripts, but actually pleasant**.

---

## ✨ Features

### ▶ Run scripts inline (CodeLens)

- Every script in `package.json` gets a **▶ Run** button
- No terminal typing
- No argument prompts
- Just click and go

---

### 🟢 Script status badges

Each script shows a live status badge:

| Badge | Meaning            |
|-------|--------------------|
| ●     | Running            |
| ✔     | Last run succeeded |
| ✖     | Last run failed    |

Hover over a script to see:

- Last run time
- Run count
- Exit status

---

### 🧭 Script launcher (Command Palette)

Run scripts across your workspace:

Open the Command Palette and run: `npm-play: Run Script`

- Finds all `package.json` files
- Works great in monorepos
- Fast fuzzy search

---

### 🐞 Debug scripts

Optional **Debug** CodeLens:

- Runs scripts with `NODE_OPTIONS=--inspect-brk`
- Best-effort debugging (works when the script runs Node)

Enable via settings.

---

### 🛑 Danger-zone protection

Scripts that look destructive (e.g. `clean`, `rm`, `reset`, `prune`) trigger a confirmation dialog before running.

You stay safe without being slowed down.

---

### 📊 Run statistics (just for fun)

npm-play tracks per script:

- Run count
- Last run time
- Last exit code

Stored in workspace state — nothing global.

---

### 📍 Status bar launcher

Quick access from the status bar (configurable):

npm-play ▶

---

## ⚙️ Configuration

All settings are optional. Defaults work out of the box.

Open: Settings → Extensions → npm-play

Or edit `.vscode/settings.json`.

### Available settings

```json
{
  "npmPlay.packageManager": "auto",
  "npmPlay.showDebugLens": false,
  "npmPlay.enableStatusBar": true,
  "npmPlay.statusBarText": "npm-play ▶",
  "npmPlay.dangerConfirm": true,
  "npmPlay.terminalPerScript": true
}
```

### Setting details

| Setting | Description |
|---|---|
| `npmPlay.packageManager` | `auto`, `npm`, `yarn`, or `pnpm` |
| `npmPlay.showDebugLens` | Show 🐞 Debug next to scripts |
| `npmPlay.enableStatusBar` | Toggle status bar launcher |
| `npmPlay.statusBarText` | Customize status bar text |
| `npmPlay.dangerConfirm` | Confirm destructive scripts |
| `npmPlay.terminalPerScript` | Dedicated terminal per script |

### 🧠 Smart package manager detection

When set to `auto`, npm-play detects the package manager based on lock files:

- `pnpm-lock.yaml` → `pnpm`
- `yarn.lock` → `yarn`
- `package-lock.json` → `npm`

### 🚫 What npm-play intentionally does NOT do

- ❌ No argument prompts
- ❌ No task configuration required
- ❌ No background daemons
- ❌ No telemetry
- ❌ No magic config files

Fast. Predictable. Explicit.

### 🧩 Perfect for

- Monorepos
- Frontend + backend projects
- Open source maintainers
- Anyone tired of retyping `npm run build`

### 🛠 Development

```bash
npm install
npm run build
npm test
```

>[!NOTE]
> Bundled with esbuild, tested with Vitest.
