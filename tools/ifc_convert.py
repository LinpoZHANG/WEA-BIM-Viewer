#!/usr/bin/env python3
"""WEA IFC4 tessellated reference-view importer (stdlib only).
Converts supported IfcPolygonalFaceSet geometry to a compact browser WebGL payload.
Not a general-purpose replacement for IfcOpenShell. All distances are converted mm->m
based on IFC length-unit declarations; inputs unsupported by the parser are reported.
"""
import array, collections, json, math, os, re, struct, sys, time
from pathlib import Path

RE_LINE = re.compile(r'^#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\((.*)\)\s*;\s*$', re.S)
RE_REF = re.compile(r'#(\d+)')
RE_FLOAT = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?')


def args(s):
    vals=[]; st=0; level=0; quote=False; i=0
    while i<len(s):
        c=s[i]
        if c=="'":
            if quote and i+1<len(s) and s[i+1]=="'": i+=2;continue
            quote=not quote
        elif not quote:
            if c=='(':level+=1
            elif c==')':level-=1
            elif c==',' and level==0: vals.append(s[st:i].strip());st=i+1
        i+=1
    vals.append(s[st:].strip())
    return vals


def refs(s):return [int(v) for v in RE_REF.findall(s)]


def unquote(s):
    if not s or s=='$':return ''
    if s.startswith("'") and s.endswith("'"):s=s[1:-1].replace("''", "'")
    def sub(m):
        h=m.group(1)
        try:return bytes.fromhex(h).decode('utf-16-be')
        except:return ''
    s=re.sub(r'\\X2\\([0-9a-fA-F]+)\\X0\\', sub, s)
    s=re.sub(r'\\X4\\([0-9a-fA-F]+)\\X0\\',lambda m:bytes.fromhex(m.group(1)).decode('utf-32-be',errors='replace'),s)
    return s


def vec(s,default=(0,0,0)):
    n=[float(t) for t in RE_FLOAT.findall(s or '')]
    return (n[:3]+[0]*3)[:3] if n else list(default)

def norm(v):
    z=math.sqrt(sum(x*x for x in v));return [x/z for x in v] if z>1e-10 else [0,0,1]

def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]

def mul(a,b):
    # row-major 4x4 matrix
    return [sum(a[r*4+k]*b[k*4+c] for k in range(4)) for r in range(4) for c in range(4)]

IDENT=[1.,0,0,0, 0,1.,0,0, 0,0,1.,0, 0,0,0,1.]

def apply(m,p):return [m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3],m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7],m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11]]

def inverse_rigid(m):
    a=[m[0],m[4],m[8],0, m[1],m[5],m[9],0, m[2],m[6],m[10],0, 0,0,0,1]
    t=apply(a,[-m[3],-m[7],-m[11]])
    a[3],a[7],a[11]=t
    return a

