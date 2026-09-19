/**
 * The page a phone loads: one HTML string with its style and script inline,
 * each tagged with the per-response CSP nonce, and nothing fetched from
 * anywhere but this server (the CSP forbids it anyway). It renders the
 * content-free RemoteView, posts plain-language lines, and shows Approve
 * only when the view says this phone may. Nothing is stored on the phone:
 * no localStorage, no service worker; the session token lives in memory
 * and in an HttpOnly cookie the page cannot read.
 */

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** A tiny inline icon for the manifest (a ring, like the tray icon). */
export const ICON_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#101010"/><circle cx="32" cy="32" r="16" fill="none" stroke="#d8d8d8" stroke-width="5"/><circle cx="32" cy="32" r="4" fill="#d8d8d8"/></svg>',
  );

export function manifest(macName: string): string {
  return JSON.stringify({
    name: "Butler Remote",
    short_name: "Butler",
    description: `Butler on ${macName}`,
    display: "standalone",
    start_url: "/",
    scope: "/",
    background_color: "#101010",
    theme_color: "#101010",
    icons: [{ src: ICON_SVG, sizes: "any", type: "image/svg+xml" }],
  });
}

const CSS = `
:root{color-scheme:dark;font-family:-apple-system,system-ui,sans-serif;font-size:16px;background:#101010;color:#d8d8d8}
*{box-sizing:border-box}body{margin:0;padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}
main{max-width:520px;margin:0 auto;padding:14px 16px 120px}
header{display:flex;align-items:center;gap:10px;padding:8px 0 14px}
header h1{font-size:17px;margin:0;font-weight:600}header small{color:#8a8a8a;font-size:13px}
.dot{width:10px;height:10px;border-radius:50%;background:#666;margin-left:auto}
.dot.on{background:#4fc17b}.dot.wait{background:#d9a441}
.card{background:#1a1a1a;border:1px solid #262626;border-radius:12px;padding:14px;margin-bottom:12px}
.card h2{margin:0 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#8a8a8a}
.big{font-size:19px;font-weight:600;margin:0 0 4px}.muted{color:#9a9a9a;font-size:14px}
.chip{display:inline-block;background:#2a2a2a;color:#d0d0d0;border-radius:999px;padding:3px 10px;font-size:12px;margin-top:8px}
button{font:inherit;border:0;border-radius:10px;padding:12px 14px;background:#2a2a2a;color:#e6e6e6;cursor:pointer}
button:disabled{opacity:.45}button.primary{background:#d8d8d8;color:#101010;font-weight:600}
button.danger{background:#5a2323;color:#ffd7d7}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row button{flex:1}
img.thumb{width:100%;border-radius:10px;display:block;background:#000}
ul.log{list-style:none;margin:0;padding:0;font-size:14px}ul.log li{padding:6px 0;border-top:1px solid #262626;color:#bdbdbd}
ul.log li.reply{color:#e6e6e6}ul.log li.me{color:#8fbcff}ul.log li:first-child{border-top:0}
form{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0));background:#101010;border-top:1px solid #262626}
form .box{display:flex;gap:8px;max-width:520px;margin:0 auto}
input{flex:1;font:inherit;border-radius:10px;border:1px solid #2a2a2a;background:#1a1a1a;color:#eee;padding:12px}
.quick{display:flex;gap:8px;max-width:520px;margin:0 auto 8px}.quick button{flex:1;padding:9px 6px;font-size:13px}
[hidden]{display:none!important}
`;

