"use client";

// VRX EXPLAINER — the broadcast-style animated explainer (4 pillars → vetting → the roles → authority
// review), re-themed to the VRX portal palette (vetted-green, Inter, portal panels). Rendered in a sandboxed
// iframe via srcDoc so its self-contained SVG + animation JS + speech-synthesis stay isolated from the app's
// React tree (no id collisions, no global listeners leaking). Used as the face of the PasswordGate.
// diagram labels/points much larger (especially on phones), portrait-responsive (diagram stacks over caption).
// Source of truth for the markup is this file; the standalone C:\Users\USER\Downloads\vrx anim.html is the
// same content kept for quick offline preview. Keep them in sync if the narration/diagram changes.

const DOC = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VRX Explainer</title>
<style>
:root{--bg:#0a0e17;--bg2:#0f1420;--panel:#131a28;--border:#232d40;--text:#e8ecf4;--dim:#9aa6be;--faint:#63708c;--vetted:#38d39f;--vetted-glow:rgba(56,211,159,.35);--line-color:rgba(154,166,190,.35);--font-stack:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
*{box-sizing:border-box;}
body,html{margin:0;padding:0;width:100%;height:100%;background:#05070c;font-family:var(--font-stack);-webkit-font-smoothing:antialiased;overflow:hidden;display:flex;justify-content:center;align-items:center;}
#broadcast-frame{position:relative;width:100%;height:100%;background:radial-gradient(1200px 600px at 50% 32%,rgba(56,211,159.05),transparent 60%),var(--bg);overflow:hidden;}
#start-overlay{position:absolute;inset:0;z-index:50;background:rgba(10,14,23.92);backdrop-filter:blur(14px);display:flex;flex-direction:column;justify-content:center;align-items:center;cursor:pointer;transition:opacity.5s ease;}
#start-overlay:hover.play-btn{transform:scale(1.08);box-shadow:0 0 36px var(--vetted-glow);border-color:var(--vetted);}
.play-btn{width:84px;height:84px;border-radius:50%;border:1.5px solid rgba(56,211,159,.55);display:flex;justify-content:center;align-items:center;transition:all .3s cubic-bezier(.16,1,.3,1);background:rgba(56,211,159,.08);}
.play-btn svg{width:30px;height:30px;fill:var(--vetted);margin-left:5px;}
.overlay-text{color:var(--text);margin-top:20px;font-size:13px;letter-spacing:3.5px;text-transform:uppercase;font-weight:600;}
.overlay-sub{color:var(--faint);margin-top:7px;font-size:12px;letter-spacing:1px;}
#intro-screen{position:absolute;inset:0;z-index:20;background:radial-gradient(900px 500px at 50% 45%,#10192a,#0a0e17 70%);display:flex;flex-direction:column;justify-content:center;align-items:center;opacity:0;visibility:hidden;transition:opacity 1s ease,visibility 1s ease;}
.intro-bg-lines{position:absolute;inset:0;pointer-events:none;background-image:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(255,255,255,.015) 3px,rgba(255,255,255,.015) 4px);}
.intro-seal{display:inline-flex;align-items:center;gap:8px;padding:5px 14px;margin-bottom:20px;border:1px solid rgba(56,211,159,.4);border-radius:999px;color:var(--vetted);font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;opacity:0;z-index:2;background:rgba(56,211,159,.06);}
.intro-active .intro-seal{animation:fadeUp .9s .3s cubic-bezier(.16,1,.3,1) forwards;}
.intro-title{font-size:7.5vw;font-weight:800;letter-spacing:.6vw;color:var(--text);text-transform:uppercase;opacity:0;transform:scale(1.1);text-shadow:0 0 40px rgba(56,211,159,.18);z-index:2;}
.intro-subtitle{font-size:1.5vw;letter-spacing:.45vw;font-weight:500;color:var(--dim);opacity:0;margin-top:14px;z-index:2;}
.intro-glitch-bar{position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(56,211,159,.12),transparent);animation:glitchSweep 2s ease-in-out infinite;z-index:1;}
.intro-active .intro-title{animation:titleReveal 2.5s cubic-bezier(.16,1,.3,1) forwards;}
.intro-active .intro-subtitle{animation:fadeUp 1s 1s cubic-bezier(.16,1,.3,1) forwards;}
@keyframes titleReveal{0%{opacity:0;transform:scale(1.18);filter:blur(12px);}55%{opacity:1;transform:scale(1);filter:blur(0);}100%{opacity:1;transform:scale(1);filter:blur(0);}}
@keyframes fadeUp{0%{opacity:0;transform:translateY(18px);}100%{opacity:1;transform:translateY(0);}}
@keyframes glitchSweep{0%{left:-100%;}100%{left:100%;}}
#main-screen{position:absolute;inset:0;opacity:0;display:flex;justify-content:center;align-items:center;background-image:linear-gradient(rgba(154,166,190.035) 1px,transparent 1px),linear-gradient(90deg,rgba(154,166,190.035) 1px,transparent 1px);background-size:44px 44px;padding-bottom:150px;box-sizing:border-box;transition:opacity 1s ease;}
#main-screen.active{opacity:1;}
svg{width:100%;height:100%;overflow:visible;}
.line,.cross-connection{stroke:rgba(154,166,190,.6);stroke-width:3.5;fill:none;stroke-dasharray:1000;stroke-dashoffset:1000;stroke-linecap:round;}
.node{fill:var(--vetted);filter:drop-shadow(0 0 9px var(--vetted-glow));opacity:0;transform-origin:center;}
.node-halo{fill:none;stroke:var(--vetted);stroke-width:1.75;opacity:0;transform-box:fill-box;transform-origin:center;animation:breathe 3.2s infinite ease-in-out;}
@keyframes breathe{0%{transform:scale(1);opacity:.55;}50%{transform:scale(2.1);opacity:0;}100%{transform:scale(1);opacity:.55;}}
/* labels bumped up ("double size... points almost 3x larger") */
.node-label{fill:var(--text);font-size:26px;font-weight:700;letter-spacing:4px;text-transform:uppercase;text-anchor:middle;opacity:0;font-family:var(--font-stack);}
.role-label{fill:var(--dim);font-size:22px;font-weight:600;letter-spacing:2px;text-transform:uppercase;text-anchor:middle;opacity:0;font-family:var(--font-stack);}
.role-spoke{stroke:rgba(154,166,190,.18);stroke-width:1;stroke-dasharray:4 4;fill:none;opacity:0;}
.center-text{fill:var(--vetted);font-size:52px;font-weight:800;letter-spacing:14px;text-anchor:middle;dominant-baseline:middle;opacity:0;filter:drop-shadow(0 0 16px var(--vetted-glow));font-family:var(--font-stack);}
/* lower-third caption ~2x bigger */
#lower-third{position:absolute;bottom:5%;left:5%;width:72%;display:flex;flex-direction:column;opacity:0;transform:translateX(-26px);transition:all.6s cubic-bezier(.16,1.3,1);z-index:10;}
#lower-third.active{opacity:1;transform:translateX(0);}
.lt-bar{height:3px;width:100%;margin-bottom:9px;border-radius:2px;background:linear-gradient(90deg,var(--vetted),rgba(56,211,159,.15));box-shadow:0 0 12px var(--vetted-glow);}
.lt-header{background:rgba(19,26,40,.92);backdrop-filter:blur(10px);padding:7px 16px;display:inline-flex;align-items:center;gap:7px;width:fit-content;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--vetted);border:1px solid var(--border);border-left:2px solid var(--vetted);border-radius:4px 4px 0 0;}
.lt-header::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--vetted);box-shadow:0 0 8px var(--vetted);animation:livePulse 1.6s infinite ease-in-out;}
@keyframes livePulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.lt-text-box{background:rgba(15,20,32,.82);backdrop-filter:blur(10px);padding:18px 22px;border:1px solid var(--border);border-top:none;border-left:2px solid rgba(56,211,159,.4);border-radius:0 6px 6px 6px;}
#cc-text{color:var(--text);font-size:22px;font-weight:500;letter-spacing:.2px;line-height:1.4;margin:0;}
/* ── Controls bar (play/pause + replay), always visible after start ── */
#controls{position:absolute;top:16px;left:16px;display:none;gap:10px;z-index:30;}
#controls.visible{display:flex;}
.ctrl-btn{width:46px;height:46px;background:rgba(19,26,40,.75);border:1px solid var(--border);border-radius:10px;display:flex;justify-content:center;align-items:center;cursor:pointer;transition:all .2s ease;backdrop-filter:blur(6px);}
.ctrl-btn:hover{background:rgba(24,32,47,.95);border-color:var(--vetted);}
.ctrl-btn svg{width:22px;height:22px;fill:var(--text);transition:fill .2s ease;}
.ctrl-btn:hover svg{fill:var(--vetted);}
#recycle-btn{display:none;}
/* PORTRAIT / narrow (phones): stack diagram-over-caption; bump EVERYTHING up hard. */
@media (max-aspect-ratio: 1/1), (max-width: 640px){
  #broadcast-frame{display:flex;flex-direction:column;}
  /* Diagram gets the TOP ~74%; the caption is a SLIM bottom strip (b: caption box + its margins
     were huge on phone, eating the diagram). Tight padding, smaller text, no min-margins. */
  #main-screen{position:relative;flex:1 1 74%;min-height:0;padding:20px 6px 4px;}
  #main-screen svg{max-height:none;}
  #lower-third{position:relative;bottom:auto;left:auto;width:auto;margin:0;padding:6px 10px 8px;transform:none !important;flex:0 0 auto;max-height:26vh;overflow-y:auto;}
  #lower-third.active{transform:none;}
  .lt-bar{display:none;}
  .lt-header{font-size:11px;padding:4px 10px;letter-spacing:1.5px;}
  .lt-text-box{padding:8px 12px;}
  #cc-text{font-size:15.5px;line-height:1.32;}
  .intro-title{font-size:18vw;}
  .intro-subtitle{font-size:4vw;letter-spacing:1.4vw;}
  .center-text{font-size:70px;letter-spacing:22px;}
  .node-label{font-size:40px;letter-spacing:5px;}
  .role-label{font-size:34px;letter-spacing:3px;}
  .line,.cross-connection{stroke-width:6;stroke:rgba(154,166,190,.7);}
  .role-spoke{stroke-width:2.5;}
  .node,.node-halo{stroke-width:3;}
  .ctrl-btn{width:52px;height:52px;}
  .ctrl-btn svg{width:26px;height:26px;}
}
</style></head><body>
<div id="broadcast-frame">
<div id="start-overlay"><div class="play-btn"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div><div class="overlay-text">Play the explainer</div><div class="overlay-sub">A 60-second tour of how VRX works</div></div>
<div id="controls">
  <div class="ctrl-btn" id="pause-btn" title="Pause / resume"><svg id="pp-icon" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></div>
  <div class="ctrl-btn" id="replay-btn" title="Replay from start"><svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93 0-4.42-3.58-8-8-8zm-6 8c0-1.54.59-2.96 1.56-4.03l-1.41-1.41C4.83 8.83 4 10.33 4 12c0 4.08 3.05 7.44 7 7.93v-2.02c-2.83-.48-5-2.94-5-5.91z"/></svg></div>
