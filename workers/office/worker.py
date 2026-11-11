"""Bounded JSON stdin/stdout Office worker. Produces new versions; never edits sources.

Trust boundary: executor authorizes every input/output path before invocation. This
worker validates regular files again, rejects unsafe OOXML and uses exclusive output.
It cannot isolate hostile concurrent host processes. It never claims app rendering.
"""
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_FILE = 32 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024
MAX_JSON = 2 * 1024 * 1024
MAX_CELLS = 100000

class OfficeError(Exception):
    pass

def plain_path(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise OfficeError('A bounded file path is required')
    candidate = Path(value).absolute()
    for item in [candidate, *candidate.parents]:
        if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
            raise OfficeError('Symlinks and junctions are unsupported')
    return candidate

def preflight(source):
    if not source.is_file() or source.stat().st_size > MAX_FILE:
        raise OfficeError('Input must be a regular Office file no larger than 32 MiB')
    if source.suffix.lower() not in ('.docx', '.xlsx', '.pptx'):
        raise OfficeError('Only macro-free DOCX/XLSX/PPTX files are supported')
    with zipfile.ZipFile(source) as archive:
        validate_archive(archive, source.suffix.lower()[1:])
    return source.suffix.lower()[1:]

def validate_archive(archive, fmt):
        members = archive.infolist()
        if len(members) > 5000 or sum(m.file_size for m in members) > MAX_UNPACKED:
            raise OfficeError('Office archive exceeds unpacked size limit')
        if len({m.filename for m in members}) != len(members):
            raise OfficeError('Duplicate archive members are unsupported')
        for member in members:
            name = member.filename.lower()
            if member.flag_bits & 1 or name.startswith('/') or '..' in name.split('/'):
                raise OfficeError('Encrypted or unsafe archive is unsupported')
            supported_chart_workbook = fmt == 'pptx' and name.startswith('ppt/embeddings/') and name.endswith('.xlsx')
            if supported_chart_workbook:
                with zipfile.ZipFile(io.BytesIO(archive.read(member))) as embedded:
                    validate_archive(embedded, 'xlsx')
            if any(token in name for token in ('vbaproject', '/externallinks/', '/activex/', '/slicers/', '/pivot', '/diagrams/', '/ctrlprops/', 'signature')) or ('/embeddings/' in name and not supported_chart_workbook):
                raise OfficeError('Unsupported macros, embedded objects, links or complex objects; original retained')
            if name.endswith(('.xml', '.rels')):
                data = archive.read(member)
                if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                    raise OfficeError('XML entities are unsupported')
                root = ET.fromstring(data)
                if name.startswith('customxml/') and name.endswith('.xml'):
                    safe_bibliography = fmt == 'docx' and ((name == 'customxml/item1.xml' and root.tag == '{http://schemas.openxmlformats.org/officeDocument/2006/bibliography}Sources' and len(root) == 0) or (name == 'customxml/itemprops1.xml' and root.tag == '{http://schemas.openxmlformats.org/officeDocument/2006/customXml}datastoreItem' and all(e.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/customXml}uri') == 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography' for e in root.iter() if e.tag.endswith('schemaRef'))))
                    if not safe_bibliography: raise OfficeError('Unsupported custom XML; original retained')
                if name.endswith('.rels') and any(e.attrib.get('TargetMode', '').lower() == 'external' for e in root):
                    raise OfficeError('External relationships are unsupported; original retained')
                if any(e.tag.rsplit('}', 1)[-1] in ('altChunk', 'object', 'oleObj', 'control', 'AlternateContent', 'ins', 'del') for e in root.iter()):
                    raise OfficeError('Unsupported complex or tracked content; original retained')
                if fmt == 'xlsx' and any(token in name for token in ('/drawings/', '/charts/', '/comments', '/threadedcomments/')):
                    raise OfficeError('Workbook drawings, charts and comments require a native adapter')

def limited_list(value, maximum=1000):
    if not isinstance(value, list) or len(value) > maximum:
        raise OfficeError('Expected bounded list')
    return value

def text(value):
    if not isinstance(value, str) or len(value) > 100000:
        raise OfficeError('Expected bounded text')
    return value

def index(value, size):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value >= size:
        raise OfficeError('Edit index outside document')
    return value

