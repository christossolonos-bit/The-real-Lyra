// Her mind, the one brain: the neurons, fibres, travelling lightning and the web of things she knows, fired by her
// real events. The Mind page (mind.html) draws it full size with its camera, captions and panels; her avatar
// (avatar-mind.js) draws the very same brain inside her eyes, so her irises flash in step with the Mind page and
// zooming into an eye takes you into it. Nothing here runs on its own: every flash comes from an event on
// /api/events (listenMind) or her body stream (body()).
//
//   const mind = createMind(THREE, { persist, onRegion, onTouch, onGrow });
//   scene.add(mind.group); each frame: mind.update(dt); mind.setScale(k) on resize.
//   listenMind(mind, { onEvent(e, r, made, newSparks), onReplay(e, r), onOpen, onError });

// The regions of her mind, placed in a brain volume (x: left-right, y: up, z: front-back), and their colours.
export const REGION_COLORS = {
  hearing: '#39c6ff', intake: '#8b5cf6', pressure: '#ff5c8a', feelings: '#ffb347', memory: '#2dd4bf', curiosity: '#f472b6',
  tools: '#a3e635', voice: '#fb7185', body: '#60a5fa', presence: '#c084fc', architect: '#f59e0b', errors: '#ef4444',
  thoughts: '#e879f9', intuition: '#d946ef', taste: '#34d399', sleep: '#64748b',
};
export const REGIONS = {
  hearing:{label:'Hearing',p:[-1.05,-0.05,0.0]}, intake:{label:'Intake',p:[-0.55,0.25,0.35]}, memory:{label:'Memory',p:[-0.55,-0.35,-0.35]},
  curiosity:{label:'Curiosity',p:[-0.15,0.65,0.55]}, pressure:{label:'Pressure',p:[0,0.05,0.1]}, feelings:{label:'Feelings',p:[0.45,0.3,0.4]},
  taste:{label:'Taste',p:[-0.25,-0.6,0.3]}, intuition:{label:'Intuition',p:[0.35,-0.3,-0.3]}, thoughts:{label:'Thoughts',p:[0.1,0.7,-0.3]},
  tools:{label:'Hands',p:[0.95,-0.1,-0.35]}, voice:{label:'Voice',p:[1.0,0.05,0.4]}, body:{label:'Body',p:[0.55,0.6,-0.15]},
  presence:{label:'Presence',p:[-0.7,0.6,-0.1]}, architect:{label:'Architect',p:[0.7,-0.5,0.3]}, sleep:{label:'Sleep',p:[-0.2,-0.55,-0.75]}, errors:{label:'Faults',p:[0.25,-0.75,-0.6]},
};
export const AXONS=[['hearing','intake'],['intake','pressure'],['intake','feelings'],['intake','memory'],['pressure','feelings'],['pressure','voice'],['pressure','tools'],['pressure','curiosity'],['curiosity','memory'],['curiosity','voice'],['memory','voice'],['feelings','body'],['feelings','voice'],['taste','feelings'],['hearing','taste'],['hearing','intuition'],['intuition','voice'],['intuition','memory'],['thoughts','pressure'],['thoughts','memory'],['tools','voice'],['tools','memory'],['presence','pressure'],['presence','hearing'],['architect','tools'],['architect','feelings'],['sleep','pressure'],['errors','tools'],['body','voice'],['errors','voice']];
export const KEYS = Object.keys(REGIONS);

// Where a thing she knows lives in her brain: people with hearing (whom she hears), ideas with thoughts, everything
// else she knows (places, things, events, projects...) in memory.
export const regionOfType=(type)=>type==='person'?'hearing':type==='idea'?'thoughts':'memory';
// Where points land: what she learned in memory, bonds in feelings, her mind growing in thoughts, standing in presence.
export const POINTS_REGION={knowledge:'memory',bond:'feelings',mind:'thoughts',standing:'presence'};

