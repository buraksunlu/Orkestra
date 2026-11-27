# Orkestra 🎼

A macOS desktop app that runs several [Claude Code](https://claude.com/claude-code) sessions in a single window.

## Why

Once you have 3-4 Claude Code sessions going, each one lives in its own terminal window. You hop between windows to find out which one finished, which one is waiting for a permission, and how much of your usage limit is left — and every window repeats the same status line at the bottom.

Orkestra puts it all on one screen:

- **Left:** every session, with project, branch, changed-file count and state.
- **Right:** the 1-6 sessions you pick, as real Claude Code terminals split side by side and stacked.
- **Bottom:** one shared bar for account-wide info — 5h / 7d limits, total cost, clock.
- **Glow and notifications:** a finished session glows green, one that needs you glows orange. You see what needs attention without reading anything.

It runs only on your own Mac, with your own `claude` install. It never touches `~/.claude/settings.json` or your status line script; each session is started with its own `--settings`.

## Requirements

- macOS (the packaged app targets Apple Silicon)
- Node.js 22 and npm
- The `claude` command (Claude Code), installed and logged in

## Install

```bash
git clone https://github.com/buraksunlu/Orkestra.git
cd Orkestra
npm install
npm start              # run in development mode
npm run install-app    # or build, ad-hoc sign and install to /Applications/Orkestra.app
```

`install-app` signs the app ad hoc, so no Apple developer account is needed. To update, quit Orkestra and run it again.

## Quick start

1. Open Orkestra and press **⌘N** to start a session: pick a project (new conversation, worktree, or resume an old one).
2. Start a few more and place them on the right by clicking or dragging them from the list.
3. Work on something else. When a session finishes or asks for permission you get a Mac notification and a Dock badge.
4. Press **⌘J** to jump to the next session waiting for you. Approve or reject permissions right from its row with ✓ / ✕.
5. Happy with the layout? Save it as a workspace with **⌘⇧S**, bring it back later with **⌘⌥1-9**.

## How it works

- Each pane is a real `claude --session-id <id> --settings <own settings>` process driven through `node-pty` and rendered with `xterm.js`, so Claude Code's full-screen UI works as-is.
- State (done, waiting for permission, background work running, context %, limits) is read from Claude Code's hooks and status line output, which a small script writes into an inbox under `~/Library/Application Support/Orkestra/`.
- Pane layout, workspaces, queues and categories are saved to disk, so you pick up where you left off after a restart.

## Features

- **Glow and notifications.** Green glow: done. Orange glow: waiting for permission or an answer. A Mac notification and Dock badge appear while the app is in the background.
- **Background work awareness.** If Claude ends its turn but a command or agent it started is still running, the session is not "done": a yellow "◌ 1 command running in background" shows (hover for details). When that finishes and Claude completes, you get the green glow and notification.
- **No status line inside sessions.** Orkestra replaces it with the shared bar.
- **Last message.** A finished session's row shows Claude's last message, and so does the notification.
- **Menu bar.** A conductor icon with what is waiting (🟠 permission, 🟢 done) and the 5h limit percentage. Click for sessions and workspaces.
- **Answer permissions in place.** A waiting row shows what is requested (`Bash: npm install …`, `Edit: ~/…/x.js`) with **✓ Approve / ✕ Reject**. Approve picks "1. Yes" in Claude Code's dialog; Reject sends Esc. The buttons only appear while the permission dialog is really on that session's screen and never touch Claude's own multiple-choice questions.
- **Changes view (⌘⇧D).** Click `✏️ N` on a row or pane header to open that session's uncommitted changes (including new files) as a colored diff in its own pane. It refreshes when the session finishes a job or the changed-file count changes. Click a line number (⇧-click for a range), write a comment, press ⌘Enter, and it goes to that session's Claude together with the file, lines and change.
- **Flexible layout.** Up to 6 panes, split horizontally and vertically. Drag the dividers to resize (double-click equalizes the group). Drag a pane by its header onto another pane's **edge** to dock it there, onto its **middle** to swap. Each pane remembers its own font size (⌘+ / ⌘- / ⌘0).
- **Workspaces.** Save what is on screen under a name (⌘⇧S or the ＋ at the top left). Click its chip or press ⌘⌥1-9 to restore all sessions in the saved layout; closed ones resume from where they left off. Right-click to update, rename or delete.
- **Quick switch (⌘K).** Fuzzy-find workspaces, open sessions (name, branch, folder) and projects — typing letters in order is enough. The last row searches all conversations.
- **Queue (⌘⇧L).** Line up jobs for a session; each is sent when Claude finishes the previous one. It waits during permission prompts or when there is unsent text in the input box. Reorder, remove, pause, "send now". The queue survives restarts.
- **Resume after a limit.** When "You've hit your session/weekly limit" appears, the session is marked ⏸ and a "continue where you left off" message is queued, sent automatically a minute after the reset. Can be turned off from the menu bar.
- **Compact (⌘⇧K).** Every pane header shows the context percentage; click it to send `/compact` (queued if Claude is busy). It turns orange / red as context fills up; right-click to set the threshold (30 / 50 / 75 % / off).
- **Reply from a notification.** Answer a "done" notification inline; approve or reject permission notifications with buttons.
- **Prevent sleep.** The Mac stays awake while a session is running or waiting (the display may still sleep). Can be turned off from the menu bar.
- **Search all conversations (⌘⇧F).** Searches your messages and Claude's replies in open and closed conversations; click a result to switch to it or reopen it.
- **Remote Control.** Each pane header has a 📡 button (dim when off, colored with a green dot when on) that runs Claude's `/remote-control` in that session. ⌥-click opens the session on claude.ai. The choice is remembered per project, so new or restored sessions there start connected. ⌘N also has a "Start with Remote Control" option.
- **Projects and categories (⌘N).** Create categories, rename or delete them, move projects by drag and drop or the category picker, edit a project's name and path, add folders from outside `~/Projects`, or remove a project from the list (never deleting the folder). The sidebar groups sessions by category; collapsed groups glow if something inside is done or waiting.
- **Quick session on the Desktop (＋ / ⌘⇧N).** The ＋ next to the session count at the top starts Claude right away in `~/Desktop`, without picking a project.
- **Rename sessions.** Right-click a session in the sidebar, or double-click the name in a pane header, and type a new name (Enter saves, Esc cancels; leave it empty to go back to the folder name). The name is kept across restarts and in workspaces.
- **Drop files and images.** Drag a file (including a screenshot preview) onto a pane to insert its shell-escaped path into the input box; Claude attaches images as `[Image #N]`. Files without a permanent path are copied to `~/Library/Application Support/Orkestra/drops/` (deleted after 7 days). Pasting an image with ⌘V (for example a ⌃⇧⌘4 screenshot) saves it as a PNG in the same folder and inserts its path, so Claude attaches it the same way.
- **Bulk messages (⌘⇧B).** Send one message to the sessions selected with ⌘-click, or to everything on screen.
- **Per-chat model (⌘⇧M).** Change the model and effort of the focused chat only; your Claude settings stay untouched.

## Shortcuts

| Key | Action |
|---|---|
| ⌘N | New session, worktree, or resume an old conversation |
| ⌘⇧N | Quick Claude session on the Desktop (no project) |
| ⌘J | Next session waiting for you (permissions first, then finished) |
| ⌘1-9 | Switch to the session in the list |
| ⌘⇧M | Model and effort of the focused chat |
| ⌘⇧B | Bulk message |
| ⌘⇧D | Changes (diff) of the focused session |
| ⌘⇧L | Queue of the focused session |
| ⌘⇧K | Compact the focused session (`/compact`) |
| ⌘K | Quick switch: workspace, session, project |
| ⌘⇧F | Search all conversations |
| ⌘⇧S / ⌘⌥1-9 | Save the screen as a workspace / open a workspace |
| ⌘W / ⌘⇧W | Remove from screen / close the session |
| ⌘B | Toggle the sidebar |
| ⌘+ / ⌘- / ⌘0 | Font size of the focused pane (terminal or diff) |
| ⇧Enter | New line in Claude |

## Commands

```bash
npm install          # dependencies (node-pty is built for Electron)
npm start            # run in development mode
npm test             # unit tests
npm run e2e          # hook / status line / resume / bulk message test with a real claude (haiku, a few cents)
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/e2e/remote-e2e.js   # Remote Control on/off test
npm run install-app  # package, ad-hoc sign, copy to /Applications/Orkestra.app
npm run icon         # build the app icon and menu bar icon from build/logo-source.jpg
```

Data lives in `~/Library/Application Support/Orkestra/` (`workspace.json`, `hook.sh`, `claude-settings.json`, `inbox/`). While developing, set `ORKESTRA_DATA=/other/folder` to use a separate data directory.

## License

No license has been chosen yet; all rights reserved by default.