def scalar(value):
    if value is not None and not isinstance(value, (str, int, float, bool)):
        raise OfficeError('Unsupported cell value')
    if isinstance(value, str):
        text(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise OfficeError('Non-finite cell value')
    return value

def style_cell(cell, style):
    from openpyxl.styles import Font, PatternFill
    if not isinstance(style, dict) or set(style) - {'bold', 'numberFormat', 'fill'}:
        raise OfficeError('Unsupported cell style')
    if 'bold' in style:
        from copy import copy
        font = copy(cell.font); font.bold = bool(style['bold']); cell.font = font
    if 'numberFormat' in style:
        cell.number_format = text(style['numberFormat'])
    if 'fill' in style:
        color = text(style['fill'])
        if len(color) not in (6, 8) or any(c not in '0123456789abcdefABCDEF' for c in color):
            raise OfficeError('Fill must be RGB or ARGB hex')
        cell.fill = PatternFill('solid', fgColor=color)

def coordinates(value):
    from openpyxl.utils.cell import coordinate_to_tuple
    row, column = coordinate_to_tuple(text(value))
    if row < 1 or column < 1 or row > 10000 or column > 1000:
        raise OfficeError('Cell coordinate exceeds supported limits')
    return value

def open_document(fmt, source=None):
    if fmt == 'docx':
        from docx import Document
        return Document(source) if source else Document()
    if fmt == 'xlsx':
        from openpyxl import Workbook, load_workbook
        return load_workbook(source, keep_links=False) if source else Workbook()
    if fmt == 'pptx':
        from pptx import Presentation
        return Presentation(source) if source else Presentation()
    raise OfficeError('Unsupported Office format')

def create_document(fmt, content):
    if not isinstance(content, dict):
        raise OfficeError('content must be an object')
    doc = open_document(fmt)
    if fmt == 'docx':
        if set(content) - {'paragraphs', 'tables'}: raise OfficeError('Unsupported document content')
        for value in limited_list(content.get('paragraphs', [])):
            doc.add_paragraph(text(value))
        for rows in limited_list(content.get('tables', []), 100):
            rows = limited_list(rows, 1000)
            if not rows: raise OfficeError('A table must contain rows')
            width = len(limited_list(rows[0], 100))
            if width < 1: raise OfficeError('A table must contain columns')
            table = doc.add_table(rows=len(rows), cols=width)
            for row_index, row in enumerate(rows):
                if len(limited_list(row, 100)) != width: raise OfficeError('Table rows must have equal width')
                for column, value in enumerate(row): table.cell(row_index, column).text = text(value)
    elif fmt == 'xlsx':
        if set(content) - {'sheets'}: raise OfficeError('Unsupported workbook content')
        sheets = limited_list(content.get('sheets', []), 100)
        if not sheets: raise OfficeError('A workbook requires at least one sheet')
        doc.remove(doc.active)
        total = 0
        for sheet in sheets:
            if not isinstance(sheet, dict) or set(sheet) - {'name', 'rows', 'cells', 'styles'}: raise OfficeError('Unsupported sheet fields')
            name = text(sheet['name'])
            if name in doc.sheetnames: raise OfficeError('Duplicate sheet name')
            ws = doc.create_sheet(name)
            for row in limited_list(sheet.get('rows', []), 10000):
                row = limited_list(row, 1000); total += len(row)
                if total > MAX_CELLS: raise OfficeError('Workbook exceeds cell limit')
                ws.append([scalar(value) for value in row])
            for key, value in sheet.get('cells', {}).items(): ws[coordinates(key)] = scalar(value)
            for key, value in sheet.get('styles', {}).items(): style_cell(ws[coordinates(key)], value)
    else:
        if set(content) - {'slides'}: raise OfficeError('Unsupported presentation content')
        for item in limited_list(content.get('slides', []), 200):
            if not isinstance(item, dict) or set(item) - {'title', 'body', 'chart'}: raise OfficeError('Unsupported slide content')
            slide = doc.slides.add_slide(doc.slide_layouts[1])
            slide.shapes.title.text = text(item.get('title', ''))
            slide.placeholders[1].text = text(item.get('body', ''))
            if 'chart' in item:
                from pptx.chart.data import CategoryChartData
                from pptx.enum.chart import XL_CHART_TYPE
                from pptx.util import Inches
                chart = item['chart']; data = CategoryChartData()
                data.categories = [text(v) for v in limited_list(chart['categories'], 100)]
                for series in limited_list(chart['series'], 20):
                    values = limited_list(series['values'], 100)
                    if len(values) != len(chart['categories']) or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values): raise OfficeError('Chart series must be finite numbers matching categories')
                    data.add_series(text(series['name']), values)
                slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(3), Inches(8), Inches(3), data)
    return doc