const SCRIPT = `
(function(){
"use strict";
var $=function(id){return document.getElementById(id)};
var token="",session=null,view=null,stream=null,retried=false,armed=true,pingAt=0;
var log=[];var MAX_LOG=20;
function text(id,v){$(id).textContent=v==null?"":String(v)}
function show(id,on){$(id).hidden=!on}
function state(s){var d=$("dot");d.className="dot"+(s==="on"?" on":s==="wait"?" wait":"")}
function push(kind,line){log.unshift({kind:kind,line:line});if(log.length>MAX_LOG)log.length=MAX_LOG;var ul=$("log");ul.textContent="";log.forEach(function(e){var li=document.createElement("li");li.className=e.kind;li.textContent=e.line;ul.appendChild(li)})}
function statusWord(v){return v.status==="working"?"Working":v.status==="waiting_for_approval"?"Waiting for your OK":v.status==="waiting_for_you"?"Needs you at the Mac":v.status==="paused"?"Paused":"Idle"}
function render(v){view=v;text("status",statusWord(v));
var line=v.task?v.task:(v.lastFinished?"Last: "+v.lastFinished.task:"Nothing is running.");text("task",line);
var meta=[];if(v.app)meta.push(v.app);if(v.minutes!=null)meta.push(v.minutes+" min");if(v.steps!=null)meta.push(v.steps+" steps");if(v.queued.length)meta.push(v.queued.length+" queued");text("meta",meta.join(" · "));
show("present",v.presence==="present");show("locked",v.locked);
var p=v.pending;show("approval",!!p);
if(p){text("reason",p.reason);text("what",p.what+(p.app?" in "+p.app:""));show("approve",p.allowed);show("mac",!p.allowed);
text("mac",p.tier==="never"?"Approve this one on the Mac.":"Approvals from this phone are off. Turn them on in Settings on the Mac.");
$("approve").disabled=false;$("skip").disabled=false;armed=true}
show("question",!!v.question);text("question",v.question);
var img=$("thumb");if(v.frame){var src="/api/frame/"+encodeURIComponent(v.frame.id)+".jpg";if(img.getAttribute("data-id")!==v.frame.id){img.setAttribute("data-id",v.frame.id);img.src=src}show("thumbwrap",true)}else{show("thumbwrap",false);img.removeAttribute("data-id");img.removeAttribute("src")}
$("pause").textContent=v.status==="paused"?"Continue":"Pause";$("pause").disabled=!v.running;$("stop").disabled=!v.running}
function post(path,body){return fetch(path,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Remote-Token":token},body:JSON.stringify(body)}).then(function(r){if(r.status===403){if(!retried){retried=true;return start().then(function(){return post(path,body)})}throw new Error("locked")}if(r.status===429)throw new Error("Slow down a little.");if(!r.ok)throw new Error("That didn’t go through.");return r.json()})}
function fail(e){push("reply",e&&e.message==="locked"?"Locked from the Mac.":(e&&e.message)||"Something went wrong.");if(e&&e.message==="locked")state("off")}
function open(){if(stream)stream.close();stream=new EventSource("/api/events");state("wait");
stream.onopen=function(){state("on");retried=false};stream.onerror=function(){state("wait")};
stream.addEventListener("status",function(e){render(JSON.parse(e.data).view)});
stream.addEventListener("progress",function(e){push("line",JSON.parse(e.data).line)});
stream.addEventListener("reply",function(e){push("reply",JSON.parse(e.data).text)});
stream.addEventListener("notice",function(e){push("reply",JSON.parse(e.data).text)});
stream.addEventListener("ping",function(){pingAt=Date.now()})}
function start(){return fetch("/api/session",{credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error("locked");return r.json()}).then(function(s){session=s;token=s.token;text("mac-name",s.mac.name);text("device",s.device.name+(s.device.approve?" · can approve routine steps":" · control only"));show("mic",false);open()})}
$("say").addEventListener("submit",function(e){e.preventDefault();var box=$("text");var t=box.value.trim();if(!t)return;box.value="";push("me",t);post("/api/say",{text:t}).then(function(r){if(r.reply)push("reply",r.reply)}).catch(fail)});
$("ask").addEventListener("click",function(){post("/api/ask",{kind:"status"}).then(function(r){if(r.reply)push("reply",r.reply)}).catch(fail)});
$("pause").addEventListener("click",function(){var kind=view&&view.status==="paused"?"continue":"pause";post("/api/control",{kind:kind}).then(function(r){if(r.reply)push("reply",r.reply)}).catch(fail)});
$("stop").addEventListener("click",function(){if(!confirm("Stop the task?"))return;post("/api/control",{kind:"stop"}).then(function(r){if(r.reply)push("reply",r.reply)}).catch(fail)});
function answer(a){if(!view||!view.pending||!armed)return;armed=false;$("approve").disabled=true;$("skip").disabled=true;var p=view.pending;post("/api/approve",{gate:p.gate,nonce:p.nonce,answer:a}).then(function(r){if(r.reply)push("reply",r.reply)}).catch(fail)}
$("approve").addEventListener("click",function(){answer("approve")});$("skip").addEventListener("click",function(){answer("skip")});
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&(!stream||stream.readyState===2||Date.now()-pingAt>45000))open()});
start().catch(fail);
})();
`;

/** The full page for an allowed phone. */
export function renderPage(o: { nonce: string; macName: string }): string {
  const nonce = esc(o.nonce);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Butler">
<meta name="referrer" content="no-referrer">
<title>Butler</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="${ICON_SVG}">
<style nonce="${nonce}">${CSS}</style>
</head><body><main>
<header><div><h1>Butler</h1><small id="mac-name">${esc(o.macName)}</small></div><div class="dot" id="dot"></div></header>
<section class="card"><h2>Now</h2><p class="big" id="status">Connecting…</p><p id="task" class="muted"></p><p id="meta" class="muted"></p>
<span class="chip" id="present" hidden>Someone’s at the Mac</span><span class="chip" id="locked" hidden>Remote locked from the Mac</span>
<p id="question" class="muted" hidden></p></section>
<section class="card" id="approval" hidden><h2>Needs your OK</h2><p class="big" id="reason"></p><p class="muted" id="what"></p>
<p class="muted" id="mac" hidden></p><div class="row"><button class="primary" id="approve">Approve</button><button id="skip">Skip</button></div></section>
<section class="card" id="thumbwrap" hidden><h2>Screen</h2><img class="thumb" id="thumb" alt="Blurred view of the Mac’s screen"></section>
<section class="card"><h2>Recent</h2><ul class="log" id="log"></ul></section>
<p class="muted" id="device"></p>
<p class="muted" id="mic" hidden>Talking from the phone is coming later.</p>
</main>
<form id="say"><div class="quick"><button type="button" id="ask">What are you doing?</button><button type="button" id="pause">Pause</button><button type="button" class="danger" id="stop">Stop</button></div>
<div class="box"><input id="text" maxlength="2000" autocomplete="off" placeholder="Tell it what to do…"><button type="submit" class="primary">Send</button></div></form>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
}

/** The short page for the right person on a phone the Mac has not allowed. */
export function unpairedPage(o: {
  nonce: string;
  macName: string;
  deviceName: string;
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Butler</title>
<style nonce="${esc(o.nonce)}">${CSS}</style></head><body><main>
<header><div><h1>Butler</h1><small>${esc(o.macName)}</small></div></header>
<section class="card"><p class="big">Not allowed yet.</p>
<p class="muted">On the Mac, open Settings › Phone remote and allow “${esc(o.deviceName)}”. Then reload this page.</p></section>
</main></body></html>`;
}
