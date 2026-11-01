/* WEA 0.4 — three.js BIM viewer for the IfcOpenShell WEA_WEBGL_V2 payload.
 * Rendering: three.js (MIT, web/vendor/three) MeshStandardMaterial + RoomEnvironment
 * IBL + GTAO. Per-element state (visible / selected / category) lives in one data
 * texture read by the vertex shader, so storey x category layers, per-object
 * hide / isolate, coplanar-duplicate covers, GPU picking and AO all share it —
 * the visibility model used by That Open's Hider/Classifier and xeokit, on one draw call.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $=sel=>document.querySelector(sel);
const canvas=$('#scene');
const categoryNames=['未分类代理','墙体','楼板 / 屋面','梁 / 柱','风管','水管','桥架','IfcSpace'];
const categoryColors=['#abb1ae','#a5aeb0','#8a938d','#c5b796','#8eafd0','#83bdb8','#bf9cc2','#d7f16b'];
const MODES={material:0,category:1,clay:2,xray:3};
const MODE_NAMES={material:'材质',category:'分类',clay:'白模',xray:'X 光'};
const fmt=(v,n=2)=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:n});
const safe=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
let toastTimeout=null;
function toast(msg){$('#toast').textContent=msg;$('#toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('#toast').classList.remove('visible'),3600)}
function setStatus(msg){$('#footerStatus').textContent=msg}
function loading(title,detail=''){$('#loadTitle').textContent=title;$('#loadDetail').textContent=detail;$('#loading').hidden=false;$('#loadProgress').style.width='23%'}
function loadProgress(v,text){$('#loadProgress').style.width=`${v}%`;if(text)$('#loadDetail').textContent=text}

let model=null,elements=[],materialByName=new Map();
const state={floorOn:[],catOn:categoryNames.map((_,i)=>i!==7),cellOff:new Set(),expanded:new Set(),
  hidden:new Set(),isolated:null,selection:new Set(),primary:-1,mode:'material',ao:true,bbox:true,
  section:{on:false,top:0,bottom:0},discOn:{ARCH:true,MEP:true},nav:'orbit',person:null,focal:24,eyeHeight:1.6};
const DISC_NAMES={ARCH:'建筑',MEP:'机电'};
let discOverrides={};  // GlobalId -> 'ARCH'|'MEP', manual corrections saved per model in localStorage
const discOf=i=>discOverrides[elements[i].guid]||elements[i].discipline||'ARCH';
// Height section (two horizontal clipping planes, three.js material clipping): keeps bottom <= y <= top
const clipTop=new THREE.Plane(new THREE.Vector3(0,-1,0),0),clipBottom=new THREE.Plane(new THREE.Vector3(0,1,0),0);
let filteredSearch='';

/* ---------- renderer ---------- */
let renderer,scene,camera,controls,composer,gtaoPass,grid,bboxHelper,sun,hemi;
let meshes=[],stateTex=null,paletteTex=null,pickTarget,pickMaterial,needsRender=false;
// material textures (assets/surfaces.json from tools/obj_textures.py): one 2D-array texture, triplanar projection
const dummyTex=new THREE.DataArrayTexture(new Uint8Array(4),1,1,1);dummyTex.needsUpdate=true;
const shared={uState:{value:null},uPalette:{value:null},uMode:{value:0},uTex:{value:dummyTex},uTexOn:{value:0},
  uCat:{value:categoryColors.map(c=>new THREE.Color(c))}};
const VIS_GLSL=`
attribute uint aElem;   // Uint32 attributes are bound as integers by three.js
attribute uint aCover;
uniform highp sampler2D uState;
vec4 weaState(uint k){uint w=uint(textureSize(uState,0).x);return texelFetch(uState,ivec2(int(k%w),int(k/w)),0);}
// hidden element, or a coplanar-duplicate piece whose covering element is visible
bool weaHidden(){if(weaState(aElem).r<.5)return true;return aCover>0u&&weaState(aCover-1u).r>.5;}
`;
// Spot lights use the same luminous intensity distribution as the illuminance calculation
// (lighting/photometry.js): I(θ) = I0·cos^m θ. lighting/preview.js encodes m in penumbraCos:
// t = (penumbraCos − coneCos)/(1 − coneCos), m = 1 + 199 t; coneCos is the visual cut-off (I < 0.5 % I0).
const LIGHTS_PARS_COSM=THREE.ShaderChunk.lights_pars_begin.replace(
  'return smoothstep( coneCosine, penumbraCosine, angleCosine );',
  'if(angleCosine<=coneCosine)return 0.;float t=clamp((penumbraCosine-coneCosine)/max(1.-coneCosine,1e-6),0.,1.);return pow(angleCosine,1.+199.*t);');
const HIDE_GLSL='#include <project_vertex>\nif(weaHidden())gl_Position=vec4(2.,2.,2.,1.);';
function injectVisibility(material,opaqueOnly=false){
  material.onBeforeCompile=shader=>{shader.uniforms.uState=shared.uState;shader.uniforms.uPalette=shared.uPalette;
    shader.vertexShader=VIS_GLSL+'attribute float aMat;uniform highp sampler2D uPalette;\n'+shader.vertexShader.replace('#include <project_vertex>',
      opaqueOnly?'#include <project_vertex>\nif(weaHidden()||texelFetch(uPalette,ivec2(int(aMat+.5),0),0).a<.999)gl_Position=vec4(2.,2.,2.,1.);':HIDE_GLSL)};
  material.customProgramCacheKey=()=>opaqueOnly?'wea-vis-opaque':'wea-vis';
}
// uPass (per material): 0 = everything, 1 = MEP only, 2 = everything except MEP (x-ray ghost pass), 3 = glass (transmission)
function injectAppearance(material,pass=0){
  const passUniform={value:pass};material.userData.pass=passUniform;
  material.onBeforeCompile=shader=>{Object.assign(shader.uniforms,shared,{uPass:passUniform});
    shader.vertexShader=VIS_GLSL+`attribute float aMat;uniform highp sampler2D uPalette;uniform vec3 uCat[8];uniform int uMode;uniform int uPass;
varying vec4 vWea;varying vec2 vWeaRM;varying float vWeaTr;varying vec3 vWeaP;varying vec3 vWeaN;flat varying vec4 vWeaT1;flat varying vec4 vWeaT2;
`+shader.vertexShader.replace('#include <color_vertex>',`#include <color_vertex>
bool weaPassHide=false;
{vec4 st=weaState(aElem);int m=int(aMat+.5);vec4 pal=texelFetch(uPalette,ivec2(m,0),0);vec4 rm=texelFetch(uPalette,ivec2(m,1),0);
 int cat=int(st.b*255.+.5);bool mep=st.a>.5;weaPassHide=(uPass==1&&!mep)||(uPass==2&&mep);
 vec3 c=uMode==1?uCat[cat]:(uMode==2?vec3(.78):(uMode==3&&!mep?vec3(.42,.47,.5):pal.rgb));
 float a=uMode==3?(mep?1.:.06):pal.a;vWeaRM=uMode==0||uMode==3&&mep?rm.rg:vec2(.85,0.);
 if(st.g>.5){c=mix(c,vec3(.68,.88,.15),.62);a=max(a,.9);}
 vWeaT1=st.g>.5?vec4(-1.):texelFetch(uPalette,ivec2(m,2),0);vWeaT2=texelFetch(uPalette,ivec2(m,3),0);   // texture: layer, sizes, angle
 // Glass (transmission pass), from IFC transparency T = 1 - opacity. Clear glass has ~no diffuse scatter, so
 // T >= 0.6 transmits fully (IFC colour only tints); lower T (frosted) keeps a milky diffuse share and gets blurrier.
 vWeaTr=clamp((1.-pal.a)/.6,0.,1.);if(uPass==3){a=1.;vWeaRM=vec2(clamp(pal.a-.25,.03,.6),0.);c=mix(vec3(1.),c,.25);}
 weaPassHide=weaPassHide||pal.a<.02;   // fully transparent (e.g. IFC air volumes): never drawn
 vWea=vec4(c,a);}`).replace('#include <project_vertex>','#include <project_vertex>\nvWeaP=(modelMatrix*vec4(transformed,1.)).xyz;vWeaN=normalize(mat3(modelMatrix)*objectNormal);\nif(weaHidden()||weaPassHide)gl_Position=vec4(2.,2.,2.,1.);');
    shader.fragmentShader='varying vec4 vWea;varying vec2 vWeaRM;varying float vWeaTr;varying vec3 vWeaP;varying vec3 vWeaN;flat varying vec4 vWeaT1;flat varying vec4 vWeaT2;\nuniform highp sampler2DArray uTex;uniform int uTexOn;uniform int uMode;uniform int uPass;\n'+shader.fragmentShader
      .replace('#include <lights_pars_begin>',LIGHTS_PARS_COSM)
      .replace('#include <transmission_fragment>',THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;','material.transmission = transmission*vWeaTr;'))
      .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor*=vWea;\n'+TEX_GLSL)
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=vWeaRM.x;')
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=vWeaRM.y;')};
  material.customProgramCacheKey=()=>'wea-appearance';
}
/* Triplanar texture in IFC local axes (x, y, z-up = view x, -z, y): floors / ceilings use the plan angle and
   repeat size measured in Archicad's OBJ texture coordinates, walls run u horizontally (or vertically if rotated). */
const TEX_GLSL=`if(uTexOn==1&&uMode==0&&uPass!=3&&vWeaT1.x>=0.){
 vec3 P=vec3(vWeaP.x,-vWeaP.z,vWeaP.y),N=normalize(vec3(vWeaN.x,-vWeaN.z,vWeaN.y));vec3 w=pow(abs(N),vec3(6.));w/=max(w.x+w.y+w.z,1e-5);
 float ca=cos(vWeaT1.w),sa=sin(vWeaT1.w);vec2 uvH=vec2(ca*P.x+sa*P.y,-sa*P.x+ca*P.y)/vWeaT1.yz;
 vec2 uvX=vec2(P.y,P.z),uvY=vec2(P.x,P.z);if(vWeaT2.z>.5){uvX=uvX.yx;uvY=uvY.yx;}uvX/=vWeaT2.xy;uvY/=vWeaT2.xy;
 vec3 t=w.z*texture(uTex,vec3(uvH,vWeaT1.x)).rgb+w.x*texture(uTex,vec3(uvX,vWeaT1.x)).rgb+w.y*texture(uTex,vec3(uvY,vWeaT1.x)).rgb;
 diffuseColor.rgb=mix(t*0.0773993808,pow(t*0.9478672986+0.0521327014,vec3(2.4)),step(vec3(0.04045),t));}`;   // sRGB -> linear
const opaqueMaterial=new THREE.MeshStandardMaterial({side:THREE.DoubleSide});
// shadow-map depth for lighting fixtures: hidden / fully transparent / glass surfaces cast no shadow
const shadowDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});
injectVisibility(shadowDepthMaterial,true);
// Glass: physically based transmission (three.js MeshPhysicalMaterial), thin-walled (thickness 0, no refraction).
// Transmission samples the opaque scene once, so thick double-sided panes no longer stack into milky layers.
const glassMaterial=new THREE.MeshPhysicalMaterial({side:THREE.DoubleSide,transmission:1,ior:1.5,thickness:0,metalness:0,specularIntensity:1});
const ghostMaterial=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,transparent:true,depthWrite:false});
injectAppearance(opaqueMaterial);injectAppearance(glassMaterial,3);injectAppearance(ghostMaterial,2);
let ghostMesh=null;

