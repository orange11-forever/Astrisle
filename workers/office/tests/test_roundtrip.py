import importlib.util
from pathlib import Path
import pytest
import zipfile
import subprocess
import sys

MODULE = Path(__file__).parents[1] / 'worker.py'

def handle(request):
    assert MODULE.exists(), 'Office worker implementation is missing'
    spec = importlib.util.spec_from_file_location('astrisle_office_worker', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.handle(request)

@pytest.mark.parametrize('fmt,content,edit,expected', [
    ('docx', {'paragraphs': ['Keep', 'Before'], 'tables': [[['Name', 'Value'], ['A', '3']]]}, {'paragraphs': [{'index': 1, 'text': 'After'}]}, 'After'),
    ('xlsx', {'sheets': [{'name': 'Data', 'rows': [['Name', 'Value'], ['A', 3], ['B', 4]], 'cells': {'B4': '=SUM(B2:B3)'}}]}, {'cells': [{'sheet': 'Data', 'cell': 'B2', 'value': 5}]}, 5),
    ('pptx', {'slides': [{'title': 'Keep', 'body': 'Before'}, {'title': 'Second', 'body': 'Untouched'}]}, {'texts': [{'slide': 0, 'shape': 1, 'text': 'After'}]}, 'After'),
])
def test_create_edit_reopen_preserves_source(tmp_path, fmt, content, edit, expected):
    source, target = tmp_path / f'source.{fmt}', tmp_path / f'edited.{fmt}'
    created = handle({'operation': 'create', 'format': fmt, 'output': str(source), 'content': content})
    assert created['ok'], created
    before = source.read_bytes()
    changed = handle({'operation': 'edit', 'source': str(source), 'output': str(target), 'changes': edit, 'inputVersionIds': ['v1']})
    assert changed['ok'], changed
    assert source.read_bytes() == before
    inspected = handle({'operation': 'inspect', 'source': str(target)})
    assert inspected['ok'], inspected
    assert str(expected) in str(inspected['document'])
    assert 'Keep' in str(inspected['document']) if fmt != 'xlsx' else 'Name' in str(inspected['document'])
    assert changed['verification']['structural']['status'] == 'passed'
    assert changed['provenance']['inputVersionIds'] == ['v1']

def test_original_cannot_be_overwritten(tmp_path):
    source = tmp_path / 'original.docx'
    assert handle({'operation':'create','format':'docx','output':str(source),'content':{'paragraphs':['safe']}})['ok']
    before = source.read_bytes()
    assert not handle({'operation':'edit','source':str(source),'output':str(source),'changes':{}})['ok']
    assert source.read_bytes() == before

def test_invalid_input_is_bounded_and_does_not_leak(tmp_path):
    source = tmp_path / 'bad.docx'; source.write_bytes(b'not a zip')
    output = tmp_path / 'out.docx'
    result = handle({'operation':'edit','source':str(source),'output':str(output),'changes':{}})
    assert not result['ok']
    assert not output.exists()
    assert list(tmp_path.iterdir()) == [source]

def test_formula_strings_are_not_reported_as_recalculation(tmp_path):
    output = tmp_path / 'sheet.xlsx'
    result = handle({'operation':'create','format':'xlsx','output':str(output),'content':{'sheets':[{'name':'Data','rows':[[3],[4]],'cells':{'A3':'=SUM(A1:A2)'}}]}})
    assert result['ok']
    assert result['verification']['numeric']['status'] == 'not_run'
    verified = handle({'operation':'verify','source':str(output),'checks':[{'sheet':'Data','range':'A1:A2','sum':7}]})
    assert verified['verification']['numeric']['status'] == 'passed'
    assert verified['verification']['application']['status'] == 'not_run'

def test_external_links_and_embedded_objects_rejected_before_write(tmp_path):
    source = tmp_path / 'external.xlsx'
    assert handle({'operation':'create','format':'xlsx','output':str(source),'content':{'sheets':[{'name':'Data','rows':[[1]]}]}})['ok']
    with zipfile.ZipFile(source, 'a') as archive:
        archive.writestr('xl/_rels/unsafe.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId99" Type="test" TargetMode="External" Target="https://example.com/leak"/></Relationships>')
    original = source.read_bytes(); target = tmp_path / 'edited.xlsx'
    result = handle({'operation':'edit','source':str(source),'output':str(target),'changes':{'cells':[]}})
    assert not result['ok'] and 'External' in result['output']
    assert source.read_bytes() == original and not target.exists()

def test_oversized_and_malformed_protocol_inputs(tmp_path):
    source = tmp_path / 'huge.docx'
    with source.open('wb') as stream: stream.truncate(32*1024*1024+1)
    assert not handle({'operation':'inspect','source':str(source)})['ok']
    result = subprocess.run([sys.executable, str(MODULE)], input=b'{broken', capture_output=True, timeout=10)
    import json
    decoded = json.loads(result.stdout)
    assert not decoded['ok'] and decoded['code'] == 'INVALID_REQUEST'
    assert not result.stderr

def test_presentation_chart_edit_preserves_unrelated_slide(tmp_path):
    source, output = tmp_path / 'chart.pptx', tmp_path / 'edited.pptx'
    content = {'slides':[{'title':'Chart', 'body':'Notes', 'chart':{'categories':['A','B'], 'series':[{'name':'Data','values':[1,2]}]}},{'title':'Keep','body':'Untouched'}]}
    assert handle({'operation':'create','format':'pptx','output':str(source),'content':content})['ok']
    result = handle({'operation':'edit','source':str(source),'output':str(output),'changes':{'charts':[{'slide':0,'shape':2,'categories':['A','B'],'series':[{'name':'Data','values':[5,8]}]}]}})
    assert result['ok'], result
    from pptx import Presentation
    deck = Presentation(output)
    assert list(deck.slides[0].shapes[2].chart.series[0].values) == [5,8]
    assert deck.slides[1].shapes.title.text == 'Keep'

def test_targeted_table_cell_and_workbook_style_edit_preserves_other_content(tmp_path):
    from docx import Document
    from openpyxl import load_workbook
    source, output = tmp_path/'table.docx', tmp_path/'new.docx'
    assert handle({'operation':'create','format':'docx','output':str(source),'content':{'paragraphs':['Unchanged'],'tables':[[['A','B'],['C','D']]]}})['ok']
    result = handle({'operation':'edit','source':str(source),'output':str(output),'changes':{'cells':[{'table':0,'row':1,'column':1,'text':'Changed'}]}})
    assert result['ok'], result
    doc=Document(output); assert doc.tables[0].cell(1,1).text == 'Changed' and doc.tables[0].cell(0,0).text == 'A' and doc.paragraphs[0].text == 'Unchanged'
    source, output = tmp_path/'styled.xlsx', tmp_path/'new.xlsx'
    assert handle({'operation':'create','format':'xlsx','output':str(source),'content':{'sheets':[{'name':'Data','rows':[['A',3],['B',4]],'styles':{'B1':{'bold':True,'numberFormat':'0.00'}}}]}})['ok']
    result = handle({'operation':'edit','source':str(source),'output':str(output),'changes':{'cells':[{'sheet':'Data','cell':'B2','value':9,'style':{'fill':'FFDD00'}}]}})
    assert result['ok'], result
    wb=load_workbook(output); assert wb['Data']['B1'].font.bold and wb['Data']['B1'].number_format == '0.00' and wb['Data']['B2'].value == 9
