import unittest, sys, json, tempfile
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'tools'))
from ifc_convert import args,unquote,apply,mul,IDENT
try:
    import ifcopenshell, ifcopenshell.api as api
    from ifc_convert_ios import convert as ios_convert, resolve_coplanar
except ImportError:
    ios_convert=None

class ConverterTests(unittest.TestCase):
    def test_nested_ifc_args(self):
        self.assertEqual(args("#1,$,('x','y'),(#3,#4),'O''Neil'"),['#1','$',"('x','y')",'(#3,#4)',"'O''Neil'"])
    def test_chinese_ifc_decode(self):
        self.assertEqual(unquote("'\\X2\\8D775C45\\X0\\'"),'起居')
    def test_affine_transform(self):
        self.assertEqual(apply(mul(IDENT,IDENT),[2,3,4]),[2,3,4])
    def test_model_manifest(self):
        m=json.loads((ROOT/'assets'/'model.json').read_text('utf-8'))
        self.assertEqual(m['format'],'WEA_WEBGL_V2');self.assertTrue(m['levels']);self.assertTrue(m['materials'])
        L=m['layout'];n=L['vertices'];size=(ROOT/'assets'/'model.bin').stat().st_size
        ends=[L[k][0]+n*L[k][2]*{'f32':4,'i8':1,'u32':4,'u16':2}[L[k][1]] for k in ('position','normal','element','cover','material')]
        self.assertLessEqual(max(ends),size);self.assertLessEqual(L['opaqueVertices'],n)

def offset_of(m):
    return m.get('testOffset',(0.,0.))


def read_v2(d):
    m=json.loads((Path(d)/'model.json').read_text('utf-8'));L=m['layout'];n=L['vertices'];raw=(Path(d)/'model.bin').read_bytes()
    dt={'f32':'<f4','i8':'i1','u32':'<u4','u16':'<u2'}
    return {k:np.frombuffer(raw,dt[L[k][1]],n*L[k][2],L[k][0]).reshape(n,-1).squeeze() for k in ('position','normal','element','cover','material')}