function initRenderer(){
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'})}catch(e){$('#noWebGL').hidden=false;throw e}
  renderer.setPixelRatio(Math.min(2,devicePixelRatio||1));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.shadowMap.autoUpdate=false;
  renderer.localClippingEnabled=true;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  scene=new THREE.Scene();scene.background=new THREE.Color('#17191c');
  const pmrem=new THREE.PMREMGenerator(renderer);
  scene.environment=pmrem.fromScene(new RoomEnvironment(),.04).texture;scene.environmentIntensity=.75;
  hemi=new THREE.HemisphereLight(0xf2f4ff,0x40403a,.55);scene.add(hemi);
  sun=new THREE.DirectionalLight(0xfff6e8,1.6);scene.add(sun,sun.target);
  camera=new THREE.PerspectiveCamera(50,1,.05,1000);
  controls=new OrbitControls(camera,canvas);
  controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};
  controls.zoomToCursor=true;controls.screenSpacePanning=true;
  controls.addEventListener('change',()=>{requestRender();updateCoords()});
  composer=new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene,camera));
  gtaoPass=new GTAOPass(scene,camera,2,2);
  gtaoPass.updateGtaoMaterial({radius:.6,distanceExponent:1.5,thickness:1,scale:1.2,samples:16});
  injectVisibility(gtaoPass.normalMaterial,true);
  // override-material passes (AO normals, picking) only understand BIM geometry: skip tool/lighting objects
  const gtaoOverride=gtaoPass._renderOverride.bind(gtaoPass);
  gtaoPass._renderOverride=(...a)=>{const hide=pickHidden.map(o=>[o,o.visible]);hide.forEach(([o])=>o.visible=false);gtaoOverride(...a);hide.forEach(([o,v])=>o.visible=v)};
  composer.addPass(gtaoPass);composer.addPass(new OutputPass());
  pickTarget=new THREE.WebGLRenderTarget(1,1);
  // fully transparent surfaces (e.g. IFC "air" volumes, opacity 0) are invisible, so they must not be pickable either
  // clipping:true -> ShaderMaterials honour the height section (otherwise clipped-away elements stay pickable)
  pickMaterial=new THREE.ShaderMaterial({uniforms:{uState:shared.uState,uPalette:shared.uPalette},side:THREE.DoubleSide,clipping:true,
    vertexShader:VIS_GLSL+'attribute float aMat;uniform highp sampler2D uPalette;flat varying uint vId;\n#include <clipping_planes_pars_vertex>\nvoid main(){vId=aElem+1u;vec4 mvPosition=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mvPosition;\n#include <clipping_planes_vertex>\nif(weaHidden()||texelFetch(uPalette,ivec2(int(aMat+.5),0),0).a<.02)gl_Position=vec4(2.,2.,2.,1.);}',
    fragmentShader:'flat varying uint vId;\n#include <clipping_planes_pars_fragment>\nvoid main(){\n#include <clipping_planes_fragment>\nuint id=vId;gl_FragColor=vec4(float(id&255u)/255.,float((id>>8)&255u)/255.,float((id>>16)&255u)/255.,1.);}'});
  bboxHelper=new THREE.Box3Helper(new THREE.Box3(),new THREE.Color('#d7f16b'));bboxHelper.visible=false;scene.add(bboxHelper);
  new ResizeObserver(resize).observe(canvas);resize();
}
function resize(){const r=canvas.getBoundingClientRect();const w=Math.max(2,r.width|0),h=Math.max(2,r.height|0);
  renderer.setSize(w,h,false);composer.setSize(w,h);camera.aspect=w/h;camera.setFocalLength(state.focal);requestRender()}
// Focal length in 35 mm-equivalent millimetres (three.js PerspectiveCamera.setFocalLength, filmGauge 35)
function setFocal(mm){state.focal=Math.min(135,Math.max(12,+mm));camera.setFocalLength(state.focal);$('#focalRange').value=state.focal;$('#focalVal').textContent=state.focal+' mm';
  document.querySelectorAll('#focalPresets button').forEach(b=>b.classList.toggle('active',+b.dataset.focal===state.focal));requestRender()}
// Depth precision is dominated by the near plane: fit near/far to the model bounds.
function updateClipPlanes(){const b=model?.bounds;if(!b)return;const e=camera.position;let inside=0,far=0;
  for(let i=0;i<3;i++){const lo=b[i]-e.getComponent(i),hi=e.getComponent(i)-b[i+3];inside+=Math.max(0,lo,hi)**2;far+=Math.max(Math.abs(lo),Math.abs(hi))**2}
  const dist=e.distanceTo(controls.target);camera.near=state.nav==='person'?.08:Math.max(.02,Math.sqrt(inside)*.9,Math.min(dist*.02,1));camera.far=Math.sqrt(far)*1.05+1;camera.updateProjectionMatrix()}
function applySection(){const sec=state.section,planes=sec.on?[clipTop,clipBottom]:[];clipTop.constant=sec.top+5e-4;clipBottom.constant=-(sec.bottom-5e-4);  // 0.5 mm: a face exactly at the cut height is kept whole, not cut pixel-randomly
  for(const m of [opaqueMaterial,glassMaterial,ghostMaterial,pickMaterial,gtaoPass.normalMaterial]){if(m.clippingPlanes?.length!==planes.length)m.needsUpdate=true;m.clippingPlanes=planes}
  $('#sectionButton').classList.toggle('active',sec.on);$('#sectionPanel').hidden=!sec.on;
  $('#secTopVal').textContent=fmt(sec.top,2)+' m';$('#secBottomVal').textContent=fmt(sec.bottom,2)+' m';updateViewportLabel();requestRender()}