// ---------- events -> regions: where each of her events lands, how hard, and the words it carries ----------
// Every activity() type she emits must land somewhere — explicit first, then a family heuristic, never null.
export function route(e){const t=e.type;
  if(t==='heard')return{at:'hearing',note:`${e.speaker}: ${e.text??''}`,amp:1};
  if(t==='intake'){const sig=Object.entries(e).filter(([k,v])=>typeof v==='number'&&k!=='time');return{at:'intake',note:sig.map(([k,v])=>`${k} ${v}`).join(', ')||'read: nothing notable',amp:0.6+Math.min(0.8,sig.reduce((s,[,v])=>s+v,0)*0.4)};}
  if(t==='pressure'){if(e.fired)return{at:'pressure',note:`${e.fired} fired: ${e.want??''}`,amp:1.5,also:e.doing==='speak'?'voice':['build','research','goal-work','songwrite'].includes(e.doing)?'tools':null};
    if(e.spoke)return{at:'pressure',note:`spoke from ${e.spoke}${e.to?` → ${e.to}`:''}`,amp:1.1,also:'voice'};
    if(e.uptake||e.wanted||e.home||e.discovered)return{at:'feelings',note:e.uptake?`uptake ${e.uptake}`:e.wanted?'wanted':e.home?`home ${e.home}`:`discovered ${e.discovered}`,amp:0.9};
    if(e.sound)return{at:'hearing',note:`sound calm ${e.calm} energy ${e.energy}`,amp:0.3};return{at:'pressure',note:e.message??(e.quiet?'quiet':e.clamp??'tick'),amp:0.4};}
  if(t==='replied')return{at:'voice',note:e.text??'',amp:1.2};
  if(t==='plan'){const tools=(e.tools||[]).join(', ');return{at:'thoughts',note:e.empty?'chat only':`${tools||'no tools'}${e.search?` · search: ${e.search}`:''}${e.reason?` · ${e.reason}`:''}`,amp:e.empty?0.5:1.1,also:tools?'tools':e.search?'curiosity':null};}
  if(t==='tool-call')return{at:e.ok?'tools':'errors',note:`${e.tool}${e.action?' '+e.action:''}${e.ok?'':' FAILED: '+(e.error??'')}`,amp:e.ok?0.9:1.3};
  if(t==='hands')return{at:'tools',note:`hands: ${(e.calls||[]).join(', ')||'no tools'}`,amp:0.7};
  if(t==='music')return{at:'tools',note:e.playing?`playing ${e.playing}`:`music ${e.action||''}${(e.tracks||[]).length?`: ${(e.tracks||[]).slice(0,3).join(', ')}`:e.query?`: ${e.query}`:''}`,amp:1,also:'voice'};
  if(t==='search')return{at:'curiosity',note:`search: ${e.query??e.message??''}`,amp:1,also:'tools'};
  if(t==='file')return{at:'tools',note:`file ${e.filename||''} → ${e.to||''}`,amp:0.9};
  if(t==='git')return{at:'tools',note:`git ${e.push||e.message||''}`,amp:0.9};
  if(t==='feeds')return{at:'curiosity',note:`feeds ${e.action||''}: ${e.fresh??0} fresh / ${e.read??e.items??0} read`,amp:0.8};
  if(t==='remembered'||t==='recall'||t==='memory'||t==='memory-wiped'||t==='topic'||t==='listen'||t==='summarized')return{at:'memory',note:(e.facts||[]).join('; ')||e.preview||e.message||`${t}${e.count!=null?` ×${e.count}`:''}`,amp:0.9};
  if(t==='curiosity'||t==='question-forge'||t==='self-realize'||t==='journal')return{at:'curiosity',note:e.wondering??e.asked??e.answered??e.dropped??e.aspect??e.title??e.query??e.message??t,amp:0.9};
  if(t==='discovery')return{at:'feelings',note:`first use: ${e.tool}`,amp:1.1};
  if(t==='intuition')return{at:'intuition',note:e.gut??e.repeated??e.cue??'',amp:0.8};
  if(t==='reaction')return{at:'taste',note:`${e.style} at ${e.speaker}: ${e.why??''}`,amp:0.9};
  if(t==='thought'||t==='persona')return{at:'thoughts',note:e.topic??e.reason??e.message??t,amp:1};
  if(t==='expression'||t==='body'||t==='avatar'||t==='video'||t==='settings')return{at:'body',note:e.feelings??e.message??t,amp:0.6};
  if(t==='away'||t==='quiet-time'||t==='open-question'||t==='voice-guest'||t==='voice-join'||t==='voice-leave'||t==='obligation'||t==='checkin'||t==='contact'||t==='ready'||t==='power'||t==='mic')return{at:'presence',note:Object.entries(e).filter(([k])=>!['type','time'].includes(k)).map(([k,v])=>`${k} ${typeof v==='object'?JSON.stringify(v):v}`).join(', ').slice(0,140),amp:0.9};
  if(t==='barge-in')return{at:'voice',note:`interrupted in ${e.guild||'call'}`,amp:1.1};
  if(t==='architect'||t==='doctor'||t==='task')return{at:'architect',note:`${t} ${e.status??''}: ${e.task??e.title??e.message??''}`,amp:1};
  if(t==='sleep'||t==='dream')return{at:'sleep',note:e.message??e.scene??t,amp:0.8};
  if(t==='error'||t==='failure')return{at:'errors',note:`${e.where??e.kind??''}: ${e.message??e.note??''}`,amp:1.4};
  // The Student: her knowledge growing, her fact checks, finding out together, and the points game
  if(t==='learned')return{at:regionOfType(e.nodeType),note:e.kind==='fact'?`learned: ${e.name}: ${e.text}${e.saidBy?` (from ${e.saidBy})`:''}`:e.kind==='link'?`connected: ${e.text}`:`new: ${e.name}`,amp:e.kind==='fact'?1.4:1.1};
  if(t==='fact-check')return{at:'curiosity',note:`checked "${e.claim}"${e.by?` (${e.by})`:''}: ${e.verdict}${e.correct?`, actually: ${e.correct}`:''}`,amp:1.2};
  if(t==='learn-together')return{at:'curiosity',note:e.understood?`understood with ${e.with}: ${e.understood}`:`finding out with ${e.with}: ${e.question}`,amp:1.2};
  if(t==='points')return{at:POINTS_REGION[e.category]??'feelings',note:`${e.delta>0?'+':''}${e.delta} ${e.side==='theirs'?`to ${e.person}`:e.category}: ${e.reason??''}`,amp:e.leveledUp?1.8:1};
  const fam=/avatar|body|outfit|look|view|dance|gesture|face|eye|video|settings/.test(t)?'body':/voice|speech|tts|speak|say|talk|turn|interrupt|barge|floor|mic|music/.test(t)?'voice':/memor|remember|recall|summar|consolid|profile|contact|kg|graph|journal|note|obligation/.test(t)?'memory':/tool|browser|file|project|build|workshop|image|generat|git|coder|hands|search|feed/.test(t)?'tools':/sleep|dream|rest|nap/.test(t)?'sleep':/presence|join|leave|guest|away|quiet|room|ready|power|checkin/.test(t)?'presence':/curio|wonder|question|research|read|rss|explore|interest/.test(t)?'curiosity':/feel|emotion|mood|arousal|taste|reaction|joy|thrill/.test(t)?'feelings':/think|thought|reflect|intuit|realiz|ponder|self|plan|persona/.test(t)?'thoughts':/hear|listen|sound|transcri|stt|wake/.test(t)?'hearing':'pressure';
  return{at:fam,note:`${t}: ${Object.entries(e).filter(([k])=>!['type','time'].includes(k)).map(([k,v])=>`${k} ${typeof v==='object'?JSON.stringify(v):v}`).join(', ').slice(0,120)}`,amp:0.6};}

