'use strict';
// Everything needed to start `claude` from inside the app: the user's PATH, the claude binary,
// and the per-session settings (a silent status line plus hooks) passed with --settings.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Apps started from the Dock get a bare PATH. Ask the login shell for the real one (nvm, Homebrew...).
function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__ORK__%s__ORK__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__ORK__(.*)__ORK__/s);
    if (m && m[1]) return m[1];
  } catch {}
  return [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')]
    .filter(Boolean)
    .join(':');
}

function findClaude(PATH) {
  for (const dir of PATH.split(':')) {
    if (!dir) continue;
    const p = path.join(dir, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// Runs for the status line and for every hook. Copies Claude Code's JSON into the inbox and prints nothing,
// so the terminal shows no status line and the hooks never change Claude's behaviour.
const HOOK_SCRIPT = `#!/bin/bash
# Orkestra: forwards Claude Code status line and hook JSON to the app. Prints nothing, always exits 0.
kind="$1"
if [ -z "$ORKESTRA_SESSION" ] || [ -z "$ORKESTRA_INBOX" ] || [ ! -d "$ORKESTRA_INBOX" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
tmp="$ORKESTRA_INBOX/.tmp-$$-$RANDOM"
cat > "$tmp" 2>/dev/null || exit 0
ms=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000' 2>/dev/null || echo "$(date +%s)000")
mv "$tmp" "$ORKESTRA_INBOX/\${ms}_$$_\${RANDOM}__\${ORKESTRA_SESSION}__\${kind}.json" 2>/dev/null
exit 0
`;

function q(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSettings(hookPath) {
  const cmd = (kind) => ({ type: 'command', command: `${q(hookPath)} ${kind}` });
  return {
    statusLine: { type: 'command', command: `${q(hookPath)} status`, padding: 0, refreshInterval: 15 },
    hooks: {
      SessionStart: [{ hooks: [cmd('start')] }],
      UserPromptSubmit: [{ hooks: [cmd('prompt')] }],
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [cmd('askq')] }],
      PostToolUse: [{ matcher: '*', hooks: [cmd('posttool')] }],
      // Fires as soon as a tool needs approval, with the tool and its input (the notification only says
      // "Claude needs your permission"). Only remembered: the orange state still waits for the notification.
      PermissionRequest: [{ matcher: '*', hooks: [cmd('permreq')] }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [cmd('notify')] }],
      Stop: [{ hooks: [cmd('stop')] }],
      // A turn that ends on an API error (usage limit, network) sends this instead of Stop.
      StopFailure: [{ hooks: [cmd('stopfail')] }],
      // /compact sends neither UserPromptSubmit nor Stop, only these (trigger: manual | auto).
      PreCompact: [{ hooks: [cmd('precompact')] }],
      PostCompact: [{ hooks: [cmd('postcompact')] }],
    },
  };
}

// Writes the hook script and the settings file into the app's data folder. Returns their paths.
function prepare(dataDir) {
  const hookPath = path.join(dataDir, 'hook.sh');
  const settingsPath = path.join(dataDir, 'claude-settings.json');
  const inboxDir = path.join(dataDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  fs.writeFileSync(settingsPath, JSON.stringify(buildSettings(hookPath), null, 2));
  const PATH = loginShellPath();
  return { hookPath, settingsPath, inboxDir, PATH, claude: findClaude(PATH) };
}

module.exports = { prepare, buildSettings, loginShellPath, findClaude, HOOK_SCRIPT };