function initSection(){const b=model.bounds,lo=Math.floor(b[1]*10)/10-.1,hi=Math.ceil(b[4]*10)/10+.1;
  Object.assign(state.section,{on:false,top:hi,bottom:lo});
  for(const [id,v] of [['#secTop',hi],['#secBottom',lo]]){const r=$(id);r.min=lo;r.max=hi;r.step=.01;r.value=v}
  const lv=model.levels;$('#secFloors').innerHTML=lv.map((l,i)=>`<button data-band="${i}" title="${safe(l.name)} 层高范围">${safe(l.name)}</button>`).join('');
  $('#secFloors').querySelectorAll('[data-band]').forEach(btn=>btn.onclick=()=>{const i=+btn.dataset.band;
    setSection(lv[i].elevation-.6,i+1<lv.length?lv[i+1].elevation:hi)})}
function setSection(bottom,top){const sec=state.section;sec.on=true;sec.bottom=Math.min(bottom,top-.05);sec.top=Math.max(top,bottom+.05);
  $('#secTop').value=sec.top;$('#secBottom').value=sec.bottom;applySection()}
function render(){needsRender=false;if(!renderer)return;updateClipPlanes();
  // Physical lighting design renders straight to the screen: tone mapping is then applied per material,
  // so unlit overlays (lux heat map, fixtures, toneMapped:false) keep exact colours, and no AO darkening
  // is mixed into the lighting preview. The BIM explorer keeps the GTAO post-processing chain.
  if(displayLighting.direct){renderer.render(scene,camera);return}
  gtaoPass.enabled=state.ao&&state.mode!=='xray';composer.render()}
function requestRender(){if(needsRender)return;needsRender=true;requestAnimationFrame(render)}

/* ---------- GPU picking (one pixel, same visibility texture) ---------- */
function pick(x,y){if(!meshes.length)return -1;const r=canvas.getBoundingClientRect();
  camera.setViewOffset(r.width,r.height,x-r.left,y-r.top,1,1);updateClipPlanes();
  const helpers=[grid,bboxHelper].map(o=>[o,o?.visible]);helpers.forEach(([o])=>o&&(o.visible=false));
  const bg=scene.background,cc=renderer.getClearColor(new THREE.Color()),ca=renderer.getClearAlpha();scene.background=null;scene.overrideMaterial=pickMaterial;
  const extra=pickHidden.map(o=>[o,o.visible]);extra.forEach(([o])=>o.visible=false);
  renderer.setRenderTarget(pickTarget);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,camera);
  const px=new Uint8Array(4);renderer.readRenderTargetPixels(pickTarget,0,0,1,1,px);
  renderer.setRenderTarget(null);renderer.setClearColor(cc,ca);scene.overrideMaterial=null;scene.background=bg;helpers.forEach(([o,v])=>o&&(o.visible=v));extra.forEach(([o,v])=>o.visible=v);
  camera.clearViewOffset();return px[0]+(px[1]<<8)+(px[2]<<16)-1}
/* Surface pick for tools (lighting fixture placement): world position + face normal (view coords,
   oriented towards the camera) of the visible, opaque surface under the cursor; null if none.
   Same visibility / section / transparency rules as element picking. */
let surfacePickTarget=null,surfacePosMaterial=null,surfaceNrmMaterial=null;
const pickHidden=[];   // objects excluded from all GPU picks (e.g. lighting gizmos, heat map)
function pickSurface(x,y){if(!meshes.length)return null;
  if(!surfacePickTarget){surfacePickTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType});
    const vs=VIS_GLSL+'attribute float aMat;uniform highp sampler2D uPalette;varying vec3 vPos;flat varying uint vId;\n#include <clipping_planes_pars_vertex>\nvoid main(){vId=aElem+1u;vPos=(modelMatrix*vec4(position,1.)).xyz;vec4 mvPosition=viewMatrix*vec4(vPos,1.);gl_Position=projectionMatrix*mvPosition;\n#include <clipping_planes_vertex>\nif(weaHidden()||texelFetch(uPalette,ivec2(int(aMat+.5),0),0).a<.999)gl_Position=vec4(2.,2.,2.,1.);}';
    const mk=fs=>new THREE.ShaderMaterial({uniforms:{uState:shared.uState,uPalette:shared.uPalette},side:THREE.DoubleSide,clipping:true,vertexShader:vs,fragmentShader:fs});
    const clipF='#include <clipping_planes_pars_fragment>\n',clipM='\n#include <clipping_planes_fragment>\n';
    surfacePosMaterial=mk('varying vec3 vPos;flat varying uint vId;\n'+clipF+'void main(){'+clipM+'gl_FragColor=vec4(vPos,float(vId));}');
    surfaceNrmMaterial=mk('varying vec3 vPos;flat varying uint vId;\n'+clipF+'void main(){'+clipM+'vec3 n=normalize(cross(dFdx(vPos),dFdy(vPos)));if(dot(n,cameraPosition-vPos)<0.)n=-n;gl_FragColor=vec4(n,1.);}')}
  for(const m of [surfacePosMaterial,surfaceNrmMaterial]){if(m.clippingPlanes?.length!==opaqueMaterial.clippingPlanes?.length)m.needsUpdate=true;m.clippingPlanes=opaqueMaterial.clippingPlanes}
  const r=canvas.getBoundingClientRect();camera.setViewOffset(r.width,r.height,x-r.left,y-r.top,1,1);updateClipPlanes();
  const hide=[grid,bboxHelper,...pickHidden].filter(Boolean).map(o=>[o,o.visible]);hide.forEach(([o])=>o.visible=false);
  const bg=scene.background,cc=renderer.getClearColor(new THREE.Color()),ca=renderer.getClearAlpha();scene.background=null;
  const out=[];renderer.setRenderTarget(surfacePickTarget);renderer.setClearColor(0,0);
  for(const m of [surfacePosMaterial,surfaceNrmMaterial]){scene.overrideMaterial=m;renderer.clear();renderer.render(scene,camera);const px=new Float32Array(4);renderer.readRenderTargetPixels(surfacePickTarget,0,0,1,1,px);out.push(px)}
  renderer.setRenderTarget(null);renderer.setClearColor(cc,ca);scene.overrideMaterial=null;scene.background=bg;hide.forEach(([o,v])=>o.visible=v);camera.clearViewOffset();
  const id=Math.round(out[0][3])-1;if(id<0)return null;
  return {index:id,element:elements[id],point:new THREE.Vector3(out[0][0],out[0][1],out[0][2]),normal:new THREE.Vector3(out[1][0],out[1][1],out[1][2]).normalize()}}

/* Visibility sampling (lighting "interior envelope"): element ids seen from given points (view coords),
   rendered as 6 × 90° cube faces with the same id shader as picking — current visibility filters apply,
   the height section does not. opaqueOnly skips every non-opaque surface (looks through glass). Async:
   yields to the browser between views and reports progress(0..1). Returns a Set of element indices. */