// what an event references, by region: the things she knows that this touched
export function references(e){const t=e.type,out=[];const sp=e.speaker&&typeof e.speaker==='string'?e.speaker:e.speaker?.name||e.name||e.to;
  const who=sp?{region:'hearing',label:String(sp).slice(0,40)}:null;
  if(t==='heard'&&who)out.push(who);
  if(t==='remembered'||t==='memory'){if(who)out.push(who);for(const f of (e.facts||[]).slice(0,4))out.push({region:'memory',label:String(f).replace(/^[^:]{0,40}:\s*/,'').slice(0,60),with:who});if(e.preview)out.push({region:'memory',label:String(e.preview).slice(0,60),with:who});}
  if(t==='tool-call')out.push({region:e.ok?'tools':'errors',label:`${e.tool}${e.action?' '+e.action:''}`,with:who});
  if(t==='hands')for(const c of (e.calls||[]).slice(0,6))out.push({region:'tools',label:c});
  if(t==='plan'){out.push({region:'thoughts',label:e.empty?'chat only':'planning'});for(const c of (e.tools||[]).slice(0,6))out.push({region:'tools',label:c});if(e.search)out.push({region:'curiosity',label:String(e.search).slice(0,50)});}
  if(t==='music')out.push({region:'tools',label:String(e.playing||e.action||'music').slice(0,50)},{region:'voice',label:'playing'});
  if(t==='search')out.push({region:'curiosity',label:String(e.query||'search').slice(0,50)},{region:'tools',label:'web_search'});
  if(t==='file')out.push({region:'tools',label:String(e.filename||'file').slice(0,50)});
  if(t==='git')out.push({region:'tools',label:'git'});
  if(t==='feeds')out.push({region:'curiosity',label:`feeds ${e.action||''}`.trim()});
  if(t==='intake')for(const [k,v] of Object.entries(e))if(typeof v==='number'&&k!=='time'&&v>=0.4)out.push({region:'intake',label:k.replace(/_/g,' '),with:who,amp:v});
  if(t==='curiosity'||t==='journal')out.push({region:'curiosity',label:e.area??(e.wondering??e.asked??e.answered??e.dropped??e.title??e.query??'').slice(0,60),with:e.of?{region:'hearing',label:e.of}:who});
  if(t==='listen'||t==='topic')for(const x of (e.topics||[e.topic]).filter(Boolean).slice(0,3))out.push({region:'curiosity',label:String(x).slice(0,50)});
  if(t==='discovery')out.push({region:'tools',label:e.tool,with:{region:'feelings',label:'thrill'}});
  if(t==='pressure'&&e.fired)out.push({region:'pressure',label:e.fired});
  if(t==='pressure'&&e.spoke)out.push({region:'pressure',label:e.spoke},{region:'voice',label:'spoke up'});
  if(t==='pressure'&&e.uptake)out.push({region:'feelings',label:`uptake ${e.uptake}`,with:e.by?{region:'hearing',label:e.by}:null});
  if(t==='pressure'&&e.home)out.push({region:'feelings',label:`home ${e.home}`});
  if(t==='expression'&&typeof e.feelings==='string')for(const m of e.feelings.matchAll(/([a-z]+) 0?\.(\d)/g))if(+m[2]>=4)out.push({region:'feelings',label:m[1]});
  if(t==='reaction')out.push({region:'taste',label:e.style,with:who});
  if(t==='intuition')out.push({region:'intuition',label:(e.gut??e.repeated??'').slice(0,50),with:e.about?{region:'hearing',label:e.about}:who});
  if(t==='thought'||t==='persona')out.push({region:'thoughts',label:(e.topic??e.reason??'persona').slice(0,50)});
  if(t==='away')out.push({region:'presence',label:`${e.who} ${e.back?'back':'away'}`});if(t==='quiet-time')out.push({region:'presence',label:`quiet time with ${e.with}`});
  if(t==='open-question')out.push({region:'presence',label:(e.nudged??e.dropped??'question').slice(0,50),with:e.to?{region:'hearing',label:e.to}:null});
  if(t==='voice-guest'||t==='voice-join'||t==='voice-leave')out.push({region:'presence',label:e.joined??e.left??e.channel??e.guild??t});
  if(t==='obligation'||t==='checkin'||t==='contact'){if(who)out.push(who);out.push({region:'presence',label:t});}
  if(t==='barge-in')out.push({region:'voice',label:'barge-in'});
  if(t==='avatar'||t==='video'||t==='settings')out.push({region:'body',label:String(e.message||t).slice(0,50)});
  if(t==='sleep'||t==='dream')out.push({region:'sleep',label:String(e.message||e.scene||t).slice(0,50)});
  if(t==='architect'||t==='doctor'||t==='task')out.push({region:'architect',label:`${t}: ${(e.task??e.title??e.status??'').slice(0,40)}`});
  if(t==='replied')out.push({region:'voice',label:`reply ${new Date(e.time).toLocaleTimeString([],{hour12:false})}`,with:who});
  if(t==='error'||t==='failure')out.push({region:'errors',label:(e.where??e.kind??'fault').slice(0,40)});
  // something she now knows: its neuron (the same one her knowledge web loaded for it), linked to who taught her
  const teacher=e.saidBy?{region:'hearing',label:e.saidBy}:null;
  // (a link only lights; its two ends are joined when the web is next loaded, where their real kinds are known)
  if(t==='learned'&&e.kind!=='link')out.push({region:regionOfType(e.nodeType),label:e.name,with:teacher,amp:1.4});
  return out;}

// lightning paths: jagged, re-jittered as the bolt travels
export function boltPath(A,B,seed){const n=7,out=[];const dx=B[0]-A[0],dy=B[1]-A[1],dz=B[2]-A[2];
  // two perpendiculars to the line, so the kinks go sideways in 3D
  let ux=-dy,uy=dx,uz=0;let ul=Math.hypot(ux,uy,uz);if(ul<1e-4){ux=0;uy=-dz;uz=dy;ul=Math.hypot(ux,uy,uz)||1;}ux/=ul;uy/=ul;uz/=ul;const vx=dy*uz-dz*uy,vy=dz*ux-dx*uz,vz=dx*uy-dy*ux;const vl=Math.hypot(vx,vy,vz)||1;
  let s=seed>>>0;const rnd2=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296-0.5;};
  for(let i=0;i<=n;i++){const u=i/n;const amp=(i===0||i===n)?0:len3(dx,dy,dz)*0.09*Math.sin(u*Math.PI);const a=rnd2()*amp,b=rnd2()*amp;out.push([A[0]+dx*u+ux*a+vx/vl*b,A[1]+dy*u+uy*a+vy/vl*b,A[2]+dz*u+uz*a+vz/vl*b]);}return out;}
const len3=(x,y,z)=>Math.hypot(x,y,z)||1;
export function alongPath(path,u){const seg=Math.min(path.length-2,Math.floor(u*(path.length-1)));const f=u*(path.length-1)-seg;const a=path[seg],b=path[seg+1];return[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f];}

// Build her brain. Her knowledge web loads from what she really knows (/api/knowledge); persist is no longer used.
// Hooks: onRegion(k, amp) when a region fires, onTouch(item, fresh) when something she knows is touched,
// onGrow(count) when her knowledge web grows.
export function createMind(THREE,{persist=false,onRegion,onTouch,onGrow}={}){
const colorOf={};for(const k of KEYS)colorOf[k]=new THREE.Color(REGION_COLORS[k]);
const group=new THREE.Group();
// ---------- neurons: a cortex-weighted cloud inside two hemispheres + cerebellum, each owned by the nearest region ----------
const N=3400;
const rnd=(()=>{let s=1337;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};})();
function sample(){for(;;){const x=(rnd()*2-1)*1.3,y=(rnd()*2-1)*1.0,z=(rnd()*2-1)*1.1;
  const hemi=(cx)=>((x-cx)/0.72)**2+((y-0.05)/0.78)**2+(z/1.0)**2;const d=Math.min(hemi(-0.55),hemi(0.55));const cb=((x)/0.5)**2+((y+0.65)/0.3)**2+((z+0.65)/0.35)**2;
  if(d<1||cb<1){const r=Math.sqrt(Math.min(d,cb));if(rnd()<0.25+0.75*r*r)return[x,y,z];}}}
