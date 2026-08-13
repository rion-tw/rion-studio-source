import { createServer } from "node:http";
import process from "node:process";

const host = process.env.RION_FIXTURE_HOST ?? "127.0.0.1";
const port = readPort(process.env.RION_FIXTURE_PORT ?? "47831");
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (url.pathname === "/health") {
    send(response, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }
  if (!["/play", "/webgl-120"].includes(url.pathname)) {
    send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    return;
  }
  const role = boundedInteger(url.searchParams.get("role"), 1, 1, 9);
  const work = boundedInteger(url.searchParams.get("work"), 6_000, 0, 100_000);
  const text = boundedInteger(url.searchParams.get("text"), 120, 0, 2_000);
  if (url.pathname === "/webgl-120") {
    const drawCalls = boundedInteger(url.searchParams.get("drawCalls"), 80, 1, 2_000);
    const busyMs = boundedNumber(url.searchParams.get("busyMs"), 0, 0, 8);
    const profile = url.searchParams.get("profile") === "flyff-like" ? "flyff-like" : "draw";
    send(response, 200, "text/html; charset=utf-8", webGlFixtureHtml(drawCalls, busyMs, profile));
    return;
  }
  send(response, 200, "text/html; charset=utf-8", fixtureHtml(role, work, text));
});