async function visibleFrom(points,{size=160,opaqueOnly=false,progress=null}={}){
  if(!meshes.length)return new Set();
  const mat=new THREE.ShaderMaterial({uniforms:{uState:shared.uState,uPalette:shared.uPalette},side:THREE.DoubleSide,
    vertexShader:pickMaterial.vertexShader.replace('.a<.02)','.a<'+(opaqueOnly?'.999':'.02')+')'),fragmentShader:pickMaterial.fragmentShader.replace(/#include <clipping_planes_[a-z_]+>/g,'')});
  const rt=new THREE.WebGLRenderTarget(size,size),cam=new THREE.PerspectiveCamera(90,1,.02,400),buf=new Uint8Array(size*size*4),ids=new Set();
  const dirs=[[1,0,0,0,-1,0],[-1,0,0,0,-1,0],[0,1,0,0,0,1],[0,-1,0,0,0,-1],[0,0,1,0,-1,0],[0,0,-1,0,-1,0]];
  let hide=[];                                     // re-read per point: tools may add overlays (e.g. a heat map) meanwhile
  const bg=scene.background,cc=renderer.getClearColor(new THREE.Color()),ca=renderer.getClearAlpha();
  const total=points.length*6;let done=0;const shadows=renderer.shadowMap.enabled;renderer.shadowMap.enabled=false;   // id renders need no shadow pass
  try{
    for(const p of points){
      hide=[grid,bboxHelper,...pickHidden].filter(Boolean).map(o=>[o,o.visible]);hide.forEach(([o])=>o.visible=false);scene.background=null;scene.overrideMaterial=mat;renderer.setRenderTarget(rt);renderer.setClearColor(0,0);
      for(const d of dirs){
        cam.position.set(p[0],p[1],p[2]);cam.up.set(d[3],d[4],d[5]);cam.lookAt(p[0]+d[0],p[1]+d[1],p[2]+d[2]);cam.updateMatrixWorld();
        renderer.clear();renderer.render(scene,cam);renderer.readRenderTargetPixels(rt,0,0,size,size,buf);
        for(let i=0;i<buf.length;i+=4){const id=buf[i]+(buf[i+1]<<8)+(buf[i+2]<<16)-1;if(id>=0)ids.add(id)}
        done++;
      }
      renderer.setRenderTarget(null);renderer.setClearColor(cc,ca);scene.overrideMaterial=null;scene.background=bg;hide.forEach(([o,v])=>o.visible=v);hide=[];
      progress?.(done/total);await new Promise(r=>requestAnimationFrame(r));
    }
  }finally{renderer.shadowMap.enabled=shadows;renderer.setRenderTarget(null);renderer.setClearColor(cc,ca);scene.overrideMaterial=null;scene.background=bg;hide.forEach(([o,v])=>o.visible=v);rt.dispose();mat.dispose();requestRender()}
  return ids}

/* Material textures: assets/surfaces.json maps surface (= IFC style) names to a texture and its real-world
   repeat size / orientation; images are packed into one 512 px 2D-array texture (mipmapped, repeat wrap). */
async function loadTextures(){
  const S=model?.surfaces?.materials;if(!S||!paletteTex)return;
  {const p=paletteTex.image.data,M=model.materials.length;for(let i=0;i<M;i++){p.set([-1,1,1,0],(2*M+i)*4);p.set([1,1,0,0],(3*M+i)*4)}paletteTex.needsUpdate=true;shared.uTexOn.value=0;model.textured=0}
  const base=n=>(n||'').replace(/\s*#[0-9A-Fa-f]{6}$/,'').trim(),mats=model.materials,layers=new Map(),use=[];
  mats.forEach((m,i)=>{const s=S[m.name]||S[base(m.name)];if(!s?.texture||!(s.horizontal||s.vertical))return;
    if(!layers.has(s.texture.file))layers.set(s.texture.file,layers.size);use.push([i,s,layers.get(s.texture.file)])});
  if(!layers.size)return;
  const N=512,data=new Uint8Array(N*N*4*layers.size),cv=document.createElement('canvas');cv.width=cv.height=N;const g2=cv.getContext('2d',{willReadFrequently:true});
  await Promise.all([...layers].map(([file,k])=>new Promise(res=>{const im=new Image();im.onload=()=>{g2.drawImage(im,0,0,N,N);data.set(g2.getImageData(0,0,N,N).data,k*N*N*4);res()};im.onerror=()=>{console.warn('texture',file);res()};im.src='/assets/'+file})));
  const tex=new THREE.DataArrayTexture(data,N,N,layers.size);tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.minFilter=THREE.LinearMipmapLinearFilter;tex.magFilter=THREE.LinearFilter;
  tex.generateMipmaps=true;tex.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());tex.needsUpdate=true;
  const pal=paletteTex.image.data,M=mats.length,D=Math.PI/180;
  for(const [i,s,k] of use){const h=s.horizontal||s.vertical,v=s.vertical||s.horizontal;
    pal.set([k,h.sizeU,h.sizeV,(h.angle||0)*D],(2*M+i)*4);pal.set([v.sizeU,v.sizeV,(v.rotation||0)>45?1:0,0],(3*M+i)*4)}
  paletteTex.needsUpdate=true;shared.uTex.value=tex;shared.uTexOn.value=1;model.textured=use.length;requestRender();
  viewerEvents.dispatchEvent(new CustomEvent('textures',{detail:{materials:use.length,images:layers.size}}))}

/* ---------- visibility system ---------- */
const layerKey=(level,cat)=>level+':'+cat;
function layerVisible(e){return !!e.bbox&&state.floorOn[e.level]!==false&&state.catOn[e.category]&&!state.cellOff.has(layerKey(e.level,e.category))}
function elementVisible(i){const e=elements[i];return !!e&&layerVisible(e)&&state.discOn[discOf(i)]&&!state.hidden.has(i)&&(!state.isolated||state.isolated.has(i))&&(!extraFilter||extraFilter(i,e))}
let extraFilter=null;   // optional (index, element) => bool set by other workspaces
function refreshVisibility(){if(!stateTex)return;const d=stateTex.image.data;
  for(let i=0;i<elements.length;i++){d[i*4]=elementVisible(i)?255:0;d[i*4+1]=state.selection.has(i)?255:0;d[i*4+2]=elements[i].category;d[i*4+3]=discOf(i)==='MEP'?255:0}
  stateTex.needsUpdate=true;renderer.shadowMap.needsUpdate=true;viewerEvents.dispatchEvent(new Event('visibility'));updateBBoxHelper();renderDisciplines();renderLayers();renderCategories();renderHidden();renderRooms();updateViewportLabel();requestRender()}
function hideSelection(){if(!state.selection.size){toast('请先选择构件（Shift/⌘ 可多选）');return}
  for(const i of state.selection){state.hidden.add(i);state.isolated?.delete(i)}
  toast(`已隐藏 ${state.selection.size} 个构件`);clearSelection()}
function isolateSelection(){if(state.isolated){state.isolated=null;toast('已退出隔离')}
  else{if(!state.selection.size){toast('请先选择构件（Shift/⌘ 可多选）');return}state.isolated=new Set(state.selection);toast(`隔离 ${state.selection.size} 个构件`)}
  $('#isolateTool').classList.toggle('active',!!state.isolated);$('#isolateSelected').textContent=state.isolated?'◉ 退出隔离':'◉ 隔离';refreshVisibility()}
function showAll(){state.hidden.clear();state.isolated=null;$('#isolateTool').classList.remove('active');$('#isolateSelected').textContent='◉ 隔离';refreshVisibility()}

function renderDisciplines(){const cnt={ARCH:0,MEP:0};elements.forEach((e,i)=>{if(e.bbox&&e.category!==7)cnt[discOf(i)]++});
  const on=Object.keys(cnt).filter(k=>state.discOn[k]);
  $('#disciplineList').innerHTML=Object.keys(cnt).map(k=>`<div class="disc-row ${state.discOn[k]?'':'off'} ${on.length===1&&on[0]===k?'solo':''}"><button class="layer-btn eye ${state.discOn[k]?'on':''}" data-disc="${k}" title="显示/隐藏">${state.discOn[k]?'◉':'○'}</button><button class="floor-name" data-disc-solo="${k}" title="仅显示该专业（再次点击恢复）">${DISC_NAMES[k]}模型</button><span class="disc-tag">${k}</span><span class="floor-count">${cnt[k]}</span></div>`).join('');
  $('#disciplineList').querySelectorAll('[data-disc]').forEach(b=>b.onclick=()=>{state.discOn[b.dataset.disc]=!state.discOn[b.dataset.disc];refreshVisibility()});
  $('#disciplineList').querySelectorAll('[data-disc-solo]').forEach(b=>b.onclick=()=>{const k=b.dataset.discSolo,solo=b.parentElement.classList.contains('solo');for(const d in state.discOn)state.discOn[d]=solo||d===k;refreshVisibility()})}
function setDiscipline(disc){if(!state.selection.size)return;for(const i of state.selection){if(elements[i].discipline===disc)delete discOverrides[elements[i].guid];else discOverrides[elements[i].guid]=disc}
  localStorage.setItem('wea-disc:'+model.name,JSON.stringify(discOverrides));toast(`已将 ${state.selection.size} 个构件设为${DISC_NAMES[disc]}`);showInspector();refreshVisibility()}
function floorCounts(){const cnt={};for(const e of elements){if(!e.bbox)continue;(cnt[e.level]??=new Array(8).fill(0))[e.category]++}return cnt}
function renderLayers(){if(!model)return;const cnt=floorCounts();const levels=model.levels.map((l,i)=>({...l,key:i+1})).reverse();
  const onCount=levels.filter(l=>state.floorOn[l.key]!==false).length;
  let html=`<div class="layer-floor"><span class="layer-btn"></span><button class="layer-btn eye ${onCount?'on':''}" data-all="1" title="全部楼层显示/隐藏">${onCount?'◉':'○'}</button><button class="floor-name" data-all="1">全部楼层</button><span class="floor-count">${onCount}/${levels.length}</span></div>`;
  for(const l of levels){const on=state.floorOn[l.key]!==false,solo=on&&onCount===1&&levels.length>1,open=state.expanded.has(l.key),c=cnt[l.key]||[];
    html+=`<div class="layer-floor ${on?'':'off'} ${solo?'solo':''}"><button class="layer-btn" data-expand="${l.key}" title="展开分类">${open?'▾':'▸'}</button><button class="layer-btn eye ${on?'on':''}" data-floor="${l.key}" title="显示/隐藏该楼层">${on?'◉':'○'}</button><button class="floor-name" data-solo="${l.key}" title="仅显示该楼层（再次点击恢复全部）">${safe(l.name)}</button><span class="floor-count">${fmt(l.elevation)}m · ${c.reduce((a,b)=>a+b,0)}</span></div>`;
    if(open)html+='<div class="layer-cells">'+c.map((n,cat)=>n?`<button class="layer-cell ${state.cellOff.has(layerKey(l.key,cat))||!state.catOn[cat]?'off':''}" data-cell="${l.key}:${cat}" title="${state.catOn[cat]?'':'该分类已在全局关闭'}"><span class="cat-square" style="background:${categoryColors[cat]}"></span><span>${safe(categoryNames[cat])}</span><span class="cat-count">${n}</span><span>${state.cellOff.has(layerKey(l.key,cat))?'○':'◉'}</span></button>`:'').join('')+'</div>'}
  const box=$('#floorList');box.innerHTML=html;
  box.querySelectorAll('[data-expand]').forEach(b=>b.onclick=()=>{const k=+b.dataset.expand;state.expanded.has(k)?state.expanded.delete(k):state.expanded.add(k);renderLayers()});
  box.querySelectorAll('[data-floor]').forEach(b=>b.onclick=()=>{const k=+b.dataset.floor;state.floorOn[k]=state.floorOn[k]===false;refreshVisibility()});
  box.querySelectorAll('[data-solo]').forEach(b=>b.onclick=()=>{const k=+b.dataset.solo;const solo=b.parentElement.classList.contains('solo');model.levels.forEach((_,i)=>state.floorOn[i+1]=solo||i+1===k);refreshVisibility()});
  box.querySelectorAll('[data-all]').forEach(b=>b.onclick=()=>{const v=onCount===0;model.levels.forEach((_,i)=>state.floorOn[i+1]=v);refreshVisibility()});
  box.querySelectorAll('[data-cell]').forEach(b=>b.onclick=()=>{const k=b.dataset.cell;state.cellOff.has(k)?state.cellOff.delete(k):state.cellOff.add(k);refreshVisibility()})}
function renderCategories(){const cnt=new Array(8).fill(0);for(const e of elements)if(e.bbox&&state.floorOn[e.level]!==false)cnt[e.category]++;
  $('#categoryList').innerHTML=categoryNames.map((name,i)=>cnt[i]||i===7?`<button class="category-option ${state.catOn[i]?'':'off'}" data-category="${i}"><span class="cat-square" style="background:${categoryColors[i]}"></span><span>${safe(name)}</span><span class="cat-count">${cnt[i]}</span><span class="cat-eye">${state.catOn[i]?'◉':'○'}</span></button>`:'').join('');
  $('#categoryList').querySelectorAll('button').forEach(b=>b.onclick=()=>{const i=+b.dataset.category;state.catOn[i]=!state.catOn[i];refreshVisibility()})}
function renderHidden(){const ids=[...state.hidden];$('#hiddenBadge').textContent=ids.length+(state.isolated?` · 隔离 ${state.isolated.size}`:'');
  $('#hiddenList').innerHTML=(ids.length?`<div class="hidden-row"><span>${ids.length} 个构件已隐藏</span><button data-restore="all">全部恢复</button></div>`:'<div class="hidden-empty">无。选中构件后按 H 或点“隐藏”。</div>')+
    ids.slice(0,80).map(i=>`<div class="hidden-row"><span title="${safe(elements[i].name)}">${safe(elements[i].name)} <small>#${elements[i].id}</small></span><button data-restore="${i}">显示</button></div>`).join('');
  $('#hiddenList').querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{b.dataset.restore==='all'?state.hidden.clear():state.hidden.delete(+b.dataset.restore);refreshVisibility()})}
function updateViewportLabel(){if(!model)return;const on=model.levels.map((l,i)=>state.floorOn[i+1]!==false?l.name:null).filter(Boolean);
  const disc=Object.keys(state.discOn).filter(k=>state.discOn[k]);
  $('#viewportMode').textContent=`${state.nav==='person'?`人视 · ${state.person.name} · `:''}${on.length===model.levels.length?'全模型':on.length?on.join('+'):'无楼层'}${disc.length===1?' · 仅'+DISC_NAMES[disc[0]]:''}${state.isolated?' · 隔离':''}${state.section.on?` · 剖切 ${fmt(state.section.bottom,1)}~${fmt(state.section.top,1)}m`:''} · ${MODE_NAMES[state.mode]}`}

/* ---------- selection & inspector ---------- */
function clearSelection(){state.selection.clear();state.primary=-1;showInspector();refreshVisibility()}
function select(index,{additive=false,focus=false}={}){const valid=index>=0&&index<elements.length;
  if(additive&&valid){state.selection.has(index)?state.selection.delete(index):state.selection.add(index);state.primary=state.selection.has(index)?index:[...state.selection].pop()??-1}
  else{state.selection=new Set(valid?[index]:[]);state.primary=valid?index:-1}
  showInspector();if(focus&&valid&&elements[index].bbox)focusBBox(elements[index].bbox);refreshVisibility()}
function showInspector(){const i=state.primary;$('#inspector').hidden=i<0;$('#inspectorEmpty').hidden=i>=0;if(i<0)return;
  const e=elements[i],row=(a,b,raw=false)=>`<div class="data-row"><span>${safe(a)}</span><strong title="${raw?'':safe(b)}">${raw?b:safe(b)}</strong></div>`;
  $('#inspectorType').textContent=(state.selection.size>1?`已选 ${state.selection.size} 个 · `:'')+categoryNames[e.category].toUpperCase();
  $('#inspectorName').textContent=e.name;$('#inspectorId').textContent=`EXPRESS #${e.id}   ·   ${e.type}`;
  $('#identityRows').innerHTML=[['IFC Entity',e.type],['Express ID',`#${e.id}`],['GlobalId',e.guid],['Tag',e.tag||'—'],['分类',categoryNames[e.category]],['楼层',model.levels[e.level-1]?.name??'—'],['专业',`${DISC_NAMES[discOf(i)]}${discOverrides[e.guid]?'（手动）':'（'+(e.disciplineReason||'—')+'）'}`],['可见',elementVisible(i)?'是':state.hidden.has(i)?'已隐藏':'被图层/隔离过滤']].map(([k,v])=>row(k,v)).join('')+`<div class="data-row"><span>修正专业${state.selection.size>1?`（${state.selection.size} 个）`:''}</span><span class="disc-set">${['ARCH','MEP'].map(d=>`<button data-set-disc="${d}" class="${discOf(i)===d?'on':''}">设为${DISC_NAMES[d]}</button>`).join('')}</span></div>`;
  $('#identityRows').querySelectorAll('[data-set-disc]').forEach(b=>b.onclick=()=>setDiscipline(b.dataset.setDisc));
  const sw=n=>{const m=materialByName.get(n);return m?`<span class="swatch" style="background:rgb(${m.color.map(c=>Math.round(c*255)).join(',')});opacity:${Math.max(.35,m.opacity)}"></span>`:''};
  $('#materialRows').innerHTML=[...(e.materials?.length?[row('IFC 材料',e.materials.join(' / '))]:[]),...(e.styles||[]).map((n,k)=>row(k?'':'表面样式',sw(n)+safe(n)+(materialByName.get(n)?.opacity<1?` · 透明 ${fmt(1-materialByName.get(n).opacity,2)}`:''),true))].join('')||row('材质','IFC 未定义');
  const bb=e.bbox;$('#geometryRows').innerHTML=(bb?[['包围盒宽 X',fmt(bb[3]-bb[0],3)+' m'],['包围盒高 Y',fmt(bb[4]-bb[1],3)+' m'],['包围盒深 Z',fmt(bb[5]-bb[2],3)+' m'],['三角面数',fmt(e.triangles,0)],['最小 XYZ',bb.slice(0,3).map(x=>fmt(x,2)).join(' / ')],['最大 XYZ',bb.slice(3,6).map(x=>fmt(x,2)).join(' / ')]]:[['几何','无三维几何']]).map(([a,b])=>row(a,b)).join('');
  const props=Object.entries(e.properties||{}).slice(0,28);
  $('#propertyRows').innerHTML=props.length?props.map(([k,v])=>row(k,v)).join(''):row('Property sets',(e.psets||[]).join(', ')||'—')}
function updateBBoxHelper(){if(state.nav==='person'){bboxHelper.visible=false;return}const box=new THREE.Box3();for(const i of state.selection){const b=elements[i]?.bbox;if(b)box.union(new THREE.Box3(new THREE.Vector3(b[0],b[1],b[2]),new THREE.Vector3(b[3],b[4],b[5])))}
  bboxHelper.box.copy(box);bboxHelper.visible=state.bbox&&!box.isEmpty()}

/* ---------- camera ---------- */
function focusBBox(bb,top=false){if(!bb)return;exitPerson(false);const c=new THREE.Vector3((bb[0]+bb[3])/2,(bb[1]+bb[4])/2,(bb[2]+bb[5])/2);
  const halfFov=THREE.MathUtils.degToRad(Math.min(camera.fov,camera.getEffectiveFOV?.()??camera.fov))/2;
  const dist=Math.max(3,Math.hypot(bb[3]-bb[0],bb[4]-bb[1],bb[5]-bb[2])/2/Math.tan(halfFov)*1.05);const yaw=top?0:.68,pitch=top?1.5605:.77;
  controls.target.copy(c);camera.position.set(c.x+dist*Math.cos(pitch)*Math.sin(yaw),c.y+dist*Math.sin(pitch),c.z+dist*Math.cos(pitch)*Math.cos(yaw));controls.update();requestRender()}
function homeView(){const rooms=elements.filter(x=>x.type==='IFCSPACE'&&x.bbox);if(!rooms.length){focusBBox(model.bounds);return}
  const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];for(const e of rooms)for(let i=0;i<3;i++){b[i]=Math.min(b[i],e.bbox[i]);b[i+3]=Math.max(b[i+3],e.bbox[i+3])}focusBBox(b)}
/* Person (eye-level) view: OrbitControls pivoting about a point 1 cm ahead with inverted
   rotation = look-around; WASD / arrows walk horizontally, wheel moves forward/back. */
const walkKeys=new Set();let walkLast=0;
function enterPerson(vp,name){state.nav='person';state.person={name,floor:vp.eye[1]-1.6};
  const eye=new THREE.Vector3(vp.eye[0],state.person.floor+state.eyeHeight,vp.eye[2]);
  const dir=new THREE.Vector3(vp.look[0]-vp.eye[0],0,vp.look[2]-vp.eye[2]).normalize();
  camera.position.copy(eye);controls.target.copy(eye).addScaledVector(dir,.01);
  Object.assign(controls,{rotateSpeed:-.35,enableZoom:false,enablePan:false});controls.update();
  $('#viewHint').innerHTML='<span class="hint-icon">⌘</span> 人视：拖动环视 <i>·</i> WASD / 方向键 行走（Shift 加速）<i>·</i> 滚轮 前进后退 <i>·</i> Esc 退出';
  updateNavUI();updateBBoxHelper();requestRender()}
function exitPerson(keepView=true){if(state.nav!=='person')return;state.nav='orbit';state.person=null;
  Object.assign(controls,{rotateSpeed:1,enableZoom:true,enablePan:true});
  if(keepView){const dir=new THREE.Vector3().subVectors(controls.target,camera.position).normalize();controls.target.copy(camera.position).addScaledVector(dir,5)}
  controls.update();$('#viewHint').innerHTML=defaultHint;updateNavUI();updateBBoxHelper();requestRender()}
function updateNavUI(){const p=state.nav==='person';$('#navState').textContent=p?`人视 · ${state.person.name}`:'轨道模式';$('#exitPerson').disabled=!p;$('#eyeRange').disabled=!p;
  $('#eyeRange').value=state.eyeHeight;$('#eyeVal').textContent=fmt(state.eyeHeight,2)+' m';updateViewportLabel()}
function walk(dx,dz){const f=new THREE.Vector3().subVectors(controls.target,camera.position);f.y=0;if(f.lengthSq()<1e-12)return;f.normalize();
  const r=new THREE.Vector3().crossVectors(f,camera.up).normalize();const m=f.multiplyScalar(dz).addScaledVector(r,dx);
  camera.position.add(m);controls.target.add(m);controls.update();requestRender()}
function walkLoop(t){if(!walkKeys.size||state.nav!=='person'){walkLast=0;return}const dt=walkLast?Math.min(.05,(t-walkLast)/1000):0;walkLast=t;
  const v=(walkKeys.has('shift')?4:1.4)*dt,k=walkKeys;
  walk(((k.has('d')||k.has('arrowright'))-(k.has('a')||k.has('arrowleft')))*v,((k.has('w')||k.has('arrowup'))-(k.has('s')||k.has('arrowdown')))*v);requestAnimationFrame(walkLoop)}
function setEyeHeight(h){const dy=+h-state.eyeHeight;state.eyeHeight=+h;if(state.nav==='person'){camera.position.y+=dy;controls.target.y+=dy;controls.update();requestRender()}updateNavUI()}
function updateCoords(){const t=controls.target;$('#coordText').textContent=`X ${fmt(t.x,1)}m   /   Y ${fmt(t.y,1)}m   /   Z ${fmt(-t.z,1)}m`}
// X-ray: MEP drawn opaque with real materials (depth-correct), architecture as a second ghost pass
function setMode(mode){state.mode=mode;const xray=mode==='xray';opaqueMaterial.userData.pass.value=xray?1:0;if(ghostMesh)ghostMesh.visible=xray;for(const m of meshes)if(m.material===glassMaterial)m.visible=!xray;
  shared.uMode.value=MODES[mode];$('#aoButton').disabled=xray||displayLighting.direct;document.querySelectorAll('#renderModes button').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));updateViewportLabel();requestRender()}