const pos=new Float32Array(N*3),col=new Float32Array(N*3),base=new Float32Array(N),act=new Float32Array(N),size=new Float32Array(N),owner=new Uint8Array(N);
const byRegion={};for(const k of KEYS)byRegion[k]=[];
for(let i=0;i<N;i++){const [x,y,z]=sample();pos[i*3]=x;pos[i*3+1]=y;pos[i*3+2]=z;let best=0,bd=1e9;KEYS.forEach((k,j)=>{const p=REGIONS[k].p;const d=(x-p[0])**2+(y-p[1])**2+(z-p[2])**2;if(d<bd){bd=d;best=j;}});owner[i]=best;byRegion[KEYS[best]].push(i);const c=colorOf[KEYS[best]];col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;base[i]=0.05;size[i]=1+rnd()*1.2;}
// hubs: the neuron nearest each region centre
const hub={};for(const k of KEYS){const p=REGIONS[k].p;let b=-1,bd=1e9;for(const i of byRegion[k]){const d=(pos[i*3]-p[0])**2+(pos[i*3+1]-p[1])**2+(pos[i*3+2]-p[2])**2;if(d<bd){bd=d;b=i;}}hub[k]=b;}
// ---------- dendrites: k nearest neighbours within a region (grid hashed), axons: nearest cross pairs between wired regions ----------
const adj=Array.from({length:N},()=>[]);const segs=[];const segOf=[];
const cell=0.16,grid=new Map();const key=(x,y,z)=>`${Math.floor(x/cell)},${Math.floor(y/cell)},${Math.floor(z/cell)}`;
for(let i=0;i<N;i++){const k=key(pos[i*3],pos[i*3+1],pos[i*3+2]);(grid.get(k)||grid.set(k,[]).get(k)).push(i);}
function link(a,b,kind){if(a===b||adj[a].includes(b))return;adj[a].push(b);adj[b].push(a);segs.push(a,b);segOf.push(kind);}
for(let i=0;i<N;i++){const cx=Math.floor(pos[i*3]/cell),cy=Math.floor(pos[i*3+1]/cell),cz=Math.floor(pos[i*3+2]/cell);const near=[];
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){const g=grid.get(`${cx+dx},${cy+dy},${cz+dz}`);if(g)for(const j of g)if(j!==i&&owner[j]===owner[i]){const d=(pos[i*3]-pos[j*3])**2+(pos[i*3+1]-pos[j*3+1])**2+(pos[i*3+2]-pos[j*3+2])**2;near.push([d,j]);}}
  near.sort((a,b)=>a[0]-b[0]);for(const [,j] of near.slice(0,3))link(i,j,0);}
const axonSegs=[];
for(const [a,b] of AXONS){const A=byRegion[a],B=byRegion[b];const pairs=[];for(let s=0;s<140;s++){const i=A[Math.floor(rnd()*A.length)],j=B[Math.floor(rnd()*B.length)];const d=(pos[i*3]-pos[j*3])**2+(pos[i*3+1]-pos[j*3+1])**2+(pos[i*3+2]-pos[j*3+2])**2;pairs.push([d,i,j]);}
  pairs.sort((x,y)=>x[0]-y[0]);for(const [,i,j] of pairs.slice(0,5)){link(i,j,1);axonSegs.push({a,b,i,j});}}
// ---------- three.js ----------
const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.setAttribute('color',new THREE.BufferAttribute(col,3));geo.setAttribute('aBase',new THREE.BufferAttribute(base,1));geo.setAttribute('aAct',new THREE.BufferAttribute(act,1));geo.setAttribute('aSize',new THREE.BufferAttribute(size,1));
const vert=`attribute float aBase;attribute float aAct;attribute float aSize;varying float vI;varying vec3 vC;uniform float uScale;void main(){vI=clamp(aBase+aAct,0.0,1.6);vC=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=(aSize*(2.6+vI*6.0))*uScale/-mv.z;gl_Position=projectionMatrix*mv;}`;
const frag=`varying float vI;varying vec3 vC;void main(){vec2 d=gl_PointCoord-0.5;float r=length(d);if(r>0.5)discard;float core=smoothstep(0.5,0.0,r);float a=core*core*(0.42+vI*0.9);vec3 c=mix(vC,vec3(1.0),vI*0.55);gl_FragColor=vec4(c*a*(1.0+vI*1.6),a);}`;
const mat=new THREE.ShaderMaterial({vertexShader:vert,fragmentShader:frag,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uScale:{value:1}}});
group.add(new THREE.Points(geo,mat));
// Fibers, not wires: every dendrite and axon is a curved strand (a bent bezier with a slow wobble), built
// once as a polyline. Dendrites get 4 pieces, the long axons 10.
function perps(A,B){const dx=B[0]-A[0],dy=B[1]-A[1],dz=B[2]-A[2];let ux=-dy,uy=dx,uz=0;let ul=Math.hypot(ux,uy,uz);if(ul<1e-4){ux=0;uy=-dz;uz=dy;ul=Math.hypot(ux,uy,uz)||1;}ux/=ul;uy/=ul;uz/=ul;let vx=dy*uz-dz*uy,vy=dz*ux-dx*uz,vz=dx*uy-dy*ux;const vl=Math.hypot(vx,vy,vz)||1;vx/=vl;vy/=vl;vz/=vl;return{dx,dy,dz,len:Math.hypot(dx,dy,dz)||1,u:[ux,uy,uz],v:[vx,vy,vz]};}
function strand(A,B,n,seed){const P=perps(A,B);let s=seed>>>0;const r=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296-0.5;};const b1=r()*P.len*0.5,b2=r()*P.len*0.5,w=r()*P.len*0.12,ph=r()*6.28;const out=[];
  for(let i=0;i<=n;i++){const t=i/n;const bez=4*t*(1-t);const wob=Math.sin(t*Math.PI*2+ph)*Math.sin(t*Math.PI)*w;out.push([A[0]+P.dx*t+P.u[0]*(b1*bez+wob)+P.v[0]*b2*bez,A[1]+P.dy*t+P.u[1]*(b1*bez+wob)+P.v[1]*b2*bez,A[2]+P.dz*t+P.u[2]*(b1*bez+wob)+P.v[2]*b2*bez]);}return out;}