def edit_document(doc, fmt, changes):
    if not isinstance(changes, dict): raise OfficeError('changes must be an object')
    if fmt == 'docx':
        if set(changes) - {'paragraphs', 'cells', 'appendParagraphs'}: raise OfficeError('Unsupported document change')
        for item in limited_list(changes.get('paragraphs', [])):
            paragraph = doc.paragraphs[index(item['index'], len(doc.paragraphs))]
            # Replacing a paragraph intentionally replaces its inline run formatting.
            paragraph.text = text(item['text'])
        for item in limited_list(changes.get('cells', [])):
            table = doc.tables[index(item['table'], len(doc.tables))]
            row = table.rows[index(item['row'], len(table.rows))]
            row.cells[index(item['column'], len(row.cells))].text = text(item['text'])
        for value in limited_list(changes.get('appendParagraphs', [])): doc.add_paragraph(text(value))
    elif fmt == 'xlsx':
        if set(changes) - {'cells'}: raise OfficeError('Unsupported workbook change')
        for item in limited_list(changes.get('cells', []), 10000):
            cell = doc[item['sheet']][coordinates(item['cell'])]
            if 'value' in item: cell.value = scalar(item['value'])
            if 'style' in item: style_cell(cell, item['style'])
    else:
        if set(changes) - {'texts', 'charts'}: raise OfficeError('Unsupported presentation change')
        for item in limited_list(changes.get('texts', [])):
            slide = doc.slides[index(item['slide'], len(doc.slides))]
            shape = slide.shapes[index(item['shape'], len(slide.shapes))]
            if not shape.has_text_frame: raise OfficeError('Selected shape has no text frame')
            shape.text = text(item['text'])
        for item in limited_list(changes.get('charts', []), 100):
            from pptx.chart.data import CategoryChartData
            slide = doc.slides[index(item['slide'], len(doc.slides))]
            shape = slide.shapes[index(item['shape'], len(slide.shapes))]
            if not shape.has_chart: raise OfficeError('Selected shape is not a chart')
            data = CategoryChartData(); categories = limited_list(item['categories'], 100)
            data.categories = [text(v) for v in categories]
            for series in limited_list(item['series'], 20):
                values = limited_list(series['values'], 100)
                if len(values) != len(categories) or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in values): raise OfficeError('Invalid chart series')
                data.add_series(text(series['name']), values)
            shape.chart.replace_data(data)

def inspect_document(doc, fmt):
    if fmt == 'docx':
        return {'format': fmt, 'paragraphs': [p.text for p in doc.paragraphs], 'tables': [[[c.text for c in row.cells] for row in table.rows] for table in doc.tables]}
    if fmt == 'xlsx':
        sheets = []
        for ws in doc.worksheets:
            if ws.max_row * ws.max_column > MAX_CELLS: raise OfficeError('Workbook exceeds inspect cell limit')
            sheets.append({'name': ws.title, 'rows': [[str(v) if v is not None and not isinstance(v, (str, int, float, bool)) else v for v in row] for row in ws.iter_rows(values_only=True)]})
        return {'format': fmt, 'sheets': sheets, 'formulaRecalculated': False}
    return {'format': fmt, 'slides': [{'shapes': [{'index': i, 'text': s.text if s.has_text_frame else None, 'chart': bool(s.has_chart)} for i, s in enumerate(slide.shapes)]} for slide in doc.slides]}

def verification(doc, fmt, checks=None):
    result = {'structural': {'status': 'passed', 'detail': 'Saved file reopened by its format library; parsed content included.'}, 'numeric': {'status': 'not_run', 'detail': 'No independent numeric checks requested; formulas are not recalculated.'}, 'application': {'status': 'not_run', 'detail': 'No target application rendering/open verification performed.'}}
    if checks:
        if fmt != 'xlsx': raise OfficeError('Numeric range checks currently require XLSX')
        from openpyxl.utils.cell import range_boundaries
        results = []
        for check in limited_list(checks, 100):
            ws = doc[check['sheet']]
            c1, r1, c2, r2 = range_boundaries(check['range'])
            if not all(isinstance(v, int) and v > 0 for v in (c1, r1, c2, r2)) or (r2-r1+1)*(c2-c1+1) > MAX_CELLS: raise OfficeError('Numeric range is oversized')
            values = [cell.value for row in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2) for cell in row]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values): raise OfficeError('Numeric check contains nonnumeric values or formulas; cached formulas are not independent evidence')
            actual = math.fsum(values); expected = check['sum']; tolerance = check.get('tolerance', 1e-9)
            if not isinstance(expected, (float, int)) or not math.isfinite(expected) or not isinstance(tolerance, (float, int)) or tolerance < 0 or not math.isfinite(tolerance): raise OfficeError('Invalid numeric expectation')
            results.append({'sheet': check['sheet'], 'range': check['range'], 'actual': actual, 'expected': expected, 'passed': abs(actual-expected) <= tolerance})
        result['numeric'] = {'status': 'passed' if all(c['passed'] for c in results) else 'failed', 'detail': 'Independent Python math.fsum over numeric source cells; not formula recalculation.', 'checks': results}
    return result