/* ---------- loading ---------- */
function buildScene(ab){
  for(const m of meshes){scene.remove(m);m.geometry.dispose()}meshes=[];if(ghostMesh){scene.remove(ghostMesh);ghostMesh.geometry.dispose()}stateTex?.dispose();paletteTex?.dispose();if(grid){scene.remove(grid);grid.dispose()}
  const L=model.layout,N=L.vertices,view=(k,T)=>{const [off,,size]=L[k];return new T(ab,off,N*size)};
  const attrs={position:new THREE.BufferAttribute(view('position',Float32Array),3),
    normal:new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(view('normal',Int8Array),4),3,0,true),
    aElem:new THREE.BufferAttribute(view('element',Uint32Array),1),aCover:new THREE.BufferAttribute(view('cover',Uint32Array),1),
    aMat:new THREE.BufferAttribute(view('material',Uint16Array),1)};
  const b=model.bounds,sphere=new THREE.Sphere(new THREE.Vector3((b[0]+b[3])/2,(b[1]+b[4])/2,(b[2]+b[5])/2),Math.hypot(b[3]-b[0],b[4]-b[1],b[5]-b[2])/2);
  for(const [material,start,count,order] of [[opaqueMaterial,0,L.opaqueVertices,0],[glassMaterial,L.opaqueVertices,N-L.opaqueVertices,1]]){
    if(!count)continue;const g=new THREE.BufferGeometry();for(const [k,a] of Object.entries(attrs))g.setAttribute(k,a);
    g.setDrawRange(start,count);g.boundingSphere=sphere;const mesh=new THREE.Mesh(g,material);mesh.frustumCulled=false;mesh.renderOrder=order;
    mesh.receiveShadow=true;mesh.castShadow=material===opaqueMaterial;mesh.customDepthMaterial=shadowDepthMaterial;scene.add(mesh);meshes.push(mesh)}
  const ghostGeometry=new THREE.BufferGeometry();for(const [k,a] of Object.entries(attrs))ghostGeometry.setAttribute(k,a);ghostGeometry.boundingSphere=sphere;
  ghostMesh=new THREE.Mesh(ghostGeometry,ghostMaterial);ghostMesh.frustumCulled=false;ghostMesh.renderOrder=2;ghostMesh.visible=state.mode==='xray';scene.add(ghostMesh)
  const W=1024,H=Math.max(1,Math.ceil(elements.length/W));
  stateTex=new THREE.DataTexture(new Uint8Array(W*H*4),W,H,THREE.RGBAFormat,THREE.UnsignedByteType);shared.uState.value=stateTex;
  const mats=model.materials,pal=new Float32Array(mats.length*16),c=new THREE.Color();
  mats.forEach((m,i)=>{c.setRGB(...m.color,THREE.SRGBColorSpace);pal.set([c.r,c.g,c.b,m.opacity],i*4);pal.set([m.roughness??.8,m.metalness??0,0,0],(mats.length+i)*4);
    pal.set([-1,1,1,0],(2*mats.length+i)*4);pal.set([1,1,0,0],(3*mats.length+i)*4)});   // rows 2-3: texture (none until surfaces.json loads)
  paletteTex=new THREE.DataTexture(pal,mats.length,4,THREE.RGBAFormat,THREE.FloatType);paletteTex.needsUpdate=true;shared.uPalette.value=paletteTex;
  materialByName=new Map(mats.map(m=>[m.name,m]));
  const size=Math.max(b[3]-b[0],b[5]-b[2]);grid=new THREE.GridHelper(Math.ceil(size*1.6/2)*2,Math.ceil(size*1.6/2),0x3a403d,0x262a2c);
  grid.position.set(sphere.center.x,b[1]-.02,sphere.center.z);scene.add(grid);
  sun.position.set(sphere.center.x+sphere.radius,sphere.center.y+sphere.radius*2,sphere.center.z+sphere.radius*.6);sun.target.position.copy(sphere.center)}
