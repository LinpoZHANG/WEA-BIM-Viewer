#!/usr/bin/env python3
"""WEA local server, using only the Python standard library.
Run: python3 server.py   then open http://127.0.0.1:4277
Uploads are processed on localhost and never sent to a cloud service.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json, os, re, sys, traceback, threading, uuid, time
from urllib.parse import urlparse, unquote, parse_qs

ROOT = Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'tools'))
try:
    from ifc_convert_ios import convert  # IfcOpenShell geometry kernel (see requirements.txt)
    KERNEL='IfcOpenShell'
except ImportError as exc:
    # Lightweight stdlib tessellator: no booleans/swept solids, may z-fight. Fallback only.
    from ifc_convert import convert
    KERNEL=f'stdlib fallback - IfcOpenShell unavailable ({exc}); run setup: see README'
IMPORT_LOCK=threading.Lock()
DESIGNS=ROOT/'designs'   # lighting designs: separate files, never written into IFC / assets

SIM_JOBS={};SIM_LOCK=threading.Lock()   # Radiance simulation jobs (one at a time, results kept in memory)

def run_simulation(job,req):
    def progress(phase,frac):job.update(phase=phase,progress=round(float(frac),3))
    try:
        import radiance_sim
        job['result']=radiance_sim.simulate(req,ROOT/'assets',progress);job['status']='done'
    except Exception as exc:
        traceback.print_exc();job.update(status='error',error=str(exc)[:500])
    finally:
        job['finished']=time.time();SIM_LOCK.release()

def design_file(query):
    name=(parse_qs(query).get('model') or [''])[0]
    safe=re.sub(r'[^\w\-. ]+','_',name).strip(' .')[:120]
    return DESIGNS/(safe+'.lighting.json') if safe else None
PORT=int(os.environ.get('WEA_PORT','4277'))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**k):super().__init__(*a,directory=str(ROOT/'web'),**k)
    def log_message(self,fmt,*args):print('[WEA]',fmt%args)
    def end_headers(self):
        # web/ files change while developing: always revalidate, so index.html and its JS modules never mix versions
        if b'\r\ncache-control:' not in b''.join(getattr(self,'_headers_buffer',[])).lower():
            self.send_header('Cache-Control','no-cache')
        super().end_headers()
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/api/lighting/simulate':
            job=SIM_JOBS.get((parse_qs(urlparse(self.path).query).get('job') or [''])[0])
            if not job:self.json(404,{'error':'unknown simulation job'});return
            self.json(200,{k:v for k,v in job.items() if k!='thread'});return
        if path=='/api/lighting/find':                  # designs of the same IFC project saved under another model name
            guid=(parse_qs(urlparse(self.path).query).get('project') or [''])[0];found=[]
            for f in sorted(DESIGNS.glob('*.lighting.json')):
                try:d=json.loads(f.read_text('utf-8'))
                except (ValueError,OSError):continue
                sm=d.get('sourceModel') or {}
                if guid and sm.get('projectGuid')==guid:found.append({'model':sm.get('name') or f.name[:-len('.lighting.json')],'file':f.name,'updatedAt':d.get('updatedAt'),
                    'fixtures':sum(len(s.get('fixtures',[])) for s in (d.get('schemes') or {}).values())})
            found.sort(key=lambda x:x.get('updatedAt') or '',reverse=True);self.json(200,{'designs':found});return
        if path=='/api/lighting':
            file=design_file(urlparse(self.path).query)
            if not file:self.json(400,{'error':'model parameter required'});return
            if not file.is_file():self.json(404,{'error':'no saved lighting design'});return
            body=file.read_bytes()
            self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
            return
        if path=='/api/ai/status':
            import ai_proxy;self.json(200,ai_proxy.status());return
        if path=='/api/spatial':
            file=ROOT/'assets'/'model.json'
            if not file.exists():self.send_error(404);return
            body=file.read_bytes()
            self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.send_header('Access-Control-Allow-Origin','http://127.0.0.1:'+str(PORT));self.end_headers();self.wfile.write(body)
            return
        if path.startswith('/assets/'):
            name=path[len('/assets/'):]
            if name not in ('model.bin','model.json','rooms.json','surfaces.json') and not re.fullmatch(r'textures/[0-9a-f]{12}\.jpg',name):
                self.send_error(404);return
            file=(ROOT/'assets'/name)
            if not file.is_file():self.send_error(404);return
            self.send_response(200)
            self.send_header('Content-Type','application/json; charset=utf-8' if name.endswith('.json') else 'image/jpeg' if name.endswith('.jpg') else 'application/octet-stream')
            self.send_header('Content-Length',str(file.stat().st_size));self.send_header('Cache-Control','no-store')
            self.end_headers()
            with file.open('rb') as f:
                while True:
                    chunk=f.read(512*1024)
                    if not chunk:break
                    try:self.wfile.write(chunk)
                    except (BrokenPipeError,ConnectionResetError):break
            return
        return super().do_GET()
    def json(self,code,obj):
        body=json.dumps(obj,ensure_ascii=False).encode('utf-8')
        self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    def do_POST(self):
        if urlparse(self.path).path=='/api/lighting/elv':
            size=int(self.headers.get('Content-Length','0'))
            if not (0<size<=20*1024*1024):self.json(413,{'error':'request too large'});return
            try:req=json.loads(self.rfile.read(size).decode('utf-8'))
            except ValueError:self.json(400,{'error':'invalid JSON'});return
            try:
                import elv_drawings,io,zipfile,base64,datetime
                blobs,summary,svgs=elv_drawings.generate(req['design'],ROOT/'assets',req.get('settings'),preview=True)
                stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
                folder=DESIGNS/'exports'/(re.sub(r'[^\w\-. ]+','_',req['design'].get('sourceModel',{}).get('name','model'))[:80]+'_ELV_'+stamp)
                folder.mkdir(parents=True,exist_ok=True)
                buf=io.BytesIO()
                with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
                    for fn,b in blobs.items():(folder/fn).write_bytes(b);z.writestr(fn,b)
                self.json(200,{'summary':summary,'folder':str(folder.relative_to(ROOT)),'zip':base64.b64encode(buf.getvalue()).decode(),'svgs':svgs})
            except Exception as exc:
                traceback.print_exc();self.json(422,{'error':str(exc)[:400]})
            return
        if urlparse(self.path).path=='/api/ai/chat':          # designer agent -> LLM provider (key stays on the server)
            size=int(self.headers.get('Content-Length','0'))
            if size<=0 or size>8*1024*1024:self.json(400,{'error':'invalid request size'});return
            try:payload=json.loads(self.rfile.read(size))
            except ValueError:self.json(400,{'error':'invalid JSON'});return
            import ai_proxy;code,body=ai_proxy.chat(payload);self.json(code,body);return
        if urlparse(self.path).path=='/api/lighting/simulate':
            size=int(self.headers.get('Content-Length','0'))
            if not (0<size<=20*1024*1024):self.json(413,{'error':'request too large'});return
            try:req=json.loads(self.rfile.read(size).decode('utf-8'))
            except ValueError:self.json(400,{'error':'invalid JSON'});return
            try:import radiance_sim  # noqa: F401
            except ImportError as exc:self.json(501,{'error':f'Radiance 未安装（pyradiance）：{exc}'});return
            if not SIM_LOCK.acquire(blocking=False):self.json(409,{'error':'已有仿真在运行，请稍候'});return
            jid=uuid.uuid4().hex[:12];job={'id':jid,'status':'running','phase':'queued','progress':0,'started':time.time()}
            SIM_JOBS[jid]=job
            for k in [k for k,j in SIM_JOBS.items() if j.get('finished',time.time())<time.time()-3600]:SIM_JOBS.pop(k,None)
            threading.Thread(target=run_simulation,args=(job,req),daemon=True).start()
            self.json(202,{'job':jid});return
        if urlparse(self.path).path=='/api/lighting':
            file=design_file(urlparse(self.path).query);size=int(self.headers.get('Content-Length','0'))
            if not file:self.json(400,{'error':'model parameter required'});return
            if not (0<size<=20*1024*1024):self.json(413,{'error':'design must be 1 byte - 20 MB'});return
            try:design=json.loads(self.rfile.read(size).decode('utf-8'))
            except ValueError:self.json(400,{'error':'invalid JSON'});return
            if not isinstance(design,dict) or design.get('schemaVersion')!=1 or 'schemes' not in design:self.json(422,{'error':'not a WEA lighting design (schemaVersion 1)'});return
            DESIGNS.mkdir(exist_ok=True);tmp=file.with_suffix('.tmp')
            tmp.write_text(json.dumps(design,ensure_ascii=False,indent=1),encoding='utf-8');os.replace(tmp,file)
            self.json(200,{'ok':True,'file':str(file.relative_to(ROOT))});return
        if urlparse(self.path).path=='/api/textures/upload':   # Archicad OBJ export: .obj + .mtl + texture folder, one file per request
            q=parse_qs(urlparse(self.path).query);session=re.sub(r'[^0-9a-z]','',(q.get('session') or [''])[0])[:24]
            rel=(q.get('path') or [''])[0].replace('\\','/');parts=[x for x in rel.split('/') if x not in ('','.')]
            size=int(self.headers.get('Content-Length','0'))
            if not session or not parts or '..' in parts or not re.search(r'\.(obj|mtl|jpe?g|png|tiff?|bmp|gif)$',parts[-1],re.I):self.json(400,{'error':'unsupported file '+rel});return
            if not (0<size<=1024*1024*1024):self.json(413,{'error':'file must be ≤ 1 GB'});return
            dest=ROOT/'source'/'uploads'/('obj_'+session)/Path(*parts);dest.parent.mkdir(parents=True,exist_ok=True)
            with dest.open('wb') as f:
                remaining=size
                while remaining:
                    block=self.rfile.read(min(1024*1024,remaining))
                    if not block:self.json(400,{'error':'incomplete upload'});return
                    f.write(block);remaining-=len(block)
            self.json(200,{'ok':True});return
        if urlparse(self.path).path=='/api/textures/build':    # derive textures + repeat sizes -> assets/surfaces.json, assets/textures/
            session=re.sub(r'[^0-9a-z]','',(parse_qs(urlparse(self.path).query).get('session') or [''])[0])[:24]
            folder=ROOT/'source'/'uploads'/('obj_'+session)
            objs=sorted(folder.rglob('*.obj'),key=lambda f:-f.stat().st_size) if session and folder.is_dir() else []
            if not objs:self.json(400,{'error':'上传的文件夹里没有 .obj 文件'});return
            if not IMPORT_LOCK.acquire(blocking=False):self.json(409,{'error':'另一个导入正在进行'});return
            try:
                import obj_textures
                ac=ROOT/'source'/'archicad'/'ac_surfaces.json'
                doc=obj_textures.build(objs[0],ROOT/'assets',ac if ac.exists() else None)
                tex=[k for k,v in doc['materials'].items() if v.get('texture')]
                self.json(200,{'ok':True,'obj':objs[0].name,'materials':len(doc['materials']),'textured':len(tex),'files':doc['textureFiles']})
            except Exception as exc:
                traceback.print_exc();self.json(422,{'error':str(exc)[:400]})
            finally:IMPORT_LOCK.release()
            return
        if urlparse(self.path).path!='/api/import':self.json(404,{'error':'Not found'});return
        size=int(self.headers.get('Content-Length','0'))
        if not (100<size<=250*1024*1024):self.json(413,{'error':'IFC size must be between 100 bytes and 250 MB'});return
        filename=unquote(self.headers.get('X-Filename','model.ifc'))
        if not filename.lower().endswith('.ifc'):self.json(415,{'error':'Expected .ifc file'});return
        if not IMPORT_LOCK.acquire(blocking=False):self.json(409,{'error':'An IFC import is already in progress'});return
        try:
            upload=ROOT/'source'/'imported.ifc';upload.parent.mkdir(exist_ok=True)
            with upload.open('wb') as f:
                remaining=size
                while remaining:
                    block=self.rfile.read(min(1024*1024,remaining))
                    if not block:raise IOError('Incomplete upload')
                    f.write(block);remaining-=len(block)
            with upload.open('rb') as f:
                if not f.read(15).startswith(b'ISO-10303-21'):
                    self.json(400,{'error':'Not a STEP IFC file (ISO-10303-21)'});return
            # Build new geometry in a staging dir before replacing the active assets.
            stage=ROOT/'source'/'staging';stage.mkdir(exist_ok=True)
            stats=convert(upload,stage)
            manifest=json.loads((stage/'model.json').read_text('utf-8'))
            manifest['name']=filename[:-4]
            (stage/'model.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
            os.replace(stage/'model.bin',ROOT/'assets'/'model.bin');os.replace(stage/'model.json',ROOT/'assets'/'model.json')
            if (stage/'rooms.json').exists():os.replace(stage/'rooms.json',ROOT/'assets'/'rooms.json')
            self.json(200,{'ok':True,'stats':stats})
        except Exception as exc:
            traceback.print_exc();self.json(422,{'error':str(exc)[:400]})
        finally:IMPORT_LOCK.release()

def _diagnostics():
    """Start-up report (console + logs/wea.log) so a failed install can be diagnosed remotely."""
    import platform, importlib.util
    mods={m:bool(importlib.util.find_spec(m)) for m in ('ifcopenshell','numpy','shapely','pyradiance','ezdxf','PIL')}
    return {'python':sys.version.split()[0],'platform':platform.platform(),'root':str(ROOT),'kernel':KERNEL,'modules':mods,
            'model':(ROOT/'assets'/'model.json').exists()}


if __name__=='__main__':
    import socket, webbrowser, datetime
    (ROOT/'logs').mkdir(exist_ok=True)
    diag=_diagnostics();url=f'http://127.0.0.1:{PORT}/'
    with open(ROOT/'logs'/'wea.log','a',encoding='utf-8') as log:log.write(f'\n[{datetime.datetime.now().isoformat(timespec="seconds")}] start {json.dumps(diag,ensure_ascii=False)}\n')
    missing=[m for m,ok in diag['modules'].items() if not ok]
    try:server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    except OSError as exc:
        # most often WEA is already running in another window: just show it
        print(f'\n端口 {PORT} 已被占用（{exc}）。如果 WEA 已在另一个窗口运行，浏览器会直接打开它；否则请关闭占用该端口的程序后重试。')
        try:
            socket.create_connection(('127.0.0.1',PORT),timeout=1).close()
            if os.environ.get('WEA_OPEN','1')=='1':webbrowser.open(url)
        except OSError:pass
        sys.exit(1)
    print(f'\nWEA 0.3 — IFC Spatial Explorer\nPython {diag["python"]} · 几何内核: {KERNEL}')
    if missing:print('缺少组件: '+', '.join(missing)+'（查看模型不受影响；仿真/出图等功能需要它们，重新运行启动脚本会继续安装）')
    if not diag['model']:print('提示: 尚未有模型，请在页面右上角「导入 IFC」')
    print(f'打开: {url}\n关闭此窗口即可退出 WEA。\n')
    if os.environ.get('WEA_OPEN','1')=='1':threading.Timer(.8,lambda:webbrowser.open(url)).start()   # the socket is bound already: no race
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