def build_ifc(path, schema='IFC4', offset=(0.,0.)):
    """Wall with opening, two coincident slabs, and an assembly whose parts carry geometry."""
    f=api.run('project.create_file',version=schema)
    if schema=='IFC2X3':
        import ifcopenshell.api.owner.settings as ows
        org=f.createIfcOrganization(Name='WEA');user=f.createIfcPersonAndOrganization(f.createIfcPerson(FamilyName='WEA'),org)
        app=f.createIfcApplication(org,'1','WEA tests','WEA');ows.get_user=lambda f:user;ows.get_application=lambda f:app
    proj=api.run('root.create_entity',f,ifc_class='IfcProject',name='T');api.run('unit.assign_unit',f)
    model=api.run('context.add_context',f,context_type='Model')
    body=api.run('context.add_context',f,context_type='Model',context_identifier='Body',target_view='MODEL_VIEW',parent=model)
    site,bld,st=(api.run('root.create_entity',f,ifc_class=c,name=c) for c in ('IfcSite','IfcBuilding','IfcBuildingStorey'))
    for parent,child in ((proj,site),(site,bld),(bld,st)):api.run('aggregate.assign_object',f,relating_object=parent,products=[child])
    def make(cls,name,rep,x=0,y=0,z=0,contain=True):
        p=api.run('root.create_entity',f,ifc_class=cls,name=name);api.run('geometry.assign_representation',f,product=p,representation=rep)
        m=np.eye(4);m[:3,3]=(x+offset[0],y+offset[1],z);api.run('geometry.edit_object_placement',f,product=p,matrix=m)
        if contain:api.run('spatial.assign_container',f,products=[p],relating_structure=st)
        return p
    wall_rep=lambda l,h,t:api.run('geometry.add_wall_representation',f,context=body,length=l,height=h,thickness=t)
    slab_rep=lambda:api.run('geometry.add_slab_representation',f,context=body,depth=.2,polyline=[(0,0),(5,0),(5,4),(0,4)])
    wr=wall_rep(5,3,.2);wall=make('IfcWall','W1',wr)
    lay=api.run('layer.add_layer',f,name='A-WALL.建筑-墙');api.run('layer.assign_layer',f,items=[wr],layer=lay)   # CAD layer (IfcPresentationLayerAssignment)
    api.run('feature.add_feature',f,feature=make('IfcOpeningElement','O1',wall_rep(1,2,.6),x=2,y=-.2,contain=False),element=wall)
    make('IfcSlab','SlabA',slab_rep(),z=-.2);make('IfcSlab','SlabB',slab_rep(),z=-.2)
    asm=make('IfcElementAssembly','Asm',wall_rep(2,1,.1),y=3)
    parts=[make('IfcMember',f'Part{k}',wall_rep(1,1,.1),x=k,y=3,contain=False) for k in range(2)]
    api.run('aggregate.assign_object',f,relating_object=asm,products=parts)
    make('IfcPipeSegment' if schema!='IFC2X3' else 'IfcFlowSegment','Pipe1',wall_rep(3,.1,.1),y=1,z=2.5)
    # L-shaped room: its bbox centre (2.5, 2.5) lies outside the L
    room=make('IfcSpace','RoomL',api.run('geometry.add_slab_representation',f,context=body,depth=3,polyline=[(0,0),(5,0),(5,1.5),(1.5,1.5),(1.5,5),(0,5)]),contain=False)
    api.run('aggregate.assign_object',f,relating_object=st,products=[room])  # spaces are aggregated, not contained
    make('IfcSlab','CeilingL',api.run('geometry.add_slab_representation',f,context=body,depth=.15,polyline=[(0,0),(5,0),(5,1.5),(1.5,1.5),(1.5,5),(0,5)]),z=2.7)
    # IfcGrid placed at (1, 2): axis A along X (IfcIndexedPolyCurve in IFC4, IfcPolyline in IFC2X3), axis 1 along Y
    import ifcopenshell.util.unit as uu
    k=1/uu.calculate_unit_scale(f);pt=lambda x,y:f.createIfcCartesianPoint([x*k,y*k])
    curveA=f.createIfcIndexedPolyCurve(f.createIfcCartesianPointList2D([[0.,0.],[5*k,0.]]),None,None) if schema=='IFC4' else f.createIfcPolyline([pt(0,0),pt(5,0)])
    grid=api.run('root.create_entity',f,ifc_class='IfcGrid',name='Axes')
    grid.UAxes=[f.createIfcGridAxis('A',curveA,True)];grid.VAxes=[f.createIfcGridAxis('1',f.createIfcPolyline([pt(0,-1),pt(0,4)]),True)]
    m=np.eye(4);m[:3,3]=(1+offset[0],2+offset[1],0);api.run('geometry.edit_object_placement',f,product=grid,matrix=m)
    api.run('spatial.assign_container',f,products=[grid],relating_structure=st)
    f.write(str(path))


