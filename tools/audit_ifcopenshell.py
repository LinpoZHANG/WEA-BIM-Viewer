"""Optional audit using the real open-source IfcOpenShell engine.
Install: python3 -m pip install ifcopenshell
Run: python3 tools/audit_ifcopenshell.py source/imported.ifc
Does not run by default; complements the included stdlib IFC4 tessellation converter.
"""
import json,sys
import ifcopenshell
import ifcopenshell.util.element
p=sys.argv[1]
m=ifcopenshell.open(p)
summary={'schema':m.schema,'elements':len(m.by_type('IfcElement')),'spaces':len(m.by_type('IfcSpace')),
         'storeys':len(m.by_type('IfcBuildingStorey')),'systems':len(m.by_type('IfcSystem')),
         'proxies':len(m.by_type('IfcBuildingElementProxy'))}
print(json.dumps(summary,ensure_ascii=False,indent=2))
for wall in m.by_type('IfcWall')[:3]:
    print('Wall:',wall.GlobalId,wall.Name,ifcopenshell.util.element.get_psets(wall))