</div>
<div id="recycle-btn" title="Replay"></div>
<div id="intro-screen"><div class="intro-bg-lines"></div><div class="intro-glitch-bar"></div><div class="intro-seal">&#10003; Vetted</div><div class="intro-title">VRX</div><div class="intro-subtitle">THE VETTED BOOKING SYSTEM</div></div>
<div id="main-screen"><svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet">
<line id="line1" class="line" x1="500" y1="150" x2="750" y2="350"/><line id="line2" class="line" x1="750" y1="350" x2="500" y2="550"/><line id="line3" class="line" x1="500" y1="550" x2="250" y2="350"/><line id="line4" class="line" x1="250" y1="350" x2="500" y2="150"/>
<line id="cross13" class="cross-connection" x1="500" y1="150" x2="500" y2="550"/><line id="cross42" class="cross-connection" x1="250" y1="350" x2="750" y2="350"/>
<line id="spoke0" class="role-spoke" x1="500" y1="50" x2="500" y2="150"/><line id="spoke1" class="role-spoke" x1="850" y1="200" x2="750" y2="350"/><line id="spoke2" class="role-spoke" x1="920" y1="350" x2="750" y2="350"/><line id="spoke3" class="role-spoke" x1="850" y1="500" x2="500" y2="550"/><line id="spoke4" class="role-spoke" x1="500" y1="650" x2="500" y2="550"/><line id="spoke5" class="role-spoke" x1="150" y1="500" x2="250" y2="350"/><line id="spoke6" class="role-spoke" x1="80" y1="350" x2="250" y2="350"/>
<line id="authority-spoke" class="role-spoke" x1="150" y1="200" x2="500" y2="350" stroke-dasharray="2 6" stroke="#38d39f"/>
<circle id="node1" class="node" cx="500" cy="150" r="9"/><circle id="node2" class="node" cx="750" cy="350" r="9"/><circle id="node3" class="node" cx="500" cy="550" r="9"/><circle id="node4" class="node" cx="250" cy="350" r="9"/>
<circle id="halo1" class="node-halo" cx="500" cy="150" r="9"/><circle id="halo2" class="node-halo" cx="750" cy="350" r="9"/><circle id="halo3" class="node-halo" cx="500" cy="550" r="9"/><circle id="halo4" class="node-halo" cx="250" cy="350" r="9"/>
<text id="label1" class="node-label" x="500" y="108">AVAILABILITY</text><text id="label2" class="node-label" x="750" y="398">COMMUNICATIONS</text><text id="label3" class="node-label" x="500" y="602">PAYMENTS</text><text id="label4" class="node-label" x="250" y="398">ACCOUNTING</text>
<text id="vetted-text" class="center-text" x="500" y="350">VRX</text>
<text id="role0" class="role-label" x="500" y="30">DEVELOPER(S)</text><text id="role1" class="role-label" x="880" y="175">DIRECT-SELLER</text><text id="role2" class="role-label" x="945" y="358">AGENT(S)</text><text id="role3" class="role-label" x="880" y="535">AGENCY/IES</text><text id="role4" class="role-label" x="500" y="680">BUYER</text><text id="role5" class="role-label" x="120" y="535">DIRECT-BUYER</text><text id="role6" class="role-label" x="55" y="358">CEO / APPROVER</text><text id="role7" class="role-label" x="120" y="175" fill="#38d39f">AUTHORITY REVIEW</text>
</svg></div>
<div id="lower-third"><div class="lt-bar"></div><div class="lt-header">System Explainer</div><div class="lt-text-box"><p id="cc-text">Initializing&#8230;</p></div></div>
</div>
<script>
var voices=[];function loadVoices(){voices=window.speechSynthesis.getVoices();if(voices.length===0)setTimeout(loadVoices,100);}window.speechSynthesis.onvoiceschanged=loadVoices;
function getBestFemaleVoice(){var f=['samantha','zira','hazel','moira','tessa','google uk english female','google us english','susan','karen','fiona','female'];var m=['david','mark','daniel','alex','fred','george','james','paul','tom'];for(var i=0;i<f.length;i++){var name=f[i];var found=voices.find(function(v){return v.lang.includes('en')&&v.name.toLowerCase().includes(name)&&!m.some(function(x){return v.name.toLowerCase().includes(x);});});if(found)return found;}return voices.find(function(v){return v.lang.includes('en')&&!m.some(function(x){return v.name.toLowerCase().includes(x);});})||voices[0];}
function speak(text,cb){window.speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(text);var voice=getBestFemaleVoice();if(voice)u.voice=voice;u.rate=.92;u.pitch=1.15;u.volume=1;u.onend=function(){cb&&cb();};u.onerror=function(){cb&&cb();};window.speechSynthesis.speak(u);}
function showNode(i){var n=document.getElementById('node'+i),h=document.getElementById('halo'+i);n.style.transition='opacity .4s ease,transform .5s cubic-bezier(.175,.885,.32,1.275)';n.style.opacity=1;n.style.transform='scale(1.5)';setTimeout(function(){n.style.transform='scale(1)';},400);h.style.transition='opacity .4s ease';h.style.opacity=.55;}
function showLabel(id){var el=document.getElementById(id);el.style.transition='opacity .8s ease';el.style.opacity=1;}
function drawLine(id){var el=document.getElementById(id);el.style.transition='stroke-dashoffset .6s cubic-bezier(.4,0,.2,1)';el.style.strokeDashoffset=0;}
function showVetted(){var el=document.getElementById('vetted-text');el.style.transition='opacity 1s ease,transform 1s cubic-bezier(.175,.885,.32,1.275)';el.style.opacity=1;el.style.transform='scale(1.1)';setTimeout(function(){el.style.transform='scale(1)';},1000);}
function showSingleRole(i){var l=document.getElementById('role'+i),s=document.getElementById('spoke'+i);l.style.transition='opacity .5s ease';l.style.opacity=1;s.style.transition='opacity .5s ease';s.style.opacity=1;}
function showAuthority(){var el=document.getElementById('authority-spoke'),l=document.getElementById('role7');el.style.transition='opacity 1s ease';el.style.opacity=1;l.style.transition='opacity 1s ease';l.style.opacity=1;var vt=document.getElementById('vetted-text');vt.style.transition='filter .5s ease';vt.style.filter='drop-shadow(0 0 28px rgba(56,211,159,.8))';setTimeout(function(){vt.style.filter='drop-shadow(0 0 16px rgba(56,211,159,.35))';},500);}
function resetVisuals(){document.querySelectorAll('.node').forEach(function(el){el.style.opacity=0;el.style.transform='scale(1)';});document.querySelectorAll('.node-halo').forEach(function(el){el.style.opacity=0;});document.querySelectorAll('.node-label').forEach(function(el){el.style.opacity=0;});document.querySelectorAll('.line,.cross-connection').forEach(function(el){el.style.strokeDashoffset=1000;});document.querySelectorAll('.role-label').forEach(function(el){el.style.opacity=0;});document.querySelectorAll('.role-spoke').forEach(function(el){el.style.opacity=0;});var vt=document.getElementById('vetted-text');vt.style.opacity=0;vt.style.transform='scale(.8)';vt.style.filter='drop-shadow(0 0 16px rgba(56,211,159,.35))';document.getElementById('lower-third').classList.remove('active');var intro=document.getElementById('intro-screen');intro.classList.remove('intro-active');intro.style.opacity=0;intro.style.visibility='hidden';}
var script=[{text:"First, Availability. The foundation of any booking system begins with what is available.",action:function(){showNode(1);showLabel('label1');}},{text:"Second, Communications. Availability is only useful when it is communicated clearly to the market.",action:function(){drawLine('line1');setTimeout(function(){showNode(2);showLabel('label2');},300);}},{text:"Third, Payments. Communication turns into action through secure transactions.",action:function(){drawLine('line2');setTimeout(function(){showNode(3);showLabel('label3');},300);setTimeout(function(){drawLine('cross13');},800);}},{text:"Fourth, Accounting. Every payment must be tracked and accounted for.",action:function(){drawLine('line3');setTimeout(function(){showNode(4);showLabel('label4');},300);setTimeout(function(){drawLine('line4');},800);setTimeout(function(){drawLine('cross42');},1100);}},{text:"But pillars alone are not trust. VRX vets the whole system. Every state, every step.",action:function(){showVetted();}},{text:"Developers, direct-sellers, and agents operate and communicate through the system.",action:function(){showSingleRole(0);setTimeout(function(){showSingleRole(1);},400);setTimeout(function(){showSingleRole(2);},800);}},{text:"Agencies, buyers, and direct-buyers transact securely across the network.",action:function(){showSingleRole(3);setTimeout(function(){showSingleRole(4);},400);setTimeout(function(){showSingleRole(5);},800);}},{text:"The CEO or Approver oversees financial accountability.",action:function(){showSingleRole(6);}},{text:"Finally, Authority Review sees the vetted state, without ever seeing private data.",action:function(){showAuthority();}},{text:"VRX. The complete, vetted booking ecosystem.",action:function(){}}];
var currentStep=0,paused=false,finished=false;
var ltBox=document.getElementById('lower-third');var ccText=document.getElementById('cc-text');var startOverlay=document.getElementById('start-overlay');
var controls=document.getElementById('controls');var pauseBtn=document.getElementById('pause-btn');var replayBtn=document.getElementById('replay-btn');var ppIcon=document.getElementById('pp-icon');
var PLAY_PATH='M8 5v14l11-7z';var PAUSE_PATH='M6 5h4v14H6zM14 5h4v14h-4z';
function setPauseIcon(){ppIcon.setAttribute('d',paused?PLAY_PATH:PAUSE_PATH);}
function playStep(){
  if(paused)return;
  if(currentStep>=script.length){finished=true;setPauseIcon();return;}
  var step=script[currentStep];
  ccText.textContent=step.text;ltBox.classList.add('active');step.action();
  speak(step.text,function(){if(paused)return;setTimeout(function(){if(paused)return;currentStep++;playStep();},600);});
}
function togglePause(){
  if(finished){replay();return;}
  paused=!paused;setPauseIcon();
  if(paused){window.speechSynthesis.cancel();}
  else{playStep();} // resume: re-narrate + continue the current step
}
function replay(){window.speechSynthesis.cancel();resetVisuals();currentStep=0;paused=false;finished=false;setPauseIcon();
  var intro=document.getElementById('intro-screen'),main=document.getElementById('main-screen');
  intro.style.opacity=1;intro.style.visibility='visible';intro.classList.add('intro-active');main.classList.remove('active');
  setTimeout(function(){intro.style.opacity=0;intro.style.visibility='hidden';main.classList.add('active');setTimeout(playStep,800);},3500);
}
function startBroadcast(){
  startOverlay.style.opacity=0;setTimeout(function(){startOverlay.style.display='none';},500);
  controls.classList.add('visible');setPauseIcon();
  replay();
}
loadVoices();
startOverlay.addEventListener('click',startBroadcast);
pauseBtn.addEventListener('click',function(e){e.stopPropagation();togglePause();});
replayBtn.addEventListener('click',function(e){e.stopPropagation();replay();});
</script></body></html>`;

export default function VrxExplainer() {
  return (
    <iframe
      title="VRX explainer"
      srcDoc={DOC}
      sandbox="allow-scripts"
      style={{ width: "100%", height: "100%", border: "none", display: "block", background: "#05070c" }}
    />
  );
}