@unittest.skipIf(ios_convert is None,'IfcOpenShell pipeline not installed (see requirements.txt)')
class IfcOpenShellPipelineTests(unittest.TestCase):
    def convert(self,schema,offset=(0.,0.)):
        d=Path(tempfile.mkdtemp());build_ifc(d/'t.ifc',schema,offset)
        ios_convert(d/'t.ifc',d,progress=lambda *_:None)
        m=json.loads((d/'model.json').read_text('utf-8'));m['testOffset']=offset;m['_dir']=str(d)
        return m,{e['name']:e for e in m['elements']},read_v2(d)
    def check_model(self,m,els,raw):
        self.assertIsNone(els['O1']['bbox'],'openings must not be rendered as solids')
        self.assertGreater(els['W1']['triangles'],12,'opening must be cut into the wall')
        self.assertIsNone(els['Asm']['bbox'],'assembly drawn twice when its parts have geometry')
        self.assertTrue(els['Part0']['bbox'] and els['Part1']['bbox'])
        self.assertEqual([els['W1']['category'],els['SlabA']['category'],els['Part0']['category']],[1,2,3])
        # coincident slabs: exactly one keeps the surface, the other only as a duplicate range covered by it
        idx={e['name']:i for i,e in enumerate(m['elements'])}
        self.assertEqual(els['SlabB']['triangles'],0)
        self.assertTrue(els['SlabB']['bbox'])
        el,cover=raw['element'],raw['cover']
        self.assertEqual(set(cover[el==idx['SlabB']].tolist()),{idx['SlabA']+1},'SlabB only survives as a piece covered by SlabA')
        self.assertTrue((cover[el==idx['SlabA']]==0).all(),'the kept slab is never a hidden duplicate')
        self.assertLess(np.abs(np.linalg.norm(raw['normal'][:,:3].astype(float),axis=1)/127-1).max(),.03)
        self.assertEqual(els['Pipe1']['discipline'],'MEP');self.assertEqual(els['W1']['discipline'],'ARCH')
        self.assertEqual(els['W1']['layer'],'A-WALL.建筑-墙');self.assertIsNone(els['SlabA']['layer'])
        vp=els['RoomL']['viewpoint'];o=m['origin'];x,y=vp['eye'][0]+o[0]-offset_of(m)[0],-vp['eye'][2]+o[1]-offset_of(m)[1]
        from shapely.geometry import Point,Polygon
        self.assertTrue(Polygon([(0,0),(5,0),(5,1.5),(1.5,1.5),(1.5,5),(0,5)]).buffer(-.1).contains(Point(x,y)),(x,y))
        self.assertAlmostEqual(vp['eye'][1]-vp['floor'],1.6,2)
        rooms=json.loads((Path(m['_dir'])/'rooms.json').read_text('utf-8'))   # lighting work areas, separate file
        room=rooms['rooms'][els['RoomL']['guid']]
        self.assertAlmostEqual(room['area'],5*1.5+1.5*3.5,2);self.assertAlmostEqual(room['floor'],0,3)
        self.assertAlmostEqual(room['ceilings'][0]['height'],2.7,2);self.assertGreater(room['ceilings'][0]['coverage'],.95)
        self.assertEqual(room['ceilings'][0]['elements'][0]['name'],'CeilingL');self.assertFalse(room['needsConfirmation'])
        self.assertTrue(rooms['project']['guid'])
        # grid axes for plan positioning, in the same IFC local frame as the rooms
        g=rooms['grids'][0];self.assertEqual(g['name'],'Axes');self.assertEqual(rooms['gridAxesSkipped'],0)
        ax={a['tag']:np.array(a['points'])+np.array(o[:2])-np.array(offset_of(m)) for a in g['axes']}
        np.testing.assert_allclose(ax['A'],[[1,2],[6,2]],atol=1e-6);np.testing.assert_allclose(ax['1'],[[1,1],[1,6]],atol=1e-6)
    def test_ifc4(self):
        m,els,raw=self.convert('IFC4');self.check_model(m,els,raw)
        self.assertEqual(m['origin'],[0.,0.,0.])
    def test_ifc2x3_georeferenced(self):
        m,els,raw=self.convert('IFC2X3',offset=(500000.,4000000.));self.check_model(m,els,raw)
        self.assertNotEqual(m['origin'][:2],[0.,0.])
        self.assertLess(np.abs(raw['position']).max(),100,'vertices must be local for float32 precision')
    def test_conversion_is_deterministic(self):
        d=Path(tempfile.mkdtemp());build_ifc(d/'t.ifc')
        outs=[]
        for k in range(2):
            o=d/f'o{k}';ios_convert(d/'t.ifc',o,progress=lambda *_:None)
            outs.append([(o/f).read_bytes() for f in ('model.bin','model.json','rooms.json')])
        self.assertEqual(outs[0],outs[1],'same IFC must give byte-identical geometry, manifest and rooms')
    def test_radiance_simulation(self):
        try:import radiance_sim
        except ImportError:self.skipTest('pyradiance not installed')
        import math
        d=Path(tempfile.mkdtemp());build_ifc(d/'t.ifc');ios_convert(d/'t.ifc',d,progress=lambda *_:None)
        rooms=json.loads((d/'rooms.json').read_text('utf-8'));room=next(r for r in rooms['rooms'].values() if r['name']=='RoomL')
        m=math.log(.5)/math.log(math.cos(math.radians(30)));lum=[0.75,0.75,room['ceilings'][0]['z']-0.01]
        # 0-2 unobstructed; 3 behind Pipe1 (y 1.0-1.1, z 2.5-2.6) as seen from the luminaire; 4 inside the floor slab
        sensors=[[0.75,0.75,0.8],[0.75,0.4,0.8],[1.3,0.6,0.8],[0.75,3.5,0.8],[0.75,0.75,-0.1]]
        req={'room':room,'sensors':sensors,'emitters':[{'p':lum,'axis':[0,0,-1],'m':m,'flux':600}],'quality':'direct','electric':True,'daylight':{'enabled':False}}
        r=radiance_sim.simulate(req,d)
        I0=600*(m+1)/(2*math.pi)
        for (x,y,z),E in list(zip(sensors,r['components']['electric']))[:3]:
            dx,dy,dz=lum[0]-x,lum[1]-y,lum[2]-z;r2=dx*dx+dy*dy+dz*dz;c=dz/math.sqrt(r2)
            self.assertAlmostEqual(E,I0*c**m*c/r2,delta=max(.5,.02*E),msg='Radiance direct = I·cosα/r²')
        dx,dy,dz=lum[0]-.75,lum[1]-3.5,lum[2]-.8;r2=dx*dx+dy*dy+dz*dz;c=dz/math.sqrt(r2)
        self.assertLess(r['components']['electric'][3],0.2*I0*c**m*c/r2,'the pipe occludes the direct light')
        self.assertNotIn('daylight',r['components'])
        self.assertIn(4,r['blocked'],'sensor inside the slab is flagged')
        # luminous surface (assigned BIM element): 0.5 x 0.5 m panel facing down 1.8 m above the sensor, L = 1000 cd/m²
        z=lum[2]-0.1;tri=lambda a,b,c:[a,b,c];P=lambda x,y:[x,y,z]
        panel=[tri(P(.5,.5),P(.5,1.),P(1.,.5)),tri(P(1.,.5),P(.5,1.),P(1.,1.))]          # clockwise from above = normal -z
        r=radiance_sim.simulate({**req,'emitters':[],'areaSources':[{'luminance':1000,'triangles':panel}]},d)
        h=z-.8;a=.25;ff=lambda x,y:x/math.sqrt(1+x*x)*math.atan(y/math.sqrt(1+x*x))+y/math.sqrt(1+y*y)*math.atan(x/math.sqrt(1+y*y))
        E0=1000*4*ff(a/h,a/h)/2             # exact: E = (L/2)·[…] per corner rectangle, 4 quadrants around the point
        self.assertAlmostEqual(r['components']['electric'][0],E0,delta=.05*E0,msg='Radiance area source = analytic rectangle')
        req.update(quality='draft',electric=False,daylight={'enabled':True,'month':12,'day':21,'hour':12,'sky':'overcast','latitude':39.9,'longitude':116.4,'timezone':8,'northRotation':0})
        r=radiance_sim.simulate(req,d)
        self.assertNotIn('electric',r['components']);self.assertGreater(min(r['components']['daylight'][:3]),10,'overcast sky lights the open room')
    def test_elv_drawings(self):
        try:import elv_drawings,ezdxf,io
        except ImportError:self.skipTest('ezdxf not installed')
        d=Path(tempfile.mkdtemp());build_ifc(d/'t.ifc');ios_convert(d/'t.ifc',d,progress=lambda *_:None)
        rooms=json.loads((d/'rooms.json').read_text('utf-8'))['rooms'];gid=next(g for g,r in rooms.items() if r['name']=='RoomL')
        fx=lambda i,t,x,y,P,extra={}:{'fixtureId':f'F{i}','name':f'F{i}','fixtureType':t,'roomId':gid,'position':{'ifcWorld':[x,y,2.69]},
            'rotation':{'aimTilt':0,'aimAzimuth':0,'bodyRotation':0},'photometricParameters':{'flux':600,'power':P,'beamAngle':60,'cct':3000,'dimming':100,'on':True,'length':1.2},**extra}
        design={'activeScheme':'A','schemes':{'A':{'fixtures':[fx(1,'downlight',.7,.7,7),fx(2,'downlight',.7,3.5,7),fx(3,'linear',3.5,.7,20)]}},'sourceModel':{'name':'t'}}
        blobs,summ,svgs=elv_drawings.generate(design,d,{'lvVoltage':24,'dropLimit':3},preview=True)
        self.assertEqual(set(svgs),set(blobs));self.assertTrue(all(v.lstrip().startswith('<svg') or '<svg' in v[:300] for v in svgs.values()),'SVG previews of the same DXFs')
        self.assertEqual(len(blobs),5)
        for b in blobs.values():
            doc=ezdxf.read(io.StringIO(b.decode('utf-8')));self.assertEqual(doc.header['$INSUNITS'],4)
        r=summ['rooms'][0];self.assertEqual([g['name'] for g in r['groups']],['筒灯','线性灯'])
        drv=r['drivers'][0];self.assertEqual((drv['voltage'],drv['rating']),(24,30),'20 W x 1.2 -> 30 W driver')
        self.assertLess(drv['maxDropPct'],3)
        plan=ezdxf.read(io.StringIO(blobs['01_照明控制平面图.dxf'].decode('utf-8')))
        self.assertGreater(len(plan.modelspace().query('LINE[layer=="A-WALL"]')),10,'plan cut of the walls')
        self.assertEqual(len(plan.modelspace().query('LWPOLYLINE[layer=="E-CTRL-DEV"]')),1,'one control panel')
        # 220 V lighting circuits: board, circuit within limits, LV linear fixture counted through its driver
        m=summ['mains'];self.assertEqual(len(m['circuits']),1);c=m['circuits'][0]
        self.assertEqual(c['fixtures'],3,'2 downlights + 1 driver');self.assertAlmostEqual(c['power'],7+7+30/.9,3)
        self.assertLessEqual(c['current'],10);self.assertGreaterEqual(c['section'],2.5);self.assertLess(c['drop'],3);self.assertGreater(c['length'],2)
        self.assertFalse(m['board']['confirmed'],'no entrance room in the synthetic model: board flagged')
        pw=ezdxf.read(io.StringIO(blobs['04_照明配电平面图.dxf'].decode('utf-8')))
        self.assertGreaterEqual(len(pw.modelspace().query('LWPOLYLINE[layer=="E-PWR"]')),3,'home run + 2 links')
        self.assertEqual(len(pw.modelspace().query('LWPOLYLINE[layer=="E-PWR-SW"]')),1,'one switch leg')
        # limits split circuits; a designer-placed board is used as is
        many={'activeScheme':'A','schemes':{'A':{'fixtures':[fx(10+i,'downlight',.4+.4*(i%4),.4+.3*(i//4),60) for i in range(16)]}},'sourceModel':{'name':'t'}}
        _,s2=elv_drawings.generate(many,d,{'maxCurrent':2,'board':{'world':[1,1]}})
        cs=s2['mains']['circuits'];self.assertGreater(len(cs),1);self.assertTrue(all(x['current']<=2+1e-9 for x in cs));self.assertTrue(s2['mains']['board']['confirmed'])
        self.assertEqual(sum(x['fixtures'] for x in cs),16)
    def test_obj_texture_scale(self):
        # Archicad-style OBJ: a 2 m floor quad whose texture repeats every 0.5 m (u) / 1 m (v), u along +Y (90°),
        # and a wall quad whose u runs vertically every 0.4 m -> sizes, plan angle and wall rotation recovered
        import obj_textures as ot
        from PIL import Image
        d=Path(tempfile.mkdtemp());(d/'m').mkdir();Image.new('RGB',(64,64),(200,150,100)).save(d/'m'/'wood.jpg')
        (d/'t.mtl').write_text('newmtl WD-test\nKd 0.5 0.5 0.5\nmap_Kd m/wood.jpg\n',encoding='utf-8')
        (d/'t.obj').write_text('\n'.join(['mtllib t.mtl','g SLAB 1F WD-test','usemtl WD-test',
            'v 0 0 0','v 2000 0 0','v 2000 2000 0','v 0 2000 0','vt 0 0','vt 0 -2','vt 4 -2','vt 4 0','f 1/1 2/2 3/3 4/4',
            'v 0 0 0','v 3000 0 0','v 3000 0 2400','v 0 0 2400','vt 0 0','vt 0 1','vt 6 1','vt 6 0','f 5/5 6/6 7/7 8/8']),encoding='utf-8')
        out=d/'assets';import sys as _s;argv=_s.argv;_s.argv=['x',str(d/'t.obj'),str(out)]
        try:ot.main()
        finally:_s.argv=argv
        m=json.loads((out/'surfaces.json').read_text('utf-8'))['materials']['WD-test']
        self.assertAlmostEqual(m['horizontal']['sizeU'],.5,3);self.assertAlmostEqual(m['horizontal']['sizeV'],1,3);self.assertAlmostEqual(m['horizontal']['angle'],90,1)
        self.assertAlmostEqual(m['vertical']['sizeU'],.4,3);self.assertAlmostEqual(m['vertical']['sizeV'],3,3);self.assertEqual(m['vertical']['rotation'],90)
        self.assertTrue((out/m['texture']['file']).exists())
    def test_layered_faces_keep_front_most(self):
        # two same-facing squares 1 mm apart: the front one (larger offset along +Z) must survive intact
        sq=lambda z:np.array([[[0,0,z],[1,0,z],[1,1,z]],[[0,0,z],[1,1,z],[0,1,z]]],float)
        mat=np.zeros(2,int)
        kept,dups,_=resolve_coplanar({0:(sq(0.),mat),1:(sq(.001),mat)},[{'id':1,'category':1},{'id':2,'category':1}])
        self.assertEqual(len(kept[0][0]),0);self.assertEqual(len(kept[1][0]),2);self.assertIn((0,1),dups)

if __name__=='__main__':unittest.main(verbosity=2)