def handle(request):
    try:
        if not isinstance(request, dict) or len(json.dumps(request, ensure_ascii=False)) > MAX_JSON: raise OfficeError('Request exceeds JSON limit')
        if request.get('schemaVersion', 1) != 1: raise OfficeError('Unsupported schema version')
        operation = request.get('operation')
        if operation not in ('create', 'edit', 'inspect', 'verify', 'capabilities'): raise OfficeError('Unsupported operation')
        converter = shutil.which('soffice') or shutil.which('libreoffice')
        if not converter and os.name == 'nt':
            possible = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'LibreOffice/program/soffice.exe'
            converter = str(possible) if possible.is_file() else None
        if operation == 'capabilities': return {'ok': True, 'formats': ['docx', 'xlsx', 'pptx'], 'converter': converter, 'rendering': 'not_run', 'numeric': 'independent source-cell checks; no formula engine'}
        source = plain_path(request['source']) if 'source' in request else None
        fmt = preflight(source) if source else request.get('format')
        if fmt not in ('docx', 'xlsx', 'pptx'): raise OfficeError('Unsupported format')
        if operation != 'create' and not source: raise OfficeError('Source file is required')
        doc = create_document(fmt, request.get('content', {})) if operation == 'create' else open_document(fmt, source)
        before_hash = hashlib.sha256(source.read_bytes()).hexdigest() if source else None
        files = []
        if operation in ('create', 'edit'):
            output = plain_path(request.get('output'))
            if output.suffix.lower() != '.' + fmt: raise OfficeError('Output extension does not match format')
            if output.exists() or (source and output.resolve() == source.resolve()): raise OfficeError('Output must be a new file; source and existing files are never overwritten')
            if operation == 'edit': edit_document(doc, fmt, request.get('changes', {}))
            saved = io.BytesIO(); doc.save(saved)
            if saved.tell() > MAX_FILE: raise OfficeError('Output exceeds size limit')
            # Reopen the in-memory candidate before publishing anything.
            candidate = saved.getvalue(); reopened = open_document(fmt, io.BytesIO(candidate)); document = inspect_document(reopened, fmt)
            verified = verification(reopened, fmt, request.get('checks'))
            if source and hashlib.sha256(source.read_bytes()).hexdigest() != before_hash: raise OfficeError('Source changed while editing; output was not published')
            output.parent.mkdir(parents=True, exist_ok=True); plain_path(str(output))
            with output.open('xb') as stream: stream.write(candidate)
            # Real disk reread, not just the original in-memory object.
            try:
                doc = open_document(fmt, output); document = inspect_document(doc, fmt)
            except Exception:
                output.unlink(missing_ok=True); raise
            files = [str(output)]
        else:
            document = inspect_document(doc, fmt); verified = verification(doc, fmt, request.get('checks'))
        return {'ok': verified['numeric']['status'] != 'failed', 'files': files, 'document': document, 'verification': verified, 'provenance': {'source': str(source) if source else None, 'sourceSha256': before_hash, 'inputVersionIds': request.get('inputVersionIds', []), 'operation': operation, 'changes': request.get('changes', {})}, 'converter': {'available': bool(converter), 'path': converter, 'used': False}, 'limitations': ['Target text replacement replaces inline run formatting.', 'No formula engine or target-application visual verification.', 'Complex objects are rejected conservatively.']}
    except Exception as error:
        return {'ok': False, 'code': 'OFFICE_UNSUPPORTED' if isinstance(error, OfficeError) else 'OFFICE_FAILED', 'output': str(error)[:2000], 'files': []}

def main():
    raw = sys.stdin.buffer.read(MAX_JSON + 1)
    try:
        if len(raw) > MAX_JSON: raise OfficeError('Request exceeds JSON limit')
        result = handle(json.loads(raw.decode('utf-8')))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode('utf-8')) > MAX_JSON: encoded = json.dumps({'ok': False, 'code': 'SIZE_LIMIT', 'output': 'Result exceeds protocol limit', 'files': result.get('files', [])})
    except Exception as error:
        encoded = json.dumps({'ok': False, 'code': 'INVALID_REQUEST', 'output': str(error)[:1000], 'files': []})
    sys.stdout.buffer.write(encoded.encode('utf-8'))

if __name__ == '__main__':
    main()