const linkStart=[],linkCount=[];let total=0;for(let l=0;l<segs.length/2;l++)total+=(segOf[l]?10:4)*2;
const lpos=new Float32Array(total*3),lcol=new Float32Array(total*3),lact=new Float32Array(total),lkind=new Float32Array(total);
{let v=0;for(let l=0;l<segs.length/2;l++){const a=segs[l*2],b=segs[l*2+1],n=segOf[l]?10:4;const pts=strand([pos[a*3],pos[a*3+1],pos[a*3+2]],[pos[b*3],pos[b*3+1],pos[b*3+2]],n,a*7919+b*104729);linkStart[l]=v;linkCount[l]=n*2;
  for(let i=0;i<n;i++){for(const p of [pts[i],pts[i+1]]){lpos[v*3]=p[0];lpos[v*3+1]=p[1];lpos[v*3+2]=p[2];const src=i<n/2?a:b;lcol[v*3]=col[src*3];lcol[v*3+1]=col[src*3+1];lcol[v*3+2]=col[src*3+2];lkind[v]=segOf[l];v++;}}}}
const lgeo=new THREE.BufferGeometry();lgeo.setAttribute('position',new THREE.BufferAttribute(lpos,3));lgeo.setAttribute('color',new THREE.BufferAttribute(lcol,3));lgeo.setAttribute('aAct',new THREE.BufferAttribute(lact,1));lgeo.setAttribute('aKind',new THREE.BufferAttribute(lkind,1));
// Connections stay fibers: they warm a little in their own colour when a signal is on them, never to
// white, never bright. The travelling bolt is the flash; a straight line lighting up beside it was the
// "straight shot" that kept showing.
const lmat=new THREE.ShaderMaterial({vertexShader:`attribute float aAct;attribute float aKind;varying float vA;varying vec3 vC;void main(){vA=min(aAct,0.35);vC=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,fragmentShader:`varying float vA;varying vec3 vC;void main(){float a=0.10+vA*0.45;gl_FragColor=vec4(vC*(0.7+vA*1.2),a);}`,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
group.add(new THREE.LineSegments(lgeo,lmat));
// signals travelling along axons
const MAXS=400;const spos=new Float32Array(MAXS*3),scol=new Float32Array(MAXS*3);const sparks=[];
const sgeo=new THREE.BufferGeometry();sgeo.setAttribute('position',new THREE.BufferAttribute(spos,3));sgeo.setAttribute('color',new THREE.BufferAttribute(scol,3));sgeo.setDrawRange(0,0);
const smat=new THREE.ShaderMaterial({vertexShader:`uniform float uScale;varying vec3 vC;void main(){vC=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=3.2*uScale/-mv.z;gl_Position=projectionMatrix*mv;}`,fragmentShader:`varying vec3 vC;void main(){float r=length(gl_PointCoord-0.5);if(r>0.5)discard;float a=smoothstep(0.5,0.0,r);gl_FragColor=vec4(mix(vC,vec3(1.0),0.6)*a*2.0,a);}`,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uScale:{value:1}}});
group.add(new THREE.Points(sgeo,smat));
// lightning: each signal walks a jagged path that re-jitters as it goes; the bolt is drawn behind the head and flickers
const BOLTCAP=MAXS*8;const bpos=new Float32Array(BOLTCAP*2*3),bcol=new Float32Array(BOLTCAP*2*3),bact=new Float32Array(BOLTCAP*2),bkind=new Float32Array(BOLTCAP*2);
const bgeo=new THREE.BufferGeometry();bgeo.setAttribute('position',new THREE.BufferAttribute(bpos,3));bgeo.setAttribute('color',new THREE.BufferAttribute(bcol,3));bgeo.setAttribute('aAct',new THREE.BufferAttribute(bact,1));bgeo.setAttribute('aKind',new THREE.BufferAttribute(bkind,1));bgeo.setDrawRange(0,0);
const bmat=new THREE.ShaderMaterial({vertexShader:`attribute float aAct;varying float vA;varying vec3 vC;void main(){vA=aAct;vC=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,fragmentShader:`varying float vA;varying vec3 vC;void main(){gl_FragColor=vec4(mix(vC,vec3(1.0),0.5)*vA*2.2,vA);}`,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
group.add(new THREE.LineSegments(bgeo,bmat));
// ---------- her knowledge: a neuron per thing she has referenced, grown on first touch, linked to what it came with ----------
// Facts she remembered, tools she called, people she heard, areas she wondered about, feelings she showed, signals
// her intake read: each is a neuron inside its region. Touching it again brightens it, grows it, and sends sparks
// down its links. Links form between things referenced together (a fact and who said it, a tool and who asked,
// two things in the same minute), and strengthen each time they fire together. What she really knows is loaded from
// her knowledge graph (loadItems, below); the rest lights for the moment and isn't kept.
const CAP=2200,LCAP=5000,KV=8; // knowledge links: 4 curved pieces = 8 vertices each
const ipos=new Float32Array(CAP*3),icol=new Float32Array(CAP*3),iact=new Float32Array(CAP),ibase=new Float32Array(CAP),isize=new Float32Array(CAP);
const lpos2=new Float32Array(LCAP*KV*3),lcol2=new Float32Array(LCAP*KV*3),lact2=new Float32Array(LCAP*KV),lkind2=new Float32Array(LCAP*KV);
const items=new Map();const itemList=[];const ilinks=[];let lastTouched=[];
function inside(x,y,z){const hemi=(cx)=>((x-cx)/0.72)**2+((y-0.05)/0.78)**2+(z/1.0)**2;return Math.min(hemi(-0.55),hemi(0.55))<0.98||(((x)/0.5)**2+((y+0.65)/0.3)**2+((z+0.65)/0.35)**2)<0.98;}
function hash(s){let h=2166136261;for(const ch of String(s))h=Math.imul(h^ch.charCodeAt(0),16777619)>>>0;return h;}
function place(region,label){const p=REGIONS[region].p;const h=hash(region+'|'+label);for(let t=0;t<24;t++){const a=((h>>(t%20))%360)/180*Math.PI+t*0.7,b=(((h>>3)+t*53)%180)/180*Math.PI,r=0.12+((h>>7)%100)/100*0.3;const x=p[0]+Math.sin(b)*Math.cos(a)*r,y=p[1]+Math.cos(b)*r*0.8,z=p[2]+Math.sin(b)*Math.sin(a)*r;if(inside(x,y,z))return[x,y,z];}return[p[0],p[1],p[2]];}
const igeo=new THREE.BufferGeometry();igeo.setAttribute('position',new THREE.BufferAttribute(ipos,3));igeo.setAttribute('color',new THREE.BufferAttribute(icol,3));igeo.setAttribute('aBase',new THREE.BufferAttribute(ibase,1));igeo.setAttribute('aAct',new THREE.BufferAttribute(iact,1));igeo.setAttribute('aSize',new THREE.BufferAttribute(isize,1));igeo.setDrawRange(0,0);
const ilgeo=new THREE.BufferGeometry();ilgeo.setAttribute('position',new THREE.BufferAttribute(lpos2,3));ilgeo.setAttribute('color',new THREE.BufferAttribute(lcol2,3));ilgeo.setAttribute('aAct',new THREE.BufferAttribute(lact2,1));ilgeo.setAttribute('aKind',new THREE.BufferAttribute(lkind2,1));ilgeo.setDrawRange(0,0);
function addItem(region,label,count=1){const key=region+'|'+label;if(items.has(key))return items.get(key);if(itemList.length>=CAP)return null;const idx=itemList.length;const [x,y,z]=place(region,label);ipos[idx*3]=x;ipos[idx*3+1]=y;ipos[idx*3+2]=z;const c=colorOf[region];icol[idx*3]=Math.min(1,c.r*0.75+0.25);icol[idx*3+1]=Math.min(1,c.g*0.75+0.25);icol[idx*3+2]=Math.min(1,c.b*0.75+0.25);
  const it={idx,region,label,count,links:new Set()};items.set(key,it);itemList.push(it);ibase[idx]=0.08+Math.min(0.4,count*0.03);isize[idx]=1.4+Math.min(2.2,count*0.15);iact[idx]=0;igeo.setDrawRange(0,itemList.length);onGrow?.(itemList.length);return it;}
function addLink(a,b,strength=1){if(!a||!b||a===b)return;const k=a.idx<b.idx?`${a.idx}:${b.idx}`:`${b.idx}:${a.idx}`;let L=ilinks.find((l)=>l.key===k);if(L){L.strength=Math.min(3,L.strength+strength*0.4);}else{if(ilinks.length>=LCAP)return;L={key:k,a,b,strength};ilinks.push(L);a.links.add(b.idx);b.links.add(a.idx);const base0=(ilinks.length-1)*KV;const pts=strand([ipos[a.idx*3],ipos[a.idx*3+1],ipos[a.idx*3+2]],[ipos[b.idx*3],ipos[b.idx*3+1],ipos[b.idx*3+2]],KV/2,a.idx*7919+b.idx*104729);
    let v=base0;for(let i=0;i<KV/2;i++){for(const p of [pts[i],pts[i+1]]){const it=i<KV/4?a:b;lpos2[v*3]=p[0];lpos2[v*3+1]=p[1];lpos2[v*3+2]=p[2];lcol2[v*3]=icol[it.idx*3];lcol2[v*3+1]=icol[it.idx*3+1];lcol2[v*3+2]=icol[it.idx*3+2];lkind2[v]=1;v++;}}ilgeo.setDrawRange(0,ilinks.length*KV);}return L;}
// a reference: brighten, grow, link to what came with it, spark along every link
function touch(region,label,withItems=[],amp=1){label=String(label??'').trim().slice(0,60);if(!label)return null;const fresh=!items.has(region+'|'+label);const it=addItem(region,label);if(!it)return null;if(!fresh){it.count++;ibase[it.idx]=0.08+Math.min(0.4,it.count*0.03);isize[it.idx]=1.4+Math.min(2.2,it.count*0.15);}
  iact[it.idx]=Math.min(1.8,iact[it.idx]+(fresh?1.5:amp));
  for(const o of withItems)if(o&&o!==it){addLink(it,o);}
  // things referenced within the last 40 s belong together
  const now=performance.now();lastTouched=lastTouched.filter((t)=>now-t.at<40_000);for(const t of lastTouched.slice(-3))if(t.it!==it&&t.it.region!==it.region||t.it!==it&&lastTouched.length<2)addLink(it,t.it,0.5);lastTouched.push({it,at:now});
  for(const j of it.links){const o=itemList[j];sparks.push({fromP:[ipos[it.idx*3],ipos[it.idx*3+1],ipos[it.idx*3+2]],toP:[ipos[o.idx*3],ipos[o.idx*3+1],ipos[o.idx*3+2]],t:0,amp:0.5,c:colorOf[region],item:o});}
  // and to its region's hub, so the region lights with it
  const h=hub[region];sparks.push({fromP:[ipos[it.idx*3],ipos[it.idx*3+1],ipos[it.idx*3+2]],toP:[pos[h*3],pos[h*3+1],pos[h*3+2]],t:0,amp:0.4,c:colorOf[region],to:region});
  onTouch?.(it,fresh);saveItems();return it;}
// Her knowledge web comes from what she really knows (owner, 2026-11-15: "instead of a static graph, I want it to
// grow with all the new knowledge"): on load, every thing in her knowledge graph (/api/knowledge, kg.js web()) is a
// neuron in its region, bigger the more facts it holds, joined by the links she knows between them. It used to be
// kept in this browser's storage, built from whatever words went by; now every page and her eyes load the same real
// web, and it grows live as she learns (her 'learned' events). Things an event merely touches still light up for
// the moment, as before.
function saveItems(){}
async function loadItems(){try{const r=await fetch('/api/knowledge');if(!r.ok)return;const k=await r.json();const byId=new Map();
  for(const n of k.nodes||[]){const it=addItem(regionOfType(n.type),String(n.name).trim().slice(0,60),1+(n.facts||0));if(it){it.known=true;byId.set(n.id,it);}}
  for(const l of k.links||[]){const A=byId.get(l.from),B=byId.get(l.to);if(A&&B)addLink(A,B,Math.min(3,l.count||1));}}catch(err){console.warn('her knowledge web could not be loaded',err);}}
function touchAll(e){const refs=references(e);const made=[];for(const r of refs){const w=r.with?addItem(r.with.region,r.with.label):null;if(w&&r.with.region==='hearing')iact[w.idx]=Math.min(1.5,iact[w.idx]+0.4);const it=touch(r.region,r.label,w?[w]:[],r.amp??1);if(it)made.push(it);}
  for(let i=1;i<made.length;i++)addLink(made[0],made[i],0.5);return made;}
// the knowledge layer: points and links drawn with the same shaders as the brain itself
group.add(new THREE.Points(igeo,mat));
// knowledge links rest almost invisible (hundreds converge on one person); they appear when they carry a signal
const ilmat=lmat.clone();ilmat.fragmentShader=`varying float vA;varying vec3 vC;void main(){if(vA<0.01)discard;float a=vA*0.5;gl_FragColor=vec4(vC*(0.6+vA*1.2),a);}`;ilmat.needsUpdate=true;
group.add(new THREE.LineSegments(ilgeo,ilmat));

// ---------- firing: a wave through a region's dendrites, then signals down its axons ----------
const waves=[]; // {front:Set, seen:Set, amp, color}
const regionGlow={};for(const k of KEYS)regionGlow[k]=0;
function fireRegion(k,amp=1,from=null){const h=hub[k];if(h==null)return;regionGlow[k]=Math.min(1.5,regionGlow[k]+amp);waves.push({front:[h],seen:new Set([h]),amp,region:k,left:amp>0.6?7:4});
  if(from===null)for(const ax of axonSegs){if(ax.a===k||ax.b===k){const to=ax.a===k?ax.b:ax.a;if(to===from)continue;sparks.push({i:ax.a===k?ax.i:ax.j,j:ax.a===k?ax.j:ax.i,t:0,to,amp,c:colorOf[k]});}}
  onRegion?.(k,amp);}
function stepWaves(){for(let w=waves.length-1;w>=0;w--){const wv=waves[w];const next=[];for(const i of wv.front){act[i]=Math.min(1.6,act[i]+wv.amp);for(const j of adj[i])if(owner[j]===owner[i]&&!wv.seen.has(j)){wv.seen.add(j);next.push(j);}}
  wv.front=next;wv.amp*=0.82;if(--wv.left<=0||!next.length||wv.amp<0.08)waves.splice(w,1);}}
// each bucket owns a slice of the pressure region's neurons; its value is their resting glow
let snapshot=null;
function assignBase(region,keys,values){const ids=byRegion[region];if(!keys.length)return;const per=Math.floor(ids.length/keys.length)||1;keys.forEach((k,ki)=>{const v=Math.max(0,Math.min(1,+values[k]||0));for(let n=ki*per;n<Math.min(ids.length,(ki+1)*per);n++)base[ids[n]]=0.04+v*0.3;});}
let waveClock=0;
function update(dt){waveClock+=dt;if(waveClock>0.045){waveClock=0;stepWaves();}
  for(let i=0;i<N;i++){if(act[i]>0)act[i]=Math.max(0,act[i]-dt*1.1);}
  for(const k of KEYS)regionGlow[k]=Math.max(0,regionGlow[k]-dt*0.8);
  // baseline: pressure neurons glow with the buckets, feelings neurons with the feelings
  if(snapshot){const b=snapshot.buckets||{},feel=new Set(snapshot.feelings||[]);const want=Object.keys(b).filter((x)=>!feel.has(x)),fl=Object.keys(b).filter((x)=>feel.has(x));
    assignBase('pressure',want,b);assignBase('feelings',fl,b);}
  // lines light with their endpoints
  for(let l=0;l<linkStart.length;l++){const a=segs[l*2],b=segs[l*2+1];const v=Math.max(act[a],act[b])*(segOf[l]?1.0:0.7);const s0=linkStart[l],c=linkCount[l];for(let k=0;k<c;k++)lact[s0+k]=v;}
  // knowledge neurons decay; their links light with their endpoints and with how often they've fired together
  for(let i=0;i<itemList.length;i++)if(iact[i]>0)iact[i]=Math.max(0,iact[i]-dt*0.9);
  for(let l=0;l<ilinks.length;l++){const L=ilinks[l];const v=Math.max(iact[L.a.idx],iact[L.b.idx])*0.9;for(let k=0;k<KV;k++)lact2[l*KV+k]=v;}
  // sparks travel: along axons (region to region) or along knowledge links (thing to thing)
  let n=0,bn=0;const flick=performance.now();
  for(let s=sparks.length-1;s>=0;s--){const sp=sparks[s];sp.t+=dt*1.25;if(sp.t>=1){sparks.splice(s,1);if(sp.to)fireRegion(sp.to,sp.amp*0.45,sp.to);if(sp.item)iact[sp.item.idx]=Math.min(1.5,iact[sp.item.idx]+sp.amp);continue;}
    const A=sp.fromP??[pos[sp.i*3],pos[sp.i*3+1],pos[sp.i*3+2]],B=sp.toP??[pos[sp.j*3],pos[sp.j*3+1],pos[sp.j*3+2]];
    // the bolt finds its own way: a fresh jagged path every ~90 ms, so it flickers as it travels
    if(!sp.path||flick-(sp.jit??0)>90){sp.seed=(sp.seed??(flick*7919)|0)+1;sp.path=boltPath(A,B,sp.seed);sp.jit=flick;}
    const head=alongPath(sp.path,sp.t);
    // the head and a fading trail behind it
    for(let k=0;k<5&&n<MAXS;k++){const u=Math.max(0,sp.t-k*0.035);const p=alongPath(sp.path,u);const f=1-k*0.18;spos[n*3]=p[0];spos[n*3+1]=p[1];spos[n*3+2]=p[2];scol[n*3]=sp.c.r*f;scol[n*3+1]=sp.c.g*f;scol[n*3+2]=sp.c.b*f;n++;}
    // the bolt itself, from the source to the head, brightest near the head and fading toward the source
    const segs2=sp.path.length-1,upto=sp.t*segs2;for(let k=0;k<segs2&&bn<BOLTCAP;k++){if(k>upto)break;const a=sp.path[k],b=k+1>upto?head:sp.path[k+1];const fade=(0.25+0.75*(k/segs2))*(1-sp.t*0.4)*sp.amp*(0.7+0.3*Math.sin(flick/23+k));const o=bn*2;bpos[o*3]=a[0];bpos[o*3+1]=a[1];bpos[o*3+2]=a[2];bpos[o*3+3]=b[0];bpos[o*3+4]=b[1];bpos[o*3+5]=b[2];for(const q of [o,o+1]){bcol[q*3]=sp.c.r;bcol[q*3+1]=sp.c.g;bcol[q*3+2]=sp.c.b;bact[q]=Math.max(0,Math.min(1,fade));}bn++;}}
  sgeo.setDrawRange(0,n);sgeo.attributes.position.needsUpdate=true;sgeo.attributes.color.needsUpdate=true;
  bgeo.setDrawRange(0,bn*2);bgeo.attributes.position.needsUpdate=true;bgeo.attributes.color.needsUpdate=true;bgeo.attributes.aAct.needsUpdate=true;
  geo.attributes.aAct.needsUpdate=true;geo.attributes.aBase.needsUpdate=true;lgeo.attributes.aAct.needsUpdate=true;
  igeo.attributes.aAct.needsUpdate=true;igeo.attributes.aBase.needsUpdate=true;igeo.attributes.aSize.needsUpdate=true;igeo.attributes.position.needsUpdate=true;igeo.attributes.color.needsUpdate=true;
  ilgeo.attributes.aAct.needsUpdate=true;ilgeo.attributes.position.needsUpdate=true;ilgeo.attributes.color.needsUpdate=true;}

// one of her events, live: the region it lands in fires, what it references lights up. Returns what fired.
function fire(e){const r=route(e);if(!r)return null;fireRegion(r.at,r.amp);if(r.also)setTimeout(()=>fireRegion(r.also,0.9),350);let made=[];const sparkAt=sparks.length;try{made=touchAll(e)||[];}catch(err){console.warn('knowledge touch',err);}
  return{r,made,newSparks:sparks.slice(sparkAt)};}
// one of her events from the replayed history: seeds her knowledge web quietly (no sparks)
function seed(e){const r=route(e);if(!r)return null;try{for(const ref of references(e)){const w=ref.with?addItem(ref.with.region,ref.with.label):null;const it=addItem(ref.region,String(ref.label??'').trim().slice(0,60));if(it&&w)addLink(it,w,0.5);}}catch{}return r;}

// ---------- her body, live: the Studio stream (/api/avatar/live) carries her speech envelope (mouth, 40 ms frames) and her expressions ----------
// Her mouth moving is motion; each frame of it beats the body cluster in step with the sound. Expressions
// light the feelings she showed and the body with them. primed: false while the stream replays its opening state
// (that seeds, it doesn't fire).
let mouthTimers=[];let blinkCount=0;
function bodyBeat(open,i){const ids=byRegion.body;if(!ids.length)return;const steps=4+Math.floor(open*10);for(let k=0;k<steps;k++){const j=ids[(i*7+k*13)%ids.length];act[j]=Math.min(1.4,act[j]+open*0.9);}regionGlow.body=Math.min(1.2,regionGlow.body+open*0.3);}
function body(e,primed=true){
  if(!primed){if(e.type==='view'&&e.view)addItem('body',`view ${e.view.frame}`);if(e.type==='appearance'&&e.appearance)addItem('body',`look ${e.appearance.character??'main'}`);return;}
  if(e.type==='discord-speech'&&e.speech){const p=e.speech;if(p.type==='start'&&Array.isArray(p.frames)){for(const t of mouthTimers)clearTimeout(t);mouthTimers=[];const who=p.character&&p.character!=='main'?p.character:'her';touch('body',`${who==='her'?'mouth':who+' speaks'}`,[],0.8);touch('voice',`speaking ${new Date().toLocaleTimeString([],{hour12:false})}`,[],0.6);
      p.frames.forEach((f,i)=>{const open=Math.max(0,Math.min(1,+f.open||0));if(open<0.12)return;mouthTimers.push(setTimeout(()=>bodyBeat(open,i),i*(p.frameMs||40)));});}
    if(p.type==='stop'){for(const t of mouthTimers)clearTimeout(t);mouthTimers=[];}}
  if(e.type==='expression'&&e.expression){const f=e.expression.feelings??e.expression;if(f&&typeof f==='object'){const hot=Object.entries(f).filter(([,v])=>+v>=0.3).sort((a,b)=>b[1]-a[1]).slice(0,3);if(hot.length){fireRegion('body',0.5);for(const [k,v] of hot)touch('feelings',k,[],+v);}}}
  // her blinks and glances, reported by the Studio page: each one beats the body cluster (no label spam; every 12th blink leaves a mark)
  if(e.type==='beat'&&Array.isArray(e.beats)){for(const b of e.beats){for(let k=0;k<b.n;k++){bodyBeat(b.kind==='blink'?0.45:0.3,(blinkCount++)+k*3);}if(b.kind==='blink'&&blinkCount%12===0)touch('body',`blink${b.character!=='main'?' ('+b.character+')':''}`,[],0.4);if(b.kind==='glance')touch('body','glance',[],0.25);}}
  if(e.type==='view'&&e.view)touch('body',`view ${e.view.frame}`,[],0.5);
  if(e.type==='appearance'&&e.appearance)touch('body',`look ${e.appearance.character??'main'}`,[],0.4);}

// What her whole mind is lit with right now: every region's glow, mixed in its own colour. This is what the
// Mind page shows as regions flash, so anything tinted by it flashes at the same moments in the same colours.
const _glow=new THREE.Color();
function glow(){_glow.setRGB(0,0,0);let k=0;for(const r of KEYS){const g=regionGlow[r];if(g<=0)continue;_glow.r+=colorOf[r].r*g;_glow.g+=colorOf[r].g*g;_glow.b+=colorOf[r].b*g;k+=g;}
  if(k>0)_glow.multiplyScalar(1/k);return{color:_glow,strength:Math.min(1.5,k)};}

loadItems();
return{group,colorOf,regionGlow,sparks,items,itemList,ipos,iact,pos,hub,
  fireRegion,touch,addItem,addLink,fire,seed,body,update,glow,
  setSnapshot:(s)=>{snapshot=s;},
  setScale:(k)=>{mat.uniforms.uScale.value=k;smat.uniforms.uScale.value=k;},
  P:(it)=>[ipos[it.idx*3],ipos[it.idx*3+1],ipos[it.idx*3+2]],H:(k)=>[pos[hub[k]*3],pos[hub[k]*3+1],pos[hub[k]*3+2]]};}

// Her event feed (/api/events): the opening replay of history seeds her knowledge web quietly, live events fire.
// onEvent(e, r, made, newSparks) for each live one that fired, onReplay(e, r) for each seeded one.
export function listenMind(mind,{onEvent,onReplay,onOpen,onError}={}){const es=new EventSource('/api/events');
  es.onopen=()=>onOpen?.();es.onerror=()=>onError?.();
  let primed=false;setTimeout(()=>primed=true,800);
  es.onmessage=(m)=>{let e;try{e=JSON.parse(m.data);}catch{return;}if(!e.type||e.type==='context')return;
    if(!primed){const r=mind.seed(e);if(r)onReplay?.(e,r);return;}
    const f=mind.fire(e);if(f)onEvent?.(e,f.r,f.made,f.newSparks);};
  return es;}