function resetState(){state.discOn={ARCH:true,MEP:true};state.floorOn=[true,...model.levels.map(()=>true)];state.catOn=categoryNames.map((_,i)=>i!==7);state.cellOff.clear();state.expanded.clear();
  state.hidden.clear();state.isolated=null;state.selection.clear();state.primary=-1}
async function loadModel(){loading('正在准备 BIM 模型','正在加载 IFC 构件目录…');try{
  const r=await fetch('/assets/model.json?ts='+Date.now());if(!r.ok)throw Error('未找到模型 manifest（'+r.status+'）');model=await r.json();
  if(model.format!=='WEA_WEBGL_V2')throw Error('模型为旧格式（'+model.format+'），请重新导入 IFC 以使用 IfcOpenShell 转换');
  elements=model.elements;
  // lighting work areas (tools/room_context.py) live in a separate file next to the geometry cache
  try{const rr=await fetch('/assets/rooms.json?ts='+Date.now());if(rr.ok){const rooms=await rr.json();model.project=rooms.project;model.site=rooms.site;model.grids=rooms.grids||[];model.roomsSource=rooms.source;
    for(const e of elements){const r=rooms.rooms?.[e.guid];if(r)e.room=r}}}catch(err){console.warn('rooms.json',err)}
  model.surfaces=null;try{const sr=await fetch('/assets/surfaces.json?ts='+Date.now());if(sr.ok)model.surfaces=await sr.json()}catch(err){console.warn('surfaces.json',err)}
  loadProgress(40,'构件数据读取完成，正在传输三维几何…');
  const g=await fetch('/assets/'+model.binary+'?ts='+Date.now());if(!g.ok)throw Error('三维网格载入失败（'+g.status+'）');const ab=await g.arrayBuffer();
  loadProgress(76,`读取 ${fmt(ab.byteLength/1024/1024,1)} MB 三维数据…`);
  try{discOverrides=JSON.parse(localStorage.getItem('wea-disc:'+model.name)||'{}')}catch{discOverrides={}}
  resetState();buildScene(ab);setMode(state.mode);initSection();applySection();exitPerson(false);setFocal(state.focal);updateNavUI();loadTextures().catch(err=>console.warn("textures",err));
  $('#projectTitle').textContent=model.name;$('#sideProjectName').textContent=model.name;$('#headerTag').textContent=model.schema;
  $('#countObjects').textContent=fmt(model.stats.products,0);$('#countRooms').textContent=fmt(model.rooms.length,0);$('#countLevels').textContent=model.levels.length;
  $('#floorBadge').textContent=model.levels.length;$('#roomsBadge').textContent=model.rooms.length;
  $('#geometryBadge').textContent=`${fmt(model.stats.triangles,0)} TRIANGLES · ${model.materials.length} MATERIALS`;
  setStatus(`${fmt(model.stats.geometricProducts,0)} 个几何对象 · ${model.materials.length} 种材质 · ${model.schema} · ${model.stats.geometryKernel||''}`);
  showInspector();refreshVisibility();homeView();loadProgress(100,'加载完成');$('#loading').hidden=true;
  viewerEvents.dispatchEvent(new Event('modelloaded'))}
  catch(err){console.error(err);$('#loadTitle').textContent='模型加载失败';$('#loadDetail').textContent=err.message;$('#loadProgress').style.width='0';setStatus('模型加载失败');toast(err.message)}}

