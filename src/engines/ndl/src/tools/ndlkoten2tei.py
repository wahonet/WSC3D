# TEI converter
# Copyright 2025 Kiyonori Nagasaki
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import xml.etree.ElementTree as ET

xmltemplate="""<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="http://www.tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<?xml-model href="http://www.tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" type="application/xml"
	schematypens="http://purl.oclc.org/dsdl/schematron"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
      <fileDesc>
         <titleStmt>
            <title>Title</title>
            <respStmt>
               <resp>Automated Transcription</resp>
               <name ref="https://github.com/ndl-lab/ndlkotenocr-lite">NDL古典籍OCR-Liteアプリケーション</name>
            </respStmt>
            <respStmt><resp>Conversion to TEI encoding</resp>
               <name>Kiyonori Nagasaki</name>
            </respStmt>
         </titleStmt>
         <publicationStmt>
            <p>Publication Information</p>
         </publicationStmt>
         <sourceDesc>
            <p>Information about the source</p>
         </sourceDesc>
      </fileDesc>
  </teiHeader>
   <facsimile>
   </facsimile>
  <text>
      <body>
         <p></p>
      </body>
  </text>
</TEI>
"""

def convert_tei(ndl_jsons):
    root = ET.fromstring(xmltemplate)
    ns = {'tei': 'http://www.tei-c.org/ns/1.0',
          'xml': 'http://www.w3.org/XML/1998/namespace'}
    
    ET.register_namespace('', ns['tei'])
    ET.register_namespace('xml', ns['xml'])

    el_body_p = root.find('tei:text', ns).find('tei:body', ns).find('tei:p', ns)
    el_facsimile = root.find('tei:facsimile', ns)

    all_data = []
    for json_data in ndl_jsons:
        page_data = {}
        page_data["lines"] = []
        for content in json_data['contents'][0]:
            line_data = {}
            l_x = content["boundingBox"][0][0]
            l_y = content["boundingBox"][0][1]
            l_x2 = content["boundingBox"][3][0]
            l_y2 = content["boundingBox"][3][1]        
            line_data['rect'] = [l_x,l_y,l_x2,l_y2]
            line_data['text'] = content["text"]
            line_data['n'] = content["id"]
            page_data["lines"].append(line_data)
        page_data["imginfo"] = json_data["imginfo"]
        all_data.append(page_data)
    
    for pn,page in enumerate(all_data):
        pnt = str(pn).zfill(4)
        iname = page['imginfo']['img_name']
        lines = page['lines']
        el_surface = ET.SubElement(el_facsimile, 'surface')
        el_graphic = ET.SubElement(el_surface, 'graphic')
        image_path = page['imginfo']['img_path']
        el_graphic.set('url', image_path.replace(" ","%20"))
        el_graphic.set('width', str(page['imginfo']['img_width']) + 'px')
        el_graphic.set('height', str(page['imginfo']['img_height']) + 'px')
        lines_dict = {}
        for line in lines:
            nid = line['n']
            lnt = str(nid).zfill(3)
            plnt = 'L'+pnt+'_'+lnt
            zone_attrs = {
                'xml:id': plnt,
                'ulx': str(line['rect'][0]),
                'uly': str(line['rect'][1]),
                'lrx': str(line['rect'][2]),
                'lry': str(line['rect'][3]),
            }
            el_zone = ET.Element('zone', zone_attrs)
            el_surface.append(el_zone)
            lines_dict[nid] = f"{line['text']}\t{plnt}"
        el_pb = ET.Element('pb', {'n': iname, 'facs': f'#{iname}'})
        el_body_p.append(el_pb)
        for k, v in lines_dict.items():
            text, facs_id = v.split('\t')
            el_lb = ET.Element('lb', {'n': str(k), 'facs': f'#{facs_id}'})
            el_lb.tail = text 
            el_body_p.append(el_lb)
    ET.indent(root)
    xml_string = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    return xml_string
