import { execFileSync } from 'node:child_process'
import { describe, it } from 'vitest'

const fixture = `
import assert from 'node:assert/strict';
import { createOwnedEnvironmentScanner } from './tests/support/process-ownership.mjs';
const nodes = new Map([[10,{parent:1,birth:'10'}],[20,{parent:10,birth:'20'}],[30,{parent:20,birth:'30'}],[40,{parent:1,birth:'40'}]]);
const inspected = [];
const reads = new Map();
let beforeStat = () => {};
const scan = createOwnedEnvironmentScanner({self:10,root:'/fixture',list:()=>[...nodes.keys()].map(String),read:path=>{
  const [, , raw, name] = path.split('/'); const pid = Number(raw);
  if(name==='stat') { const count=(reads.get(pid)||0)+1; reads.set(pid,count); beforeStat(pid,count); }
  const n = nodes.get(pid); if(!n) throw new Error('gone');
  if(name==='environ') { inspected.push(pid); return 'MARKER=owned\\0'; }
  const fields = Array(20).fill('0'); fields[0]='S'; fields[1]=String(n.parent); fields[19]=n.birth;
  return pid+' (a command with ) parentheses) '+fields.join(' ');
}});
`

function check(script: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', fixture + script], { stdio: 'pipe' })
}

describe('test process environment ownership', () => {
  it('reads only descendants, not the harness or unrelated environments', () => {
    check(`assert.deepEqual(scan('MARKER=owned'),[20,30]); assert.deepEqual(inspected,[20,30]);`)
  })
  it('retains known reparented descendants but rejects reused PID identities', () => {
    check(`scan('MARKER=owned'); inspected.length=0; nodes.get(20).parent=1;
      assert.deepEqual(scan('MARKER=owned'),[20,30]);
      nodes.get(20).birth='new'; nodes.get(30).parent=1; nodes.get(30).birth='also-new'; inspected.length=0;
      assert.deepEqual(scan('MARKER=owned'),[]); assert.deepEqual(inspected,[]);`)
  })
  it('rechecks PID birth immediately before reading an environment', () => {
    check(`nodes.delete(30); beforeStat=(pid,count)=>{if(pid===20&&count===2) nodes.get(20).birth='reused';};
      assert.deepEqual(scan('MARKER=owned'),[]); assert.deepEqual(inspected,[]);`)
  })
  it('handles vanished processes and ancestry cycles without unrelated reads', () => {
    check(`nodes.get(40).parent=40; nodes.delete(30);
      beforeStat=(pid,count)=>{if(pid===20&&count===2) nodes.delete(20);};
      assert.deepEqual(scan('MARKER=owned'),[]); assert.deepEqual(inspected,[]);`)
  })
})