function renderRooms(){if(!model)return;const q=filteredSearch.trim().toLowerCase();
  const rooms=elements.map((x,i)=>({...x,index:i})).filter(e=>q?(e.name.toLowerCase().includes(q)||String(e.id).includes(q)):e.type==='IFCSPACE');const visible=rooms.slice(0,q?45:28);
  $('#roomList').innerHTML=visible.map(e=>`<button class="room-option ${state.selection.has(e.index)?'active':''}" data-id="${e.index}"><span class="room-ico">${e.type==='IFCSPACE'?'⌑':'◫'}</span><span>${safe(e.name)}</span><small>#${e.id}</small></button>`).join('')+(rooms.length>visible.length?`<div class="section-footnote">还有 ${rooms.length-visible.length} 个结果，请缩小搜索范围</div>`:'');
  $('#roomList').querySelectorAll('button').forEach(b=>b.onclick=ev=>{const i=+b.dataset.id,vp=elements[i].viewpoint;
    if(vp&&!ev.shiftKey&&!ev.metaKey&&!ev.ctrlKey){select(i);enterPerson(vp,elements[i].name)}else select(i,{additive:ev.shiftKey||ev.metaKey||ev.ctrlKey,focus:true})})}

/* ---------- UI wiring ---------- */
function download(data,filename,mime='application/json'){const url=URL.createObjectURL(new Blob([data],{type:mime}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1200)}
$('#exportButton').onclick=()=>{if(!model)return;const found=state.selection.size?[...state.selection].map(i=>elements[i]):elements.filter((e,i)=>elementVisible(i));
  download(JSON.stringify({source:model.name,unit:'metre',origin:model.origin,notes:'Proxy classification is heuristic; bbox is not quantity takeoff.',elements:found},null,2),'WEA-elements.json');toast(`已导出 ${fmt(found.length,0)} 个构件的 JSON 数据`)};
$('#focusSelected').onclick=()=>{const e=elements[state.primary];if(e?.bbox)focusBBox(e.bbox)};
$('#clearSelected').onclick=clearSelection;
$('#isolateSelected').onclick=isolateSelection;$('#isolateTool').onclick=isolateSelection;
$('#hideSelected').onclick=hideSelection;$('#hideSelectedInspector').onclick=hideSelection;$('#showAll').onclick=showAll;
$('#resetView').onclick=()=>homeView();
$('#topView').onclick=()=>{const e=elements[state.primary];focusBBox(e?.bbox||model.bounds,true)};
$('#wireButton').onclick=()=>{state.bbox=!state.bbox;$('#wireButton').classList.toggle('active',state.bbox);updateBBoxHelper();requestRender()};
$('#aoButton').onclick=()=>{state.ao=!state.ao;$('#aoButton').classList.toggle('active',state.ao);requestRender()};
document.querySelectorAll('#renderModes button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
const defaultHint=$('#viewHint').innerHTML;
$('#focalPresets').innerHTML=[16,20,24,35,50,85].map(f=>`<button data-focal="${f}">${f}mm</button>`).join('');
$('#focalPresets').querySelectorAll('button').forEach(b=>b.onclick=()=>setFocal(b.dataset.focal));
$('#focalRange').addEventListener('input',e=>setFocal(e.target.value));
$('#eyeRange').addEventListener('input',e=>setEyeHeight(e.target.value));
$('#exitPerson').onclick=()=>exitPerson();
$('#lensButton').onclick=()=>{const p=$('#lensPanel');p.hidden=!p.hidden;$('#lensButton').classList.toggle('active',!p.hidden)};
canvas.addEventListener('wheel',e=>{if(state.nav!=='person')return;e.preventDefault();walk(0,Math.max(-.8,Math.min(.8,-e.deltaY*.004)))},{passive:false});
window.addEventListener('keyup',e=>{walkKeys.delete(e.key.toLowerCase());if(e.key==='Shift')walkKeys.delete('shift')});
window.addEventListener('blur',()=>walkKeys.clear());
$('#sectionButton').onclick=()=>{state.section.on=!state.section.on;applySection()};
$('#secTop').addEventListener('input',e=>setSection(state.section.bottom,+e.target.value));
$('#secBottom').addEventListener('input',e=>setSection(+e.target.value,state.section.top));
$('#secReset').onclick=()=>{initSection();applySection()};
$('#roomSearch').addEventListener('input',e=>{filteredSearch=e.target.value;renderRooms()});
$('#routingButton').onclick=()=>toast('自动布线仍在后续开发范围；本版仅完成 IFC 几何与属性浏览。');
$('#uploadButton').onclick=()=>$('#fileInput').click();
/* Archicad OBJ export (folder: .obj + .mtl + texture images) -> textures and repeat sizes for the current model.
   Files are sent one by one to the local server only (127.0.0.1), then tools/obj_textures.py builds assets/surfaces.json. */
$('#objButton').onclick=()=>$('#objInput').click();
$('#objInput').onchange=async e=>{const all=[...e.target.files];e.target.value='';if(!all.length)return;
  const files=all.filter(f=>/\.(obj|mtl|jpe?g|png|tiff?|bmp|gif)$/i.test(f.name));
  if(!files.some(f=>/\.obj$/i.test(f.name))){toast('所选文件夹里没有 .obj 文件：请选择 Archicad「另存为 Wavefront」导出的整个文件夹');return}
  if(!files.some(f=>/\.mtl$/i.test(f.name))){toast('缺少 .mtl 材质文件：它与 .obj 同名，Archicad 导出时会一起生成');return}
  const session=Date.now().toString(36)+Math.random().toString(36).slice(2,6),total=files.reduce((a,f)=>a+f.size,0);let sent=0;
  loading('正在导入贴图','上传 OBJ 文件夹到本机服务…');
  try{for(const f of files){const rel=(f.webkitRelativePath||f.name).split('/').slice(1).join('/')||f.name;
      const r=await fetch(`/api/textures/upload?session=${session}&path=${encodeURIComponent(rel)}`,{method:'POST',body:f});if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||('上传失败 '+rel));
      sent+=f.size;loadProgress(5+80*sent/total,`已上传 ${fmt(sent/1048576,1)} / ${fmt(total/1048576,1)} MB`)}
    loadProgress(88,'正在从贴图坐标推算每个材质的铺贴尺寸与方向…');
    const b=await fetch(`/api/textures/build?session=${session}`,{method:'POST'});const res=await b.json();if(!b.ok)throw Error(res.error||'贴图处理失败');
    const sr=await fetch('/assets/surfaces.json?ts='+Date.now());model.surfaces=sr.ok?await sr.json():null;await loadTextures();
    $('#loading').hidden=true;
    toast(model.textured?`已导入 ${res.files} 张贴图，当前模型 ${model.textured} 个材质已铺贴`:`已导入 ${res.files} 张贴图，但当前模型没有同名材质：OBJ 需与当前 IFC 来自同一 Archicad 项目`)}
  catch(err){console.error(err);$('#loading').hidden=true;toast('贴图导入失败：'+err.message)}};
$('#fileInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(!/\.ifc$/i.test(file.name)){toast('请选择 .ifc 文件');return}if(file.size>250*1024*1024){toast('当前原型限制为 250 MB 以下 IFC 文件');return}
  loading('正在导入 IFC',`IfcOpenShell 正在解析 ${file.name}（${fmt(file.size/1024/1024,1)} MB），大模型可能需要一两分钟…`);loadProgress(28,'文件仅发送到本机 localhost 服务');setStatus('正在进行本地模型转换');
  try{const res=await fetch('/api/import',{method:'POST',headers:{'X-Filename':encodeURIComponent(file.name),'Content-Type':'application/octet-stream'},body:file});const data=await res.json();if(!res.ok)throw Error(data.error||'转换失败');
    loadProgress(70,`转换完成 ${fmt(data.stats.geometricProducts,0)} 个几何构件`);await loadModel();toast(`已导入 ${file.name}`)}
  catch(err){console.error(err);$('#loading').hidden=true;setStatus('导入失败');toast('IFC 导入失败：'+err.message)}finally{$('#fileInput').value=''}};
let down=null;
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,button:e.button}});
canvas.addEventListener('pointerup',e=>{if(down&&down.button===0&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<4){if(viewer.clickHandler?.(e)){down=null;return}const idx=pick(e.clientX,e.clientY);
  select(idx,{additive:e.shiftKey||e.metaKey||e.ctrlKey});requestRender()}down=null});