class IFC:
    def __init__(self,path):
        self.path=path;self.ent={};self.types=collections.Counter();self.mat_cache={};self.geom_cache={};self.place_cache={};self.data_unit=0.001
        text=''
        with open(path,'r',encoding='utf-8',errors='replace') as f:
            reading=False
            for line in f:
                if not reading:
                    if line.startswith('DATA;'):reading=True
                    continue
                if line.startswith('ENDSEC;'):break
                text+=line.strip()
                if not text.endswith(';'):continue
                m=RE_LINE.match(text)
                if m:
                    eid=int(m[1]);self.ent[eid]=(m[2],m[3]);self.types[m[2]]+=1
                text=''
        for typ,s in self.ent.values():
            if typ=='IFCSIUNIT' and '.LENGTHUNIT.' in s:
                self.data_unit=0.001 if '.MILLI.' in s else (0.01 if '.CENTI.' in s else 1)
                break

    def get(self,eid):return self.ent.get(eid,('', ''))
    def a(self,eid):return args(self.get(eid)[1])
    def xyz(self,eid, default=(0,0,0)):
        if not eid:return list(default)
        return vec(self.get(eid)[1],default)
    def place_axis(self,eid):
        if not eid:return IDENT
        if eid in self.mat_cache:return self.mat_cache[eid]
        typ,s=self.get(eid)
        if typ not in ('IFCAXIS2PLACEMENT3D','IFCAXIS2PLACEMENT2D'):return IDENT
        a=args(s); loc=self.xyz(refs(a[0])[0] if refs(a[0]) else None)
        z=norm(self.xyz(refs(a[1])[0]) if len(a)>1 and refs(a[1]) else (0,0,1))
        x=norm(self.xyz(refs(a[2])[0]) if len(a)>2 and refs(a[2]) else (1,0,0))
        y=norm(cross(z,x));x=norm(cross(y,z))
        m=[x[0],y[0],z[0],loc[0], x[1],y[1],z[1],loc[1], x[2],y[2],z[2],loc[2], 0,0,0,1]
        self.mat_cache[eid]=m;return m
    def placement(self,eid):
        if not eid:return IDENT
        if eid in self.place_cache:return self.place_cache[eid]
        typ,s=self.get(eid)
        if typ!='IFCLOCALPLACEMENT':return IDENT
        a=args(s);p=refs(a[0]); q=refs(a[1]);
        m=mul(self.placement(p[0]) if p else IDENT,self.place_axis(q[0]) if q else IDENT)
        self.place_cache[eid]=m;return m
    def trans_operator(self,eid):
        typ,s=self.get(eid)
        if not typ.startswith('IFCCARTESIANTRANSFORMATIONOPERATOR'):return IDENT
        a=args(s)
        x=norm(self.xyz(refs(a[0])[0],(1,0,0))) if a[0]!='$' else [1,0,0]
        y=norm(self.xyz(refs(a[1])[0],(0,1,0))) if a[1]!='$' else [0,1,0]
        origin=self.xyz(refs(a[2])[0]) if refs(a[2]) else [0,0,0]
        scale=float(a[3]) if a[3]!='$' else 1.
        z=norm(self.xyz(refs(a[4])[0],(0,0,1))) if len(a)>4 and a[4]!='$' else norm(cross(x,y))
        return [x[0]*scale,y[0]*scale,z[0]*scale,origin[0], x[1]*scale,y[1]*scale,z[1]*scale,origin[1], x[2]*scale,y[2]*scale,z[2]*scale,origin[2], 0,0,0,1]
    def items_for(self,eid, base=None, depth=0):
        if depth>12:return
        base=base or IDENT
        typ,s=self.get(eid)
        if typ=='IFCPRODUCTDEFINITIONSHAPE' or typ=='IFCREPRESENTATIONMAP':
            a=args(s)
            if typ=='IFCREPRESENTATIONMAP':
                rep=refs(a[1]);
                if rep:yield from self.items_for(rep[0],base,depth+1)
            else:
                for x in refs(a[-1]):yield from self.items_for(x,base,depth+1)
        elif typ=='IFCSHAPEREPRESENTATION':
            a=args(s)
            if len(a)>3:
                for x in refs(a[3]):yield from self.items_for(x,base,depth+1)
        elif typ=='IFCMAPPEDITEM':
            a=args(s); mapid=refs(a[0]); t=refs(a[1]);
            if mapid:
                ma=self.a(mapid[0]); mp=refs(ma[0]); origin=self.place_axis(mp[0]) if mp else IDENT
                mapped=mul(base,mul(self.trans_operator(t[0]) if t else IDENT,inverse_rigid(origin)))
                yield from self.items_for(mapid[0],mapped,depth+1)
        elif typ=='IFCPOLYGONALFACESET':
            yield eid,base
        elif typ=='IFCSHAPEASPECT':
            for x in refs(args(s)[-1]):yield from self.items_for(x,base,depth+1)

    def mesh(self,eid):
        if eid in self.geom_cache:return self.geom_cache[eid]
        a=self.a(eid); ptsid=refs(a[0]); faceids=refs(a[2]) if len(a)>2 else []
        if not ptsid:return [],[]
        coords=self.a(ptsid[0])
        points=[]
        # point list is a nested parenthesised list of tuples
        for tup in re.findall(r'\(([-+\d.,Ee ]+)\)', coords[0]):
            n=[float(v) for v in tup.split(',')]
            if len(n)>=3:points.append(n[:3])
        triangles=[]
        for fid in faceids:
            ft,fs=self.get(fid);fa=args(fs)
            idx=[int(v) for v in re.findall(r'\d+',fa[0])]
            if len(idx)<3:continue
            if any(i<1 or i>len(points) for i in idx):continue
            for k in range(1,len(idx)-1):triangles.append((idx[0]-1,idx[k]-1,idx[k+1]-1))
        self.geom_cache[eid]=(points,triangles)
        return points,triangles


