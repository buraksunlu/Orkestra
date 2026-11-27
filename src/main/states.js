'use strict';
// Session state machine. Pure: takes the current session fields and one event, returns the changed fields.
//
// States:
//   idle     - open, nothing to look at
//   running  - Claude is working on a prompt. Also when Claude ended its turn but background work it started
//              (a run_in_background shell, a background agent) is still going: Claude Code wakes Claude up again
//              when that work ends, so the job is not finished. `bg` then lists that work.
//   done     - Claude finished; the user has not looked yet (green glow)
//   ask      - Claude waits on a permission prompt or its own question dialog (orange glow)
//   exited   - the claude process ended
//
// Events come from Claude Code hooks (prompt, posttool, stop, notify, askq), from the UI (ack, input, deny)
// and from the pty (spawn, exit).

const WAITING = new Set(['done', 'ask']);
const FINISHED_TASK = new Set(['completed', 'failed', 'killed', 'stopped', 'error', 'cancelled']);

// The Stop hook's `background_tasks` ([{ id, type, status, description, command }]) cut down to the ones
// still going. Unknown statuses count as going: better a late green glow than a false one.
function liveTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && !FINISHED_TASK.has(String(t.status || '').toLowerCase()))
    .map((t) => ({ type: t.type || 'task', description: t.description || t.command || '' }));
}

function transition(s, ev, now = Date.now()) {
  switch (ev.type) {
    case 'spawn':
      return { state: 'idle', since: now, askMsg: null, askKind: null, exitCode: null, bg: null };
    case 'prompt':
      // Background work ending wakes Claude with a prompt of its own: same job, keep the clock running.
      return { state: 'running', since: s.state === 'running' && s.bg ? s.since : now, askMsg: null, askKind: null, bg: null };
    case 'posttool':
      // A tool ran after a permission prompt or a question dialog was answered: Claude is working again.
      if (s.state === 'ask') return { state: 'running', since: s.runningSince || now, askMsg: null, askKind: null };
      return null;
    case 'stop': {
      if (s.state === 'exited') return null;
      const bg = liveTasks(ev.tasks);
      if (bg.length) return { state: 'running', since: s.state === 'running' ? s.since || now : now, askMsg: null, askKind: null, bg };
      return { state: 'done', since: now, askMsg: null, askKind: null, bg: null };
    }
    case 'notify':
    case 'askq':
      // askKind: 'permission' (Claude Code's allow/deny dialog) or 'question' (Claude's own multiple-choice
      // question). Only a permission dialog may be answered from outside the pane.
      if (s.state === 'exited') return null;
      return {
        state: 'ask',
        since: now,
        askMsg: ev.message || null,
        askKind: ev.type === 'askq' ? 'question' : ev.askKind || 'permission',
        bg: null,
      };
    case 'deny':
      // Esc on a prompt: Claude Code interrupts the turn and sends no Stop hook. Without this the session
      // would look busy forever.
      if (s.state === 'ask') return { state: 'idle', since: now, askMsg: null, askKind: null };
      return null;
    case 'settle':
      // A slash command that sent no hook at all (most built-in commands): Claude is not working.
      if (s.state === 'running' && !s.bg) return { state: 'idle', since: now };
      return null;
    case 'ack':
      // The user clicked or focused the pane: a finished session stops glowing. A waiting prompt keeps glowing.
      if (s.state === 'done') return { state: 'idle', since: now };
      return null;
    case 'input':
      // The user typed into the pane.
      if (s.state === 'done') return { state: 'idle', since: now };
      // Answering a prompt (approve or deny). posttool or stop will correct this if needed.
      if (s.state === 'ask') return { state: 'running', since: now, askMsg: null, askKind: null };
      return null;
    case 'exit':
      return { state: 'exited', since: now, askMsg: null, askKind: null, exitCode: ev.code ?? null, bg: null };
    default:
      return null;
  }
}

function isWaiting(state) {
  return WAITING.has(state);
}

// Order for the "next waiting" shortcut: prompts first, then finished ones; oldest first in each group.
function nextWaiting(sessions, currentId) {
  const waiting = sessions.filter((s) => isWaiting(s.state));
  waiting.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'ask' ? -1 : 1;
    return a.since - b.since;
  });
  if (waiting.length === 0) return null;
  const others = waiting.filter((s) => s.id !== currentId);
  return (others[0] || waiting[0]).id;
}

module.exports = { transition, isWaiting, nextWaiting, liveTasks };
