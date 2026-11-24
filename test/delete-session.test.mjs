/**
 * dsh-delete-sessions：删除流程的回归测试（node --test）。
 *
 * 重点是「活会话注销」这条路径——早先的实现只 `workspace/session-stop`
 * （取消当前回合）就删文件，会话仍留在 sessions store 里，下一次 append/flush
 * 会把日志目录写回来，于是列表里那一行重新出现。这组用例锁住：
 *   1) 冷会话（不在 store 里）：直接删目录，不碰 flush/detach；
 *   2) 活会话 + agent 有处置面：cancel({kind:'disposed'}) → whenIdle → flush → 双 detach → 删目录；
 *   3) 活会话停不下来（whenIdle 拒绝）：明确失败且**不删目录**；
 *   4) 活会话但没有 agent（无处置面）：仍 flush + detach 会话、删目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteSession } from '../lib/index.js';

const SID = 'session-11111111-2222-3333-4444-555555555555';

/** 造一个带日志文件的会话目录，返回 { root, logPath, projectDir }。 */
async function makeSessionDir() {
  const root = await mkdtemp(join(tmpdir(), 'del-sess-'));
  const projectDir = join(root, '--data-demo--');
  const sessionDir = join(projectDir, SID);
  await mkdir(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd');
  await writeFile(logPath, 'x');
  return { root, projectDir, sessionDir, logPath };
}

/** 组装一个只实现本插件用到的那几个面子的假 ctx。 */
function makeCtx({ live, agent, locate, detachedSessions, detachedAgents, calls }) {
  const sessionEntry = { detach: () => detachedSessions.push(SID) };
  const agentEntry = { id: SID };
  const agents = {
    get: () => agent,
    store: new Map(agent === undefined ? [] : [[SID, agentEntry]]),
    detachEntered: (entry) => detachedAgents.push(entry.id),
  };
  const sessions = {
    get: () => live,
    flush: async () => calls.push('flush'),
    store: new Map(live === undefined ? [] : [[SID, sessionEntry]]),
  };
  const registry = {
    list: () => [],
    unarchiveSession: async () => {},
    unpinSession: async () => {},
  };
  return {
    sessions,
    workspaceRegistry: registry,
    sessionPersistence: {
      stat: async () => ({ header: { id: SID, cwd: '/data/demo' } }),
      locate: () => locate,
    },
    get: (name) => (name === 'agents' ? agents : undefined),
    parallel: async () => [],
    emit: (event, id) => calls.push(`${event}:${id}`),
  };
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test('冷会话：直接删目录，不碰 flush/detach', async () => {
  const { root, sessionDir, logPath } = await makeSessionDir();
  const calls = [];
  const detachedSessions = [];
  const detachedAgents = [];
  const ctx = makeCtx({
    live: undefined,
    agent: undefined,
    locate: { path: logPath },
    detachedSessions,
    detachedAgents,
    calls,
  });

  const result = await deleteSession(ctx, SID);

  assert.deepEqual(result, { ok: true });
  assert.equal(await exists(sessionDir), false, '日志目录应被删除');
  assert.deepEqual(calls.filter((c) => c === 'flush'), [], '冷会话不应 flush');
  assert.deepEqual(detachedSessions, [], '冷会话不应 detach session');
  assert.deepEqual(detachedAgents, [], '冷会话不应 detach agent');
  assert.ok(calls.includes(`api-session/removed:${SID}`), '应广播 removed');
  await rm(root, { recursive: true, force: true });
});

test('活会话 + 有处置面：disposed → whenIdle → flush → 双 detach → 删目录', async () => {
  const { root, sessionDir, logPath } = await makeSessionDir();
  const calls = [];
  const detachedSessions = [];
  const detachedAgents = [];
  const live = { id: SID };
  const agent = {
    cancel: (arg) => calls.push(`cancel:${arg?.kind ?? 'none'}`),
    whenIdle: async () => calls.push('whenIdle'),
  };
  const ctx = makeCtx({
    live,
    agent,
    locate: { path: logPath },
    detachedSessions,
    detachedAgents,
    calls,
  });

  const result = await deleteSession(ctx, SID);

  assert.deepEqual(result, { ok: true });
  assert.ok(calls.includes('cancel:disposed'), '应停用 agent（kind=disposed）');
  assert.ok(calls.indexOf('whenIdle') > calls.indexOf('cancel:disposed'), '应先 cancel 再等 idle');
  assert.ok(calls.indexOf('flush') > calls.indexOf('whenIdle'), '应在 idle 之后 flush');
  assert.deepEqual(detachedSessions, [SID], '应从 sessions store 摘掉');
  assert.deepEqual(detachedAgents, [SID], '应从 agents store 摘掉');
  assert.equal(await exists(sessionDir), false, '注销后应删除日志目录');
  await rm(root, { recursive: true, force: true });
});

test('活会话停不下来：明确失败且不删目录', async () => {
  const { root, sessionDir, logPath } = await makeSessionDir();
  const calls = [];
  const detachedSessions = [];
  const detachedAgents = [];
  const live = { id: SID };
  const agent = {
    cancel: () => calls.push('cancel'),
    whenIdle: async () => {
      throw new Error('agent did not converge');
    },
  };
  const ctx = makeCtx({
    live,
    agent,
    locate: { path: logPath },
    detachedSessions,
    detachedAgents,
    calls,
  });

  const result = await deleteSession(ctx, SID);

  assert.equal(result.ok, false);
  assert.match(result.error, /is live and could not be disposed/);
  assert.match(result.error, /did not converge/);
  assert.equal(await exists(sessionDir), true, '停不下来时日志目录必须保留');
  assert.deepEqual(detachedSessions, [], '不应摘掉还在跑的会话');
  await rm(root, { recursive: true, force: true });
});

test('活会话但没有 agent：仍 flush + detach 会话并删目录', async () => {
  const { root, sessionDir, logPath } = await makeSessionDir();
  const calls = [];
  const detachedSessions = [];
  const detachedAgents = [];
  const live = { id: SID };
  const ctx = makeCtx({
    live,
    agent: undefined,
    locate: { path: logPath },
    detachedSessions,
    detachedAgents,
    calls,
  });

  const result = await deleteSession(ctx, SID);

  assert.deepEqual(result, { ok: true });
  assert.ok(calls.includes('flush'));
  assert.deepEqual(detachedSessions, [SID]);
  assert.deepEqual(detachedAgents, [], '没有 agent 时不应摘 agent');
  assert.equal(await exists(sessionDir), false);
  await rm(root, { recursive: true, force: true });
});