def classify(name, psets):
    u=(name or '').upper()
    if 'IFCSPACE' in psets:return 7
    if 'DUCT' in u or '风管' in u:return 4
    if 'PIPE' in u or '水管' in u:return 5
    if 'CABLE' in u or '线槽' in u:return 6
    if u.startswith(('SW','WALL','CW')) or 'Pset_WallCommon' in psets:return 1
    if u.startswith(('SLA','FLOOR','SLAB')) or 'Pset_SlabCommon' in psets:return 2
    if u.startswith(('BMR','BEAM')) or 'Pset_BeamCommon' in psets:return 3
    return 0


def convert(path,outdir, progress=print):
    started=time.time();outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
    f=IFC(path);progress('Read IFC: '+str(len(f.ent))+' entities, '+str(round(time.time()-started,1))+'s')
    storeys=[];stor_by_id={};
    for eid,(typ,s) in f.ent.items():
        if typ=='IFCBUILDINGSTOREY':
            a=args(s);name=unquote(a[2]);elevation= float(a[-1])*f.data_unit if a[-1]!='$' else 0
            storeys.append({'id':eid,'name':name,'elevation':elevation})
    storeys.sort(key=lambda x:x['elevation'])
    for i,row in enumerate(storeys):stor_by_id[row['id']]=i+1
    containment={}
    for eid,(typ,s) in f.ent.items():
        if typ=='IFCRELCONTAINEDINSPATIALSTRUCTURE':
            a=args(s)
            dest=refs(a[-1]); members=refs(a[-2]);
            if dest and dest[0] in stor_by_id:
                for x in members:containment[x]=stor_by_id[dest[0]]
    # pset map: Pset names for proxies, read connections
    pset_by_product=collections.defaultdict(list)
    props_by_product=collections.defaultdict(dict)
    for eid,(typ,s) in f.ent.items():
        if typ=='IFCRELDEFINESBYPROPERTIES':
            a=args(s);pset_id=refs(a[-1]);members=refs(a[-2]);
            if pset_id:
                ps=f.get(pset_id[0]);pname=unquote(args(ps[1])[2]) if ps[0]=='IFCPROPERTYSET' else ''
                if pname:
                    propvals={}
                    pa=args(ps[1])
                    for pid in refs(pa[-1])[:24]:
                        pt,pst=f.get(pid)
                        if pt=='IFCPROPERTYSINGLEVALUE':
                            pv=args(pst)
                            if len(pv)>2:
                                key=unquote(pv[0])
                                value=unquote(pv[2])
                                if key and value not in ('$',''):propvals[key]=value[:140]
                    for m in members:
                        pset_by_product[m].append(pname)
                        if propvals:props_by_product[m].update({pname+'.'+k:v for k,v in list(propvals.items())[:18]})
    buildings=[]; spaces=[]; products=[]; supported=collections.Counter(); uncategorised=0
    for eid,(typ,s) in f.ent.items():
        if typ not in ('IFCBUILDINGELEMENTPROXY','IFCSPACE','IFCOPENINGELEMENT','IFCGRID','IFCANNOTATION'):
            continue
        a=args(s)
        if len(a)<7:continue
        rep=refs(a[6]);place=refs(a[5]);
        if typ=='IFCSPACE':name=unquote(a[7]) or unquote(a[2]) or f'Space #{eid}'
        else:name=unquote(a[2]) or f'{typ} #{eid}'
        guid=unquote(a[0]); pset_list=pset_by_product.get(eid,[])
        cat=7 if typ=='IFCSPACE' else classify(name,';'.join(pset_list))
        element={'id':eid,'guid':guid,'name':name,'type':typ,'category':cat,
                 'psets':pset_list[:16], 'properties':props_by_product.get(eid,{}), 'level':containment.get(eid,0),'bbox':None,
                 'geometry':bool(rep),'tag':unquote(a[7]) if typ=='IFCBUILDINGELEMENTPROXY' and len(a)>7 else ''}
        products.append((element,rep[0] if rep else None, f.placement(place[0]) if place else IDENT))
        if typ=='IFCSPACE':spaces.append(element)
        else:buildings.append(element)
    progress('Products: '+str(len(products))+', initial categories: '+str(collections.Counter(e[0]['category'] for e in products)))

    # Binary format (16 byte per unindexed vertex): little-endian xyz float32 + uint32 packed id/floor/category
    verts=array.array('f'); ids=array.array('I'); per_class=collections.Counter(); dropped=0; face_count=0; bounds=[1e30]*3+[-1e30]*3
    segments=[]
    for idx,(el,repid,placement) in enumerate(products):
        start_vertex=len(ids)
        pick=idx+1; bb=[1e30]*3+[-1e30]*3
        ntri=0
        if repid:
            try:
                for geomid,mapper in f.items_for(repid):
                    pts,tri=f.mesh(geomid)
                    if not pts or not tri:continue
                    matrix=mul(placement,mapper)
                    converted=[]
                    for v in pts:
                        p=apply(matrix,v)
                        # IFC Z-up -> WebGL Y-up, preserve handedness with (x,z,-y)
                        converted.append((p[0]*f.data_unit,p[2]*f.data_unit,-p[1]*f.data_unit))
                    packed=(pick & 0xfffff)|((el['category']&0xf)<<20)|((el['level']&0x7f)<<24)
                    for ii,jj,kk in tri:
                        for v in (converted[ii], converted[jj],converted[kk]):
                            verts.extend(v);ids.append(packed)
                            for d in range(3):
                                bb[d]=min(bb[d],v[d]);bb[d+3]=max(bb[d+3],v[d])
                        ntri+=1
            except Exception:
                dropped+=1
        segments.append((start_vertex,len(ids)))
        if ntri:
            el['bbox']=[round(v,4) for v in bb]
            el['triangles']=ntri
            supported[el['type']]+=1
            per_class[el['category']]+=1
            face_count+=ntri
            for d in range(3):bounds[d]=min(bounds[d],bb[d]);bounds[d+3]=max(bounds[d+3],bb[d+3])
        else:
            el['geometry']=False
        if idx%700==0 and idx>0:progress('Processed '+str(idx)+' / '+str(len(products)))
    if not face_count:raise ValueError('No supported IFC4 tessellated face geometry found; use IfcOpenShell for swept solids/other geometry types')
    # assign missing floors from average object vertical center based on storey elevation
    for el,_,_ in products:
        if el['level']==0 and el['bbox'] and storeys:
            # in IFC Z-up mm -> WebGL y-up in metres
            y=(el['bbox'][1]+el['bbox'][4])*0.5
            el['level']=min(range(len(storeys)),key=lambda k:abs(y-storeys[k]['elevation']))+1
        # index encoded in geometry set earlier so category visibility relies on live metadata; filters use JS pick index and shader mask based on category (encoded original)
    for (el,_,_), (a,b) in zip(products,segments):
        for k in range(a,b):ids[k]=(ids[k] & 0x00ffffff) | ((el['level']&127)<<24)
    progress('Geometry triangles: '+str(face_count)+'; '+str(round(time.time()-started,1))+'s')
    # packed ids contain floor=0 for elements without containment; browser floor filtering uses metadata via JS CPU repack as needed
    out=bytearray(len(ids)*16)
    for i,packed in enumerate(ids):
        struct.pack_into('<fffI',out,i*16,verts[i*3],verts[i*3+1],verts[i*3+2],packed)
    (outdir/'model.bin').write_bytes(out)
    stats={'entities':len(f.ent),'ifcTypes':dict(f.types),'products':len(products),'geometricProducts':sum(bool(x[0]['bbox']) for x in products),
           'triangles':face_count,'vertices':len(ids),'unitScale':f.data_unit,'droppedGeometry':dropped,
           'classified':dict(per_class),'ifcSystems':f.types['IFCSYSTEM'],'ports':f.types['IFCDISTRIBUTIONPORT'],
           'portConnections':f.types['IFCRELCONNECTSPORTS'],'unsupportedGeometryTypes':'IFC geometry types other than polygonal face sets are not tessellated in this stdlib importer',
           'classificationNote':'Proxy classification by name / Pset is heuristic and must be reviewed.'}
    manifest={'format':'WEA_WEBGL_V1','name':Path(path).stem,'schema':'IFC4','generator':'WEA Python IFC tessellated converter',
              'elements':[e for e,_,_ in products],'levels':storeys,'bounds':[round(v,4) for v in bounds],
              'rooms':[e['id'] for e in spaces], 'stats':stats,'binary':'model.bin'}
    (outdir/'model.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    progress('Saved '+str((outdir/'model.bin').stat().st_size//1024)+' KiB binary + manifest in '+str(round(time.time()-started,1))+'s')
    return stats

if __name__=='__main__':
    if len(sys.argv)<3:print('Usage: python3 tools/ifc_convert.py INPUT.ifc assets/');sys.exit(2)
    try: print(json.dumps(convert(sys.argv[1],sys.argv[2]),ensure_ascii=False,indent=2)[:1400])
    except Exception as exc:print('ERROR: '+repr(exc),file=sys.stderr);raise