window.addEventListener('keydown',e=>{if(e.target.closest('input,textarea'))return;const k=e.key.toLowerCase();
  if(state.nav==='person'&&['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','shift'].includes(k)){e.preventDefault();const was=walkKeys.size;walkKeys.add(k);if(!was)requestAnimationFrame(walkLoop);return}
  if(k==='escape'&&state.nav==='person')exitPerson();else if(k==='escape')clearSelection();else if(k==='h'&&(e.shiftKey||e.altKey))showAll();else if(k==='h')hideSelection();
  else if(k==='i')isolateSelection();else if(k==='f'&&state.primary>=0)$('#focusSelected').click()});
/* ---------- adapter for other workspaces (lighting/) : read-mostly access to the shared scene ---------- */
const viewerEvents=new EventTarget();
const displayLighting={env:.75,hemi:true,sun:true,exposure:1.05,direct:false};
export const viewer={
  THREE,canvas,events:viewerEvents,clickHandler:null,pickHidden,
  get scene(){return scene},get clippingPlanes(){return opaqueMaterial.clippingPlanes||[]},   // current section cut
  get camera(){return camera},get controls(){return controls},get renderer(){return renderer},
  get model(){return model},get elements(){return elements},get state(){return state},
  get geometry(){const g=meshes[0]?.geometry;if(!g)return null;return {position:g.attributes.position.array,element:g.attributes.aElem.array,
    material:g.attributes.aMat.array,cover:g.attributes.aCover.array,vertices:model.layout.vertices,opaqueVertices:model.layout.opaqueVertices,materials:model.materials}},
  requestRender,pick,pickSurface,visibleFrom,elementVisible,refreshVisibility,toast,setStatus,fmt,safe,
  focusBBox,enterPerson,exitPerson,home:()=>{exitPerson(false);homeView()},setSection,clearSection:()=>{state.section.on=false;applySection()},
  setFocal,select,clearSelection,setMode,
  setExtraFilter(fn){extraFilter=fn;refreshVisibility()},
  /** Display-only lighting (environment, hemisphere, sun) used by the BIM explorer; off for lighting design. */
  setDisplayLighting(on,{environment=0,exposure}={}){scene.environmentIntensity=on?displayLighting.env:environment;hemi.visible=on;sun.visible=on;
    displayLighting.direct=!on;$('#aoButton').disabled=!on||state.mode==='xray';$('#aoButton').title=on?'环境光遮蔽 (GTAO)':'照明设计模式不使用 AO（避免虚构的明暗干扰照明判断）';
    renderer.toneMappingExposure=on?displayLighting.exposure:(exposure??renderer.toneMappingExposure);requestRender()},
  invalidateShadows(){renderer.shadowMap.needsUpdate=true;requestRender()},
};
window.WEA_VIEWER=viewer;   // debugging / automated browser tests
import('./lighting/workspace.js').then(m=>{viewer.lighting=new m.LightingWorkspace(viewer);return import('./routing/workspace.js')})
  .then(m=>{viewer.routing=new m.RoutingWorkspace(viewer)}).catch(err=>{console.error(err);toast('工作模块加载失败：'+err.message)});
async function boot(){try{initRenderer();await loadModel()}catch(err){console.error(err);$('#loading').hidden=true;toast(err.message)}}
boot();
