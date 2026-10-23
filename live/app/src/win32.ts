// Native Windows calls through koffi (FFI), replacing the last PowerShell in the service:
//  - process list with parent ids (orphaned model-runner reaper): CreateToolhelp32Snapshot / Process32FirstW / NextW
//  - keep the PC awake while the team is busy: SetThreadExecutionState on the service's own thread
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let k32: any = null, entryType: any = null, fns: any = null;
function load() {
  if (fns || process.platform !== 'win32') return fns;
  const koffi = require('koffi');
  k32 = koffi.load('kernel32.dll');
  entryType = koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr', th32ModuleID: 'uint32',
    cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32', szExeFile: koffi.array('char16', 260, 'String'),
  });
  fns = {
    snapshot: k32.func('void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
    first: k32.func('bool __stdcall Process32FirstW(void* snap, _Inout_ PROCESSENTRY32W* entry)'),
    next: k32.func('bool __stdcall Process32NextW(void* snap, _Inout_ PROCESSENTRY32W* entry)'),
    close: k32.func('bool __stdcall CloseHandle(void* h)'),
    execState: k32.func('uint32 __stdcall SetThreadExecutionState(uint32 flags)'),
    size: koffi.sizeof(entryType),
  };
  return fns;
}

export function listProcessesNative(): { pid: number; ppid: number; name: string }[] {
  const f = load(); if (!f) throw new Error('not Windows');
  const snap = f.snapshot(0x2, 0);   // TH32CS_SNAPPROCESS
  const out: { pid: number; ppid: number; name: string }[] = [];
  try {
    const e: any = { dwSize: f.size };
    for (let ok = f.first(snap, e); ok; ok = f.next(snap, e)) { out.push({ pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name: e.szExeFile }); e.dwSize = f.size; }
  } finally { f.close(snap); }
  return out;
}

const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;
/** Ask Windows not to sleep (true) or release the request (false). Power settings are untouched. */
export function setAwake(on: boolean): boolean {
  const f = load(); if (!f) return false;
  return f.execState(on ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0 : ES_CONTINUOUS) !== 0;
}
