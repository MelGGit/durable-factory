import { spawn, execFile } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { defineDoc, type Harness } from '@earendil-works/pi-durable';
import type { JsonRepresentation } from '@earendil-works/chord';
import { context } from './storage.js';

export interface ProcessIdentity {
  pid: number;
  started: string;
}
export interface CommandRecord {
  id: string;
  runId: string;
  attemptId: string;
  command: string;
  state: 'prepared' | 'authorized' | 'finished' | 'uncertain';
  supervisor?: ProcessIdentity;
  descendants: ProcessIdentity[];
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  artifact: string;
  interrupted?: boolean;
}
export const Processes = defineDoc({
  kind: 'factory.processes',
  scope: 'session',
  version: 1,
  initial: () => ({
    records: {} as Record<string, JsonRepresentation<CommandRecord>>,
  }),
  checkpointWhen: () => true,
});
const exec = promisify(execFile);
export async function processTable(owner?: string) {
  const { stdout } = await exec(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    {
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const environments = owner
    ? (
        await exec('ps', ['eww', '-axo', 'pid=,command='], {
          timeout: 3000,
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout
    : '';
  const marked = new Set(
    environments
      .split('\n')
      .filter((line) => line.includes(`DURABLE_FACTORY_PROCESS_OWNER=${owner}`))
      .map((line) => Number(line.trim().split(/\s+/)[0])),
  );
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw new Error('Cannot inspect process identity');
      return {
        marked: marked.has(Number(match[1])),
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        started: match[5],
        zombie: match[4].includes('Z'),
      };
    });
}
// The supervisor cannot execute anything until durable authorization reaches its IPC channel.
// Disconnect is fail-closed: terminate its process group and all observed descendants.
const supervisorSource = String.raw`
const { spawn, execFileSync } = require('node:child_process');
let authorized = false, stopping = false, child, code, timer, owner;
const known = new Map();
function emit(message, done) {if(!process.connected)return;try{process.send(message,()=>done?.());}catch{}}
process.on('SIGTERM', () => {});
function scan() {
  const lines = execFileSync('ps', ['-axo','pid=,ppid=,pgid=,stat=,lstart='], {encoding:'utf8', timeout:2000}).trim().split('\n');
  const marked = new Set(owner ? execFileSync('ps',['eww','-axo','pid=,command='],{encoding:'utf8',timeout:2000,maxBuffer:32*1024*1024}).split('\n').filter(l=>l.includes('DURABLE_FACTORY_PROCESS_OWNER='+owner)).map(l=>+l.trim().split(/\s+/)[0]) : []);
  const rows = lines.map(l => {const m=l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/); if(!m)throw Error('inspection'); return {pid:+m[1],parent:+m[2],group:+m[3],started:m[5],zombie:m[4].includes('Z')};});
  let changed=true; while(changed) {changed=false; for(const p of rows) if(p.pid!==process.pid && !known.has(p.pid) && (marked.has(p.pid) || p.group===process.pid || p.parent===process.pid || known.has(p.parent))) {known.set(p.pid,p); changed=true;}}
  return rows.filter(p=> {if(p.zombie || p.pid===process.pid || !(p.group===process.pid || known.get(p.pid)?.started===p.started))return false;try{process.kill(p.pid,0);return true;}catch{return false;}});
}
function killAll(signal) { let rows; try { rows=scan(); } catch { return false; } for(const p of rows) try {process.kill(p.pid,signal);}catch(e){if(e.code!=='ESRCH')return false;} return true; }
function stop() { if(stopping)return; stopping=true; killAll('SIGTERM'); try{process.kill(-process.pid,'SIGTERM');}catch{} setTimeout(()=>{killAll('SIGKILL');try{process.kill(-process.pid,'SIGKILL');}catch{}},250); }
process.on('disconnect',stop);
process.on('message',msg=>{
 if(msg.type==='stop') {stop();return;}
 if(msg.type!=='authorize'||authorized||stopping)return;
 authorized=true;owner=msg.owner;
 child=spawn(msg.executable,msg.args,{cwd:msg.cwd,env:{...msg.env,DURABLE_FACTORY_PROCESS_OWNER:owner},stdio:['ignore','pipe','pipe']});
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',b=>emit({type:'output',text:b.toString()}));
 child.stderr.on('data',b=>emit({type:'output',text:b.toString()}));
 child.on('error',()=>{code=127;stop();});
 child.on('exit',c=>{code=c??1;});
 timer=setInterval(()=>{
  try {
   const remaining=scan(); emit({type:'inventory',processes:[...known.values()]});
   if(code!==undefined) {
    if(remaining.length) {stop();return;}
    clearInterval(timer); emit({type:'finished',code,interrupted:stopping},()=>process.exit(0));
   }
  } catch { stop(); emit({type:'uncertain'}); }
 },100);
});
emit({type:'ready'});
setTimeout(()=>{if(!authorized)process.exit(0);},10000).unref();
`;
export class ProcessSupervisor {
  private active = new Map<
    string,
    { stop: () => void; settled: Promise<void> }
  >();
  constructor(
    private harness: Harness,
    private dataDir: string,
  ) {}
  async records(runId?: string) {
    const doc = await this.harness.snapshot(Processes, context);
    return Object.values(doc?.records ?? {}).filter(
      (r) => !runId || r.runId === runId,
    ) as CommandRecord[];
  }
  private async save(record: CommandRecord) {
    await this.harness.commit(async (tx) => {
      (await tx.doc(Processes)).records[record.id] = structuredClone(
        record,
      ) as JsonRepresentation<CommandRecord>;
    }, context);
  }
  async run(options: {
    id: string;
    runId: string;
    attemptId: string;
    cwd: string;
    command: string;
    timeout: number;
    cancellation: number;
    signal?: AbortSignal;
    executable?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    output?: (text: string) => void;
  }) {
    const previous = (await this.records()).find((r) => r.id === options.id);
    if (previous) {
      if (previous.state === 'finished' && !previous.interrupted)
        return previous;
      throw new Error(
        'Interrupted command requires inspection; it will not be replayed.',
      );
    }
    options.signal?.throwIfAborted();
    const directory = join(this.dataDir, 'artifacts', 'commands');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact = join(directory, `${options.id}.log`);
    const file = await open(artifact, 'wx', 0o600);
    const record: CommandRecord = {
      id: options.id,
      runId: options.runId,
      attemptId: options.attemptId,
      command: options.command,
      state: 'prepared',
      descendants: [],
      startedAt: Date.now(),
      artifact,
    };
    await this.save(record);
    const child = spawn(process.execPath, ['-e', supervisorSource], {
      detached: true,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let line = Promise.resolve(),
      resolveDone!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let finished = false;
    const stop = () => {
      record.interrupted = true;
      if (child.connected) child.send({ type: 'stop' });
    };
    this.active.set(record.id, { stop, settled });
    const deadline = setTimeout(stop, options.timeout * 1000);
    options.signal?.addEventListener('abort', stop, { once: true });
    const hardStop = setInterval(
      () => {
        if (record.interrupted && child.connected) child.send({ type: 'stop' });
      },
      Math.max(100, options.cancellation * 1000),
    );
    child.on('message', (message: any) => {
      line = line
        .then(async () => {
          if (message.type === 'ready') {
            const identity = (await processTable()).find(
              (p) => p.pid === child.pid,
            );
            if (!identity) throw new Error('Supervisor identity unavailable');
            record.supervisor = {
              pid: identity.pid,
              started: identity.started,
            };
            record.state = 'authorized';
            await this.save(record);
            options.signal?.throwIfAborted();
            child.send({
              type: 'authorize',
              owner: record.id,
              executable: options.executable ?? '/bin/sh',
              args: options.args ?? ['-c', options.command],
              cwd: options.cwd,
              env: options.env ?? {
                PATH: process.env.PATH,
                LANG: 'C.UTF-8',
                HOME: process.env.HOME,
                GIT_TERMINAL_PROMPT: '0',
              },
            });
          } else if (message.type === 'output') {
            await file.write(String(message.text));
            options.output?.(String(message.text));
          } else if (message.type === 'inventory') {
            record.descendants = message.processes;
            await this.save(record);
          } else if (message.type === 'finished') {
            finished = true;
            record.state = 'finished';
            record.exitCode = message.code;
            record.finishedAt = Date.now();
            record.interrupted ||= message.interrupted;
            await this.save(record);
          } else if (message.type === 'uncertain') {
            record.state = 'uncertain';
            await this.save(record);
            stop();
          }
        })
        .catch(async () => {
          record.state = 'uncertain';
          stop();
          try {
            await this.save(record);
          } catch {}
        });
    });
    child.on('error', () => {
      record.state = 'uncertain';
    });
    child.on('close', () => {
      void line.finally(resolveDone);
    });
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          const watch = setInterval(() => {
            if (record.interrupted) {
              clearInterval(watch);
              setTimeout(resolve, options.cancellation * 1000);
            }
          }, 50);
          settled.finally(() => clearInterval(watch));
        }),
      ]);
      await line;
      if (!finished) {
        record.state = 'uncertain';
        await this.save(record);
      }
      if (record.state !== 'finished' || record.interrupted)
        throw new Error(
          'Command interrupted; reconcile termination before continuing.',
        );
      return record;
    } finally {
      clearTimeout(deadline);
      clearInterval(hardStop);
      options.signal?.removeEventListener('abort', stop);
      await file.close();
      this.active.delete(record.id);
    }
  }
  async quiescent(runId: string) {
    if ([...this.active.keys()].some((id) => id.startsWith(`${runId}-`)))
      return false;
    const records = await this.records(runId);
    for (const r of records) {
      const rows = (await processTable(r.id)).filter((p) => !p.zombie);
      if (r.state === 'prepared' && !r.supervisor) return false;
      const owned = [...(r.supervisor ? [r.supervisor] : []), ...r.descendants];
      if (
        owned.some((p) =>
          rows.some((live) => live.pid === p.pid && live.started === p.started),
        )
      )
        return false;
      if (
        rows.some(
          (p) => p.marked || (r.supervisor && p.group === r.supervisor.pid),
        )
      )
        return false;
      // Unknown launch state cannot be cleared by an empty PID search.
      if (!r.supervisor && r.state !== 'finished') return false;
    }
    return true;
  }
  async cancel(runId: string, milliseconds: number) {
    for (const [id, active] of this.active)
      if (id.startsWith(`${runId}-`)) active.stop();
    const records = await this.records(runId);
    for (const r of records) {
      if (!r.supervisor && !this.active.has(r.id)) {
        r.state = 'finished';
        r.interrupted = true;
        r.exitCode = -1;
        r.finishedAt = Date.now();
        await this.save(r);
        continue;
      }
      const table = (await processTable(r.id)).filter((p) => !p.zombie);
      for (const p of table.filter((p) => p.marked))
        if (
          !r.descendants.some((d) => d.pid === p.pid && d.started === p.started)
        )
          r.descendants.push({ pid: p.pid, started: p.started });
      await this.save(r);
      for (const p of [
        ...(r.supervisor ? [r.supervisor] : []),
        ...r.descendants,
      ]) {
        if (
          table.some((row) => row.pid === p.pid && row.started === p.started)
        ) {
          try {
            if (p.pid === r.supervisor?.pid) process.kill(-p.pid, 'SIGTERM');
            else process.kill(p.pid, 'SIGTERM');
          } catch {}
        }
      }
    }
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      if (await this.quiescent(runId)) return true;
      await delay(50);
    }
    const latest = (await processTable()).filter((p) => !p.zombie);
    for (const r of records)
      for (const p of [
        ...(r.supervisor ? [r.supervisor] : []),
        ...r.descendants,
      ]) {
        if (
          latest.some((row) => row.pid === p.pid && row.started === p.started)
        )
          try {
            process.kill(
              p.pid === r.supervisor?.pid ? -p.pid : p.pid,
              'SIGKILL',
            );
          } catch {}
      }
    return this.quiescent(runId);
  }
  async output(record: CommandRecord) {
    return readFile(record.artifact, 'utf8');
  }
}
