// Offline Win32 sharing-violation regression. Optional Python stdlib ctypes helper; no runtime dependency.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL,fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url));
if(process.platform!=='win32'||!process.env.GMM_TEST_PYTHON){console.log('SKIP real Win32 lock test: requires Windows and GMM_TEST_PYTHON');process.exit(0);}
const temp=await mkdtemp(join(tmpdir(),'gmm-win-store-'));process.env.DSH_HOME=temp;
const store=await import(pathToFileURL(repo+'/lib/store.js'));
let child;
try{
 const project=await store.createProject('before transient file lock');
 const target=join(temp,'game-material-master/projects',project.id,'project.json');
 const source=String.raw`import ctypes,sys,time
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
k.CreateFileW.restype=ctypes.c_void_p
k.CloseHandle.argtypes=[ctypes.c_void_p]
h=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0x80,None)
if h==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
print('LOCKED',flush=True)
time.sleep(.4)
k.CloseHandle(h)
`;
 const python=process.env.GMM_TEST_PYTHON;
 child=spawn(python,['-c',source,target],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',c=>{if(String(c).includes('LOCKED'))resolve();});child.once('exit',code=>{if(code)reject(new Error('File-lock helper failed: '+stderr));});});
 const start=Date.now();
 await store.patchProject(project.id,p=>{p.name='after transient file lock';});
 const elapsed=Date.now()-start;
 assert.equal((await store.readProject(project.id)).name,'after transient file lock');
 assert(elapsed>=150,'Writer must actually encounter the sharing violation, then recover');
 if(child.exitCode===null)await once(child,'exit');
 console.log(JSON.stringify({passed:true,real_windows_file_sharing_lock:true,recovered_after_ms:elapsed,paid_calls:0}));
}finally{if(child?.exitCode===null)child.kill();await rm(temp,{recursive:true,force:true});}