server.listen(port, host, () => {
  process.stdout.write(`Rion deterministic browser fixture: http://${host}:${port}/play?role=1\n`);
  process.stdout.write(`Rion WebGL 120 Hz fixture: http://${host}:${port}/webgl-120\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function webGlFixtureHtml(drawCalls, busyMs, profile) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rion WebGL 120 Hz fixture</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#070b12;color:#e8edf5;font:14px system-ui}canvas{width:100%;height:100%;display:block}output{position:fixed;left:12px;top:10px;padding:6px 9px;border-radius:6px;background:#000b;white-space:pre}</style>
</head><body><canvas id="stage"></canvas><output>starting</output><script>
const targetFps=120;const targetInterval=1000/targetFps;const workloadProfile=${JSON.stringify(profile)};const fixedDrawCalls=workloadProfile==="flyff-like"?29:${drawCalls};const fixedBusyMs=${busyMs};
const canvas=document.querySelector("#stage");const output=document.querySelector("output");
const gl=canvas.getContext("webgl",{alpha:false,antialias:false,depth:false,desynchronized:false,failIfMajorPerformanceCaveat:true,preserveDrawingBuffer:false,stencil:false});
if(!gl)throw new Error("Hardware WebGL1 is unavailable.");
const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)||"shader compile failed");return shader};
const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,"attribute vec2 p;uniform vec2 o;uniform mat4 m;void main(){gl_Position=m*vec4(p+o,0.,1.);}"));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,"precision mediump float;uniform vec3 c;void main(){gl_FragColor=vec4(c,1.);}"));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||"program link failed");
const vertices=new Float32Array([-.02,-.03,.02,-.03,0,.03]);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);const indexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));gl.useProgram(program);const position=gl.getAttribLocation(program,"p");gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);const offset=gl.getUniformLocation(program,"o");const color=gl.getUniformLocation(program,"c");const matrixLocation=gl.getUniformLocation(program,"m");const matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);const colorVector=new Float32Array(3);gl.uniformMatrix4fv(matrixLocation,false,matrix);
const gameIntervals=[];const presentationIntervals=[];const timerDrift=[];const longTasks=[];let gameFrames=0;let presentationFrames=0;let contextLosses=0;let nextGameAt=performance.now();let previousGameAt;let previousPresentationAt;let lastOutputAt=0;
const retain=(values,value)=>{if(values.length>=2048)values.shift();values.push(value)};
const resize=()=>{const ratio=Number.isFinite(devicePixelRatio)?devicePixelRatio:1;const width=Math.max(1,Math.round(innerWidth*ratio));const height=Math.max(1,Math.round(innerHeight*ratio));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height)}};resize();addEventListener("resize",resize);
canvas.addEventListener("webglcontextlost",(event)=>{event.preventDefault();contextLosses++});
if(globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")){const observer=new PerformanceObserver((list)=>{for(const entry of list.getEntries())retain(longTasks,entry.duration)});observer.observe({type:"longtask",buffered:false})}
const gameTick=()=>{const now=performance.now();if(previousGameAt!==undefined)retain(gameIntervals,now-previousGameAt);previousGameAt=now;retain(timerDrift,now-nextGameAt);gameFrames++;gl.clearColor(.025,.04,.075,1);gl.clear(gl.COLOR_BUFFER_BIT);for(let index=0;index<fixedDrawCalls;index++){const phase=(gameFrames*.002+index/fixedDrawCalls)%1;gl.uniform2f(offset,Math.sin(phase*Math.PI*2)*.82,Math.cos((phase*1.7)%1*Math.PI*2)*.82);colorVector[0]=.25+phase*.65;colorVector[1]=.35+((phase*.7)%1)*.5;colorVector[2]=.8-phase*.4;if(workloadProfile==="flyff-like"){if(index<12)gl.bindBuffer(gl.ARRAY_BUFFER,buffer);if(index<22)gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);if(index<8)gl.bindTexture(gl.TEXTURE_2D,texture);if(index<10){gl.uniformMatrix4fv(matrixLocation,false,matrix);gl.uniform3fv(color,colorVector)}gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0)}else{gl.uniform3f(color,colorVector[0],colorVector[1],colorVector[2]);gl.drawArrays(gl.TRIANGLES,0,3)}}if(workloadProfile==="draw")gl.flush();const busyUntil=performance.now()+fixedBusyMs;while(performance.now()<busyUntil){}if(now-lastOutputAt>=250){lastOutputAt=now;const elapsed=gameIntervals.reduce((sum,value)=>sum+value,0);const fps=elapsed>0?gameIntervals.length*1000/elapsed:0;output.value="game loop "+fps.toFixed(1)+" FPS\\npresentation "+presentationFrames+" frames\\n"+workloadProfile+" · "+canvas.width+" × "+canvas.height+" · "+fixedDrawCalls+" draws"}nextGameAt+=targetInterval;if(now-nextGameAt>targetInterval*4)nextGameAt=now+targetInterval;setTimeout(gameTick,Math.max(0,nextGameAt-performance.now()))};
const presentationTick=(now)=>{if(previousPresentationAt!==undefined)retain(presentationIntervals,now-previousPresentationAt);previousPresentationAt=now;presentationFrames++;requestAnimationFrame(presentationTick)};
const sortedSummary=(values)=>{const sorted=[...values].sort((a,b)=>a-b);const percentile=(fraction)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*fraction)-1))]??0;return{maxMs:sorted.at(-1)??0,meanMs:values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0,p50Ms:percentile(.5),p90Ms:percentile(.9),p95Ms:percentile(.95),p99Ms:percentile(.99),sampleCount:values.length}};
const frameSummary=(values)=>{const summary=sortedSummary(values);const duration=values.reduce((sum,value)=>sum+value,0);const missedFrameCount=values.filter((value)=>summary.p50Ms>0&&value>summary.p50Ms*1.5).length;return{...summary,fps:duration>0?values.length*1000/duration:0,p10Fps:summary.p90Ms>0?1000/summary.p90Ms:0,missedFrameCount,missedFrameRatio:values.length?missedFrameCount/values.length:0}};
const contextAttributes=gl.getContextAttributes();const rendererExtension=gl.getExtension("WEBGL_debug_renderer_info");const supportedExtensions=gl.getSupportedExtensions()||[];
const snapshot=()=>({busyMsPerGameFrame:fixedBusyMs,canvas:{cssHeight:canvas.getBoundingClientRect().height,cssWidth:canvas.getBoundingClientRect().width,devicePixelRatio,pixelHeight:canvas.height,pixelWidth:canvas.width},context:{attributes:contextAttributes,contextLosses,extensions:{angleInstancing:supportedExtensions.includes("ANGLE_instanced_arrays"),multiDraw:supportedExtensions.includes("WEBGL_multi_draw"),parallelShaderCompile:supportedExtensions.includes("KHR_parallel_shader_compile"),vertexArrayObject:supportedExtensions.includes("OES_vertex_array_object")},renderer:rendererExtension?gl.getParameter(rendererExtension.UNMASKED_RENDERER_WEBGL):undefined,vendor:rendererExtension?gl.getParameter(rendererExtension.UNMASKED_VENDOR_WEBGL):undefined,version:gl.getParameter(gl.VERSION)},drawCallsPerGameFrame:fixedDrawCalls,gameLoop:frameSummary(gameIntervals),longTasks:{...sortedSummary(longTasks),count:longTasks.length,totalDurationMs:longTasks.reduce((sum,value)=>sum+value,0)},presentation:frameSummary(presentationIntervals),targetFps,timerDrift:sortedSummary(timerDrift),userAgent:navigator.userAgent,workloadProfile});
const resetSample=()=>{gameIntervals.length=0;presentationIntervals.length=0;timerDrift.length=0;longTasks.length=0;gameFrames=0;presentationFrames=0;previousGameAt=undefined;previousPresentationAt=undefined};
const wait=(durationMs)=>new Promise((resolve)=>setTimeout(resolve,durationMs));
globalThis.__rionWebGlPerformanceSnapshot=snapshot;
globalThis.__rionWebGlPerformanceRun=async(options={})=>{const warmupMs=Math.max(0,options.warmupMs??30000);const sampleMs=Math.max(1000,options.sampleMs??10000);const sampleCount=Math.max(1,Math.min(20,Math.trunc(options.sampleCount??5)));const soakMs=Math.max(0,options.soakMs??600000);await wait(warmupMs);const samples=[];for(let index=0;index<sampleCount;index++){resetSample();await wait(sampleMs);samples.push({index,...snapshot()})}const soakContextLosses=contextLosses;if(soakMs>0){resetSample();await wait(soakMs)}return{completedAt:new Date().toISOString(),fixture:"rion-webgl1-120",samples,soak:{contextLosses:contextLosses-soakContextLosses,durationMs:soakMs,end:soakMs>0?snapshot():undefined},warmupMs,sampleMs,targetFps}};
requestAnimationFrame(presentationTick);nextGameAt=performance.now()+targetInterval;setTimeout(gameTick,targetInterval);
</script></body></html>`;
}

function fixtureHtml(role, work, text) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rion performance fixture ${role}</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10131a;color:#e8edf5;font:14px system-ui}canvas{width:100%;height:100%;display:block}output{position:fixed;left:12px;top:10px;padding:5px 8px;border-radius:6px;background:#0008}</style>
</head><body><canvas id="stage" width="1280" height="720"></canvas><output>role ${role}</output>
<script>
const role=${role};const work=${work};const textPerFrame=${text};const canvas=document.querySelector("#stage");const context=canvas.getContext("2d",{alpha:false});
const glyphCanvas=typeof OffscreenCanvas==="function"?new OffscreenCanvas(512,128):undefined;const glyphContext=glyphCanvas?.getContext("2d");
let frame=0;let seed=(0x9e3779b9^role)>>>0;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
const points=Array.from({length:240},()=>({x:random()*1280,y:random()*720,vx:(random()-.5)*1.4,vy:(random()-.5)*1.4}));
const frameIntervals=[];let previousFrameAt;
globalThis.__rionPerformanceSnapshot=()=>{const sorted=[...frameIntervals].sort((a,b)=>a-b);const percentile=(p)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))]??0;return{frameCount:frame,raf:{maxMs:sorted.at(-1)??0,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),sampleCount:sorted.length},workload:{offscreenCanvas:Boolean(glyphContext),textPerFrame}}};
function draw(frameAt){if(previousFrameAt!==undefined){if(frameIntervals.length>=1024)frameIntervals.shift();frameIntervals.push(Math.max(0,frameAt-previousFrameAt))}previousFrameAt=frameAt;frame++;let checksum=role;for(let index=0;index<work;index++)checksum=(Math.imul(checksum^index,2654435761)+frame)>>>0;
context.fillStyle="#10131a";context.fillRect(0,0,1280,720);context.fillStyle="hsl("+((checksum%360)+role*17)+" 70% 58%)";
for(const point of points){point.x=(point.x+point.vx+1280)%1280;point.y=(point.y+point.vy+720)%720;context.fillRect(point.x,point.y,2,2)}
context.save();const fixtureFont='600 14px "Rion Fixture UI",sans-serif';context.font=fixtureFont;context.textBaseline="top";for(let index=0;index<textPerFrame;index++){context.font=fixtureFont;const label="role "+role+" frame "+frame+" item "+index;context.fillText(label,16+(index%12)*102,42+Math.floor(index/12)%18*28);if(index%8===0)context.measureText(label);if(index%32===0)context.strokeText(label,16,680)}context.restore();
if(glyphContext){glyphContext.save();const glyphFont='12px "Rion Fixture Glyphs",sans-serif';glyphContext.font=glyphFont;for(let index=0;index<Math.ceil(textPerFrame/4);index++){glyphContext.font=glyphFont;const label="glyph "+role+" "+index;glyphContext.fillText(label,(index%8)*64,Math.floor(index/8)%8*15);if(index%8===0)glyphContext.measureText(label)}glyphContext.restore()}
document.querySelector("output").value="role "+role+" · frame "+frame+" · "+checksum;requestAnimationFrame(draw)}
addEventListener("visibilitychange",()=>document.body.dataset.visibility=document.visibilityState);requestAnimationFrame(draw);
</script></body></html>`;
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin"
  });
  response.end(body);
}

function boundedInteger(raw, fallback, minimum, maximum) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function boundedNumber(raw, fallback, minimum, maximum) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function readPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("RION_FIXTURE_PORT must be a valid TCP port.");
  }
  return value;
}
