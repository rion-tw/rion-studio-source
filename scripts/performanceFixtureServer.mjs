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
  if (url.pathname !== "/play") {
    send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    return;
  }
  const role = boundedInteger(url.searchParams.get("role"), 1, 1, 9);
  const work = boundedInteger(url.searchParams.get("work"), 6_000, 0, 100_000);
  const text = boundedInteger(url.searchParams.get("text"), 120, 0, 2_000);
  send(response, 200, "text/html; charset=utf-8", fixtureHtml(role, work, text));
});

server.listen(port, host, () => {
  process.stdout.write(`Rion deterministic browser fixture: http://${host}:${port}/play?role=1\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
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

function readPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("RION_FIXTURE_PORT must be a valid TCP port.");
  }
  return value;
}
