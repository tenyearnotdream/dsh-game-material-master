// Offline regression: actual ffmpeg matte and PNG ZIP export; no network or paid calls.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
const repo=fileURLToPath(new URL('..',import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'gmm-alpha-'));
process.env.DSH_HOME=temp;
const {encodePng}=await import(pathToFileURL(repo+'/lib/png.js'));
const {toJpegDataUri,decodeToRgba}=await import(pathToFileURL(repo+'/lib/media.js'));
const {createProject,patchProject,assetPath}=await import(pathToFileURL(repo+'/lib/store.js'));
const {exportImages}=await import(pathToFileURL(repo+'/lib/pipeline.js'));
try{
 const rgba=Buffer.alloc(64*64*4);
 for(let y=16;y<48;y++)for(let x=16;x<48;x++){const i=(y*64+x)*4;rgba.set([20,30,80,255],i);}
 const png=encodePng(rgba,64,64),input=join(temp,'transparent.png'),output=join(temp,'video-matte.jpg');
 await writeFile(input,png);
 await toJpegDataUri(input,output,1280,3,'white');
 const decoded=await decodeToRgba(output);
 assert.equal(decoded.width,64);assert.equal(decoded.height,64);
 assert([...decoded.rgba.subarray(0,3)].every(v=>v>=240),'Transparent source corner must become white for MP4 input');
 const center=decoded.rgba.subarray((32*64+32)*4,(32*64+32)*4+3);
 assert(center[0]<50&&center[2]>50&&center[2]<110,'Dark foreground must survive white matting');
 assert.deepEqual(await readFile(input),png,'Native transparent source must remain byte-identical');
 const project=await createProject('native-alpha-export-local-test');
 await writeFile(assetPath(project.id,'images/front.png'),png);
 await patchProject(project.id,p=>{p.images.front={status:'ready',file:'images/front.png',approved:false};});
 const exported=await exportImages(project.id),zip=await readFile(assetPath(project.id,exported.file));
 let found;
 for(let offset=0;offset+30<=zip.length&&zip.readUInt32LE(offset)===0x04034b50;){
   const method=zip.readUInt16LE(offset+8),compressed=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28);
   const name=zip.subarray(offset+30,offset+30+nameLength).toString('utf8'),start=offset+30+nameLength+extraLength;
   const bytes=zip.subarray(start,start+compressed);
   if(name==='images/front.png')found=method===8?inflateRawSync(bytes):bytes;
   offset=start+compressed;
 }
 assert.deepEqual(found,png,'Export ZIP must preserve original transparent PNG after decompression');
 console.log('PASS native alpha unchanged; white video matte; dark foreground retained; actual export ZIP preserves PNG bytes');
}finally{await rm(temp,{recursive:true,force:true});}
