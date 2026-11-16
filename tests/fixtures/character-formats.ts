import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';

export const asciiStl = `solid triangle
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 2 0
endloop
endfacet
endsolid triangle`;

export function binaryStl() {
  const bytes = new Uint8Array(134);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0].forEach((value, i) =>
    view.setFloat32(84 + i * 4, value, true),
  );
  return bytes;
}

/** Minimal FBX 7.4 binary, authored here instead of trusting an opaque downloaded fixture. */
export function binaryFbx() {
  type Node = { name: string; props?: (number | string | number[])[]; children?: Node[] };
  const nodes: Node[] = [
    {
      name: 'Objects',
      children: [
        {
          name: 'Geometry',
          props: [1, 'Geometry::Triangle', 'Mesh'],
          children: [
            { name: 'Vertices', props: [[0, 0, 0, 1, 0, 0, 0, 2, 0]] },
            { name: 'PolygonVertexIndex', props: [[0, 1, -3]] },
          ],
        },
        { name: 'Model', props: [2, 'Model::Triangle', 'Mesh'], children: [] },
      ],
    },
    {
      name: 'Connections',
      children: [
        { name: 'C', props: ['OO', 1, 2] },
        { name: 'C', props: ['OO', 2, 0] },
      ],
    },
  ];
  function property(value: number | string | number[], name: string) {
    if (typeof value === 'string') {
      const text = Buffer.from(value),
        result = Buffer.alloc(5 + text.length);
      result[0] = 83;
      result.writeUInt32LE(text.length, 1);
      text.copy(result, 5);
      return result;
    }
    if (typeof value === 'number') {
      const result = Buffer.alloc(9);
      result[0] = 76;
      result.writeBigInt64LE(BigInt(value), 1);
      return result;
    }
    const integers = name === 'PolygonVertexIndex',
      width = integers ? 4 : 8;
    const result = Buffer.alloc(13 + value.length * width);
    result[0] = integers ? 105 : 100;
    result.writeUInt32LE(value.length, 1);
    result.writeUInt32LE(value.length * width, 9);
    value.forEach((item, i) =>
      integers
        ? result.writeInt32LE(item, 13 + i * width)
        : result.writeDoubleLE(item, 13 + i * width),
    );
    return result;
  }
  function node(value: Node, start: number): Buffer {
    const name = Buffer.from(value.name),
      properties = Buffer.concat((value.props ?? []).map((item) => property(item, value.name)));
    const children: Buffer[] = [];
    let at = start + 13 + name.length + properties.length;
    for (const child of value.children ?? []) {
      const data = node(child, at);
      children.push(data);
      at += data.length;
    }
    if (value.children?.length) {
      children.push(Buffer.alloc(13));
      at += 13;
    }
    const header = Buffer.alloc(13);
    header.writeUInt32LE(at, 0);
    header.writeUInt32LE(value.props?.length ?? 0, 4);
    header.writeUInt32LE(properties.length, 8);
    header[12] = name.length;
    return Buffer.concat([header, name, properties, ...children]);
  }
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  \0\x1a\0', 0, 'binary');
  header.writeUInt32LE(7400, 23);
  const chunks: Buffer[] = [header];
  let at = 27;
  for (const value of nodes) {
    const data = node(value, at);
    chunks.push(data);
    at += data.length;
  }
  return Buffer.concat([...chunks, Buffer.alloc(176)]);
}

export function texturedFbx(image?: string, filename = 'texture.png') {
  const video = `\tVideo: 20, "Video::image", "Clip" {\n\t\tRelativeFilename: "${filename}"\n${image ? `\t\tContent: ,\n\t\t "${image}"\n` : ''}\t}\n\tTexture: 21, "Texture::image", "" {\n\t\tFileName: "${filename}"\n\t}\n`;
  return asciiFbx
    .replace('Objects:  {\n', 'Objects:  {\n' + video)
    .replace(
      'Connections:  {\n',
      'Connections:  {\n\tC: "OO",20,21\n\tC: "OP",21,3,"DiffuseColor"\n',
    );
}

export const asciiFbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 7400
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,2,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: *1 {
\t\t\t\ta: 0
\t\t\t}
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
\tMaterial: 3, "Material::blue", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tMultiLayer: 0
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",0.1,0.2,0.8
\t\t}
\t}
\tAnimationStack: 10, "AnimStack::Walk", "" {
\t}
\tAnimationLayer: 11, "AnimLayer::BaseLayer", "" {
\t}
\tAnimationCurveNode: 12, "AnimCurveNode::T", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",0
\t\t\tP: "d|Y", "Number", "", "A",0
\t\t\tP: "d|Z", "Number", "", "A",0
\t\t}
\t}
\tAnimationCurve: 13, "AnimCurve::", "" {
\t\tDefault: 0
\t\tKeyVer: 4008
\t\tKeyTime: *2 {
\t\t\ta: 0,46186158000
\t\t}
\t\tKeyValueFloat: *2 {
\t\t\ta: 0,1
\t\t}
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",3,2
\tC: "OO",2,0
\tC: "OO",11,10
\tC: "OO",12,11
\tC: "OP",13,12,"d|X"
\tC: "OP",12,2,"Lcl Translation"
}
`;

export function threeMf(
  options: {
    resource?: string;
    required?: string;
    texture?: string;
    implicit?: boolean;
    unsupportedResource?: boolean;
  } = {},
) {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" ${options.required ? `requiredextensions="${options.required}"` : ''}>
<resources>${options.implicit ? '<implicitfunction id="99"/>' : ''}${options.texture ? '<m:texture2d id="3" path="/3D/Textures/texture.png" contenttype="image/png"/><m:texture2dgroup id="2" texid="3"><m:tex2coord u="0" v="0"/><m:tex2coord u="1" v="0"/><m:tex2coord u="0" v="1"/></m:texture2dgroup>' : '<basematerials id="2"><base name="blue" displaycolor="#1A33CC"/></basematerials>'}
<object id="1" type="model" pid="2" pindex="0"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="0" z="2"/></vertices><triangles><triangle v1="0" v2="1" v3="2" ${options.texture ? 'pid="2" p1="0" p2="1" p3="2"' : ''}/>${options.unsupportedResource ? '<triangle v1="0" v2="1" v3="2" pid="99" p1="0"/>' : ''}</triangles></mesh></object></resources>
<build><item objectid="1"/></build></model>`;
  return zipSync({
    '_rels/.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${options.resource ?? '/3D/3dmodel.model'}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    '3D/3dmodel.model': strToU8(model),
    ...(options.texture
      ? {
          '3D/Textures/texture.png': Uint8Array.from(Buffer.from(options.texture, 'base64')),
          '3D/_rels/3dmodel.model.rels': strToU8(
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/Textures/texture.png" Id="texture0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/></Relationships>',
          ),
        }
      : {}),
  });
}

export function formatBundle(
  format: 'obj' | 'stl' | 'fbx' | '3mf',
  data: Uint8Array | string,
  companions: Record<string, string> = {},
) {
  return new TextEncoder().encode(
    JSON.stringify({
      astrisleCharacterAsset: 1,
      format,
      entry: `model.${format}`,
      files: {
        [`model.${format}`]: Buffer.from(data).toString('base64'),
        ...companions,
      },
    }),
  );
}
