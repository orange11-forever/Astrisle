"""Render bounded local source files into editable Office documents and inspect OOXML."""

import base64
import csv
import hashlib
from importlib.metadata import PackageNotFoundError, distribution
from importlib.util import find_spec
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile


MAX_SOURCE = 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024
MAX_AST = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 384 * 1024
MAX_EMBEDDED_BYTES = 512 * 1024
MAX_EMBEDDED_IMAGES = 8
MAX_IMAGE_SIDE = 2048
MAX_JSON = 1024 * 1024
MAX_CELLS = 100_000
MAX_ROWS = 20_000
MAX_COLUMNS = 1_000
FORMATS = ('docx', 'xlsx', 'pptx')
NUMERIC = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?')
HYPERLINK_TYPES = {
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink',
}
IMAGE_TYPES = {'data:image/png;base64': 'PNG', 'data:image/jpeg;base64': 'JPEG'}


class OfficeError(Exception):
    pass


class DependencyError(OfficeError):
    pass


def plain_path(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise OfficeError('A bounded file path is required')
    candidate = Path(value)
    if not candidate.is_absolute() or '..' in candidate.parts:
        raise OfficeError('The worker requires an absolute, normalized path')
    for item in (candidate, *candidate.parents):
        if item.is_symlink() or item.is_junction():
            raise OfficeError('Symlinks and junctions are unsupported')
    return candidate


def read_bounded(path, limit):
    if not path.is_file():
        raise OfficeError('Input must be a regular file')
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise OfficeError(f'Input must be a regular file no larger than {limit} bytes')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise OfficeError(f'Input exceeds the {limit} byte limit')
    return data


def output_path(value):
    path = plain_path(value)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise OfficeError('Output must be a regular file with no alternate links')
    except FileNotFoundError:
        pass
    return path


def web_link(target):
    if any(ord(char) < 32 for char in target):
        return False
    try:
        parsed = urlsplit(target)
        if parsed.scheme in ('http', 'https'):
            return bool(parsed.hostname) and parsed.username is None and parsed.password is None
        return parsed.scheme == 'mailto' and not parsed.netloc and bool(parsed.path)
    except ValueError:
        return False


def validate_archive(archive, fmt):
    members = archive.infolist()
    if len(members) > 5000 or sum(entry.file_size for entry in members) > MAX_UNPACKED:
        raise OfficeError('Office archive exceeds unpacked size limit')
    names = {entry.filename.casefold() for entry in members}
    if len(names) != len(members):
        raise OfficeError('Duplicate archive members are unsupported')
    for entry in members:
        name = entry.filename.lower()
        if entry.flag_bits & 1 or name.startswith('/') or '\\' in name or '..' in name.split('/'):
            raise OfficeError('Encrypted or unsafe Office archive')
        chart_workbook = fmt == 'pptx' and name.startswith('ppt/embeddings/') and name.endswith('.xlsx')
        if chart_workbook:
            with zipfile.ZipFile(io.BytesIO(archive.read(entry))) as embedded:
                validate_archive(embedded, 'xlsx')
        forbidden = ('vbaproject', '/externallinks/', '/activex/', '/slicers/', '/pivot',
                     '/diagrams/', '/ctrlprops/', 'signature')
        if any(token in name for token in forbidden) or ('/embeddings/' in name and not chart_workbook):
            raise OfficeError('Unsupported macros, embedded objects, links or complex objects')
        if fmt == 'xlsx' and any(token in name for token in ('/drawings/', '/charts/', '/comments', '/threadedcomments/')):
            raise OfficeError('Workbook drawings, charts and comments require a native adapter')
        if not name.endswith(('.xml', '.rels')):
            continue
        data = archive.read(entry)
        xml_tokens = data.upper().replace(b'\x00', b'')
        if b'<!DOCTYPE' in xml_tokens or b'<!ENTITY' in xml_tokens:
            raise OfficeError('XML entities are unsupported')
        root = ET.fromstring(data)
        if name.startswith('customxml/') and name.endswith('.xml'):
            bibliography = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
            custom_xml = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'
            safe_bibliography = fmt == 'docx' and (
                (name == 'customxml/item1.xml' and root.tag == f'{{{bibliography}}}Sources' and len(root) == 0)
                or (
                    name == 'customxml/itemprops1.xml' and root.tag == f'{{{custom_xml}}}datastoreItem'
                    and all(element.get(f'{{{custom_xml}}}uri') == bibliography
                            for element in root.iter() if element.tag.endswith('schemaRef'))
                )
            )
            if not safe_bibliography:
                raise OfficeError('Unsupported custom XML')
        if name.endswith('.rels'):
            for relation in root:
                if relation.get('TargetMode', '').lower() == 'external' and not (
                    relation.get('Type') in HYPERLINK_TYPES and web_link(relation.get('Target', ''))
                ):
                    raise OfficeError('External relationships other than ordinary hyperlinks are unsupported')
        if any(element.tag.rsplit('}', 1)[-1] in ('altChunk', 'object', 'oleObj', 'control', 'ins', 'del')
               for element in root.iter()):
            raise OfficeError('Unsupported complex or tracked content')


def open_document(fmt, data, embedded_images=None):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        validate_archive(archive, fmt)
        if embedded_images:
            media_path = 'word/media/' if fmt == 'docx' else 'ppt/media/'
            media_hashes = {
                hashlib.sha256(archive.read(entry)).hexdigest()
                for entry in archive.infolist() if entry.filename.startswith(media_path)
            }
            if not embedded_images <= media_hashes:
                raise OfficeError('The rendered Office file did not preserve its embedded image bytes')
    source = io.BytesIO(data)
    if fmt == 'docx':
        from docx import Document
        return Document(source)
    if fmt == 'xlsx':
        from openpyxl import load_workbook
        return load_workbook(source, keep_links=False)
    from pptx import Presentation
    return Presentation(source)


def inspect_document(doc, fmt):
    if fmt == 'docx':
        return {
            'format': fmt,
            'paragraphs': [paragraph.text for paragraph in doc.paragraphs],
            'tables': [[[cell.text for cell in row.cells] for row in table.rows] for table in doc.tables],
        }
    if fmt == 'xlsx':
        sheets = []
        cells = 0
        for sheet in doc.worksheets:
            cells += sheet.max_row * sheet.max_column
            if cells > MAX_CELLS:
                raise OfficeError('Workbook exceeds inspection cell limit')
            rows = [
                [str(value) if value is not None and not isinstance(value, (str, int, float, bool)) else value
                 for value in row]
                for row in sheet.iter_rows(values_only=True)
            ]
            sheets.append({'name': sheet.title, 'rows': rows})
        return {'format': fmt, 'sheets': sheets, 'formulaRecalculated': False}
    slides = [
        {'shapes': [
            {'index': i, 'text': shape.text if shape.has_text_frame else None, 'chart': bool(shape.has_chart)}
            for i, shape in enumerate(slide.shapes)
        ]}
        for slide in doc.slides
    ]
    return {'format': fmt, 'slides': slides}


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def verification(doc, fmt, checks):
    result = {
        'structural': {'status': 'passed', 'detail': 'Saved bytes reopened by their format library.'},
        'numeric': {'status': 'not_run', 'detail': 'No independent sums requested.'},
        'application': {'status': 'not_run', 'detail': 'Target application rendering was not performed.'},
    }
    if not isinstance(checks, list) or len(checks) > 100:
        raise OfficeError('Expected up to 100 numeric checks')
    if not checks:
        return result
    if fmt != 'xlsx':
        raise OfficeError('Numeric range checks require XLSX')
    from openpyxl.utils.cell import range_boundaries
    results = []
    inspected = 0
    for check in checks:
        if not isinstance(check, dict) or not {'sheet', 'range', 'sum'} <= check.keys() or (
            check.keys() - {'sheet', 'range', 'sum', 'tolerance'}
        ):
            raise OfficeError('Numeric checks require sheet, range, sum and optional tolerance')
        sheet_name = check['sheet']
        range_text = check['range']
        expected = check['sum']
        tolerance = check.get('tolerance', 1e-9)
        if not finite_number(expected) or not finite_number(tolerance) or tolerance < 0:
            raise OfficeError('Invalid numeric expectation')
        if not isinstance(sheet_name, str) or sheet_name not in doc.sheetnames:
            raise OfficeError('Numeric check names an unknown worksheet')
        if not isinstance(range_text, str) or len(range_text) > 30:
            raise OfficeError('Numeric check requires a bounded cell range')
        c1, r1, c2, r2 = range_boundaries(range_text)
        if not all(isinstance(value, int) for value in (c1, r1, c2, r2)) or not (
            1 <= c1 <= c2 <= 16_384 and 1 <= r1 <= r2 <= 1_048_576
        ):
            raise OfficeError('Numeric range must use valid cell coordinates')
        inspected += (r2 - r1 + 1) * (c2 - c1 + 1)
        if inspected > MAX_CELLS:
            raise OfficeError('Numeric checks exceed the cell limit')
        sheet = doc[sheet_name]
        values = [cell.value for row in sheet.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2)
                  for cell in row]
        if not all(finite_number(value) for value in values):
            raise OfficeError('Numeric checks require numeric source cells without formulas')
        actual = math.fsum(values)
        results.append({'sheet': sheet_name, 'range': range_text, 'actual': actual,
                        'expected': expected, 'passed': abs(actual - expected) <= tolerance})
    result['numeric'] = {
        'status': 'passed' if all(check['passed'] for check in results) else 'failed',
        'detail': 'Independent Python math.fsum over numeric source cells.',
        'checks': results,
    }
    return result


def bundled_pandoc():
    try:
        package = distribution('pypandoc_binary')
    except PackageNotFoundError as error:
        raise DependencyError('Install workers/office/requirements.txt in the project virtual environment') from error
    name = 'pandoc.exe' if os.name == 'nt' else 'pandoc'
    path = Path(package.locate_file(f'pypandoc/files/{name}')).resolve()
    if not path.is_relative_to(Path(sys.prefix).resolve()) or not path.is_file() or not os.access(path, os.X_OK):
        raise DependencyError('Bundled Pandoc executable is missing from the project Python environment')
    return path


def capabilities():
    missing = [module for module in ('docx', 'openpyxl', 'pptx') if find_spec(module) is None]
    try:
        bundled_pandoc()
    except DependencyError:
        missing.append('pypandoc_binary')
    return {'ok': True, 'available': not missing, 'missing': missing}


def run_pandoc(binary, args, source, stdout):
    result = subprocess.run(
        [str(binary), '--sandbox', '--fail-if-warnings', *args, '+RTS', '-M256M', '-RTS'],
        input=source,
        stdout=stdout,
        stderr=subprocess.PIPE,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr[:1200].decode('utf-8', errors='replace').strip()
        raise OfficeError(f'Pandoc conversion failed ({result.returncode}): {detail}')


def read_embedded_image(target):
    from PIL import Image

    header, _, encoded = target.partition(',')
    fmt = IMAGE_TYPES.get(header)
    if fmt is None:
        raise OfficeError('Images must use inline PNG or JPEG base64 data URIs; file paths and web images are unsupported')
    if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        raise OfficeError('An embedded image exceeds 384 KiB')
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise OfficeError('Invalid embedded image base64') from error
    if len(data) > MAX_IMAGE_BYTES:
        raise OfficeError('An embedded image exceeds 384 KiB')
    try:
        with Image.open(io.BytesIO(data), formats=[fmt]) as image:
            if image.width > MAX_IMAGE_SIDE or image.height > MAX_IMAGE_SIDE:
                raise OfficeError('Embedded images can be at most 2048 pixels per side')
            if image.format != fmt or getattr(image, 'n_frames', 1) != 1:
                raise OfficeError('Embedded images must contain a single frame')
            image.verify()
        with Image.open(io.BytesIO(data), formats=[fmt]) as image:
            image.load()
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise OfficeError(f'Embedded image is invalid or does not match its {fmt} type') from error
    return data


def validate_markdown_ast(data):
    nodes = [json.loads(data)]
    image_count = 0
    image_bytes = 0
    image_hashes = set()
    while nodes:
        node = nodes.pop()
        if isinstance(node, list):
            nodes.extend(node)
        elif isinstance(node, dict):
            tag = node.get('t')
            if tag in ('RawInline', 'RawBlock'):
                raise OfficeError('Raw HTML is unsupported in native export')
            if tag == 'Image':
                image_count += 1
                if image_count > MAX_EMBEDDED_IMAGES:
                    raise OfficeError('Markdown sources support at most 8 embedded image references')
                image = read_embedded_image(node['c'][-1][0])
                image_bytes += len(image)
                if image_bytes > MAX_EMBEDDED_BYTES:
                    raise OfficeError('Embedded images exceed 512 KiB in total')
                image_hashes.add(hashlib.sha256(image).hexdigest())
            if tag == 'Link':
                target = node['c'][-1][0]
                if not target.startswith('#') and not web_link(target):
                    raise OfficeError('Markdown links must use web, email or same-document targets')
            nodes.extend(node.values())
    return image_hashes


def render_markdown(source, fmt, candidate):
    binary = bundled_pandoc()
    # Parse GFM with Pandoc itself to identify resources even in reference-style markup.
    with tempfile.TemporaryFile(dir=candidate.parent) as ast_file:
        run_pandoc(binary, ['--from=gfm-raw_html', '--to=json'], source, ast_file)
        ast_file.seek(0)
        ast = ast_file.read(MAX_AST + 1)
    if len(ast) > MAX_AST:
        raise OfficeError('Processed Markdown exceeds the document limit')
    images = validate_markdown_ast(ast)
    args = ['--from=json', f'--to={fmt}', f'--output={candidate}']
    if fmt == 'pptx':
        args.append('--slide-level=2')
    run_pandoc(binary, args, ast, subprocess.DEVNULL)
    return images


def csv_number(value):
    if not NUMERIC.fullmatch(value):
        return None
    digits = value.lstrip('-').replace('.', '').lstrip('0')
    if len(digits) > 15:
        return None
    if '.' not in value:
        return int(value)
    number = float(value)
    return number if math.isfinite(number) and (number != 0 or not digits) else None


def render_table(source, delimiter, candidate):
    from openpyxl import Workbook
    document = Workbook()
    sheet = document.active
    sheet.title = 'Data'
    table = csv.reader(io.StringIO(source.decode('utf-8-sig'), newline=''), delimiter=delimiter, strict=True)
    width = 0
    for row, values in enumerate(table, 1):
        width = max(width, len(values))
        if row > MAX_ROWS or width > MAX_COLUMNS or row * width > MAX_CELLS:
            raise OfficeError('Delimited source exceeds the table size limit')
        for column, value in enumerate(values, 1):
            if not value:
                continue
            if len(value) > 32_767:
                raise OfficeError('A cell exceeds the Excel text limit')
            number = csv_number(value)
            cell = sheet.cell(row, column, value if number is None else number)
            if number is None:
                # A spreadsheet must never evaluate user-supplied CSV text as a formula.
                cell.data_type = 's'
    document.save(candidate)


def inspect_delivery(source, checks):
    fmt = source.suffix.lower()[1:]
    if fmt not in FORMATS:
        raise OfficeError('Inspection requires a macro-free DOCX, XLSX or PPTX file')
    data = read_bounded(source, MAX_FILE)
    doc = open_document(fmt, data)
    document = inspect_document(doc, fmt)
    verified = verification(doc, fmt, checks)
    source_hash = hashlib.sha256(data).hexdigest()
    return {
        'ok': verified['numeric']['status'] != 'failed',
        'files': [],
        'document': document,
        'verification': verified,
        'sourceSha256': source_hash,
        'provenance': {'source': str(source), 'sourceSha256': source_hash, 'operation': 'inspect_delivery'},
    }


def render_source(source, target):
    source_extension = source.suffix.lower()
    fmt = target.suffix.lower()[1:]
    markdown = source_extension in ('.md', '.markdown') and fmt in ('docx', 'pptx')
    table = source_extension in ('.csv', '.tsv') and fmt == 'xlsx'
    if not markdown and not table:
        raise OfficeError('Supported outputs are Markdown to DOCX/PPTX and CSV/TSV to XLSX')
    data = read_bounded(source, MAX_SOURCE)
    data.decode('utf-8-sig')   # Reject broken UTF-8 before render.
    if b'\x00' in data:
        raise OfficeError('Publishing requires a UTF-8 text source')
    source_hash = hashlib.sha256(data).hexdigest()
    target.parent.mkdir(parents=True, exist_ok=True)
    output_path(str(target))
    descriptor, temporary_path = tempfile.mkstemp(prefix='.astrisle-render-', suffix=target.suffix, dir=target.parent)
    os.close(descriptor)
    candidate = Path(temporary_path)
    try:
        images = None
        if markdown:
            images = render_markdown(data, fmt, candidate)
        else:
            render_table(data, ',' if source_extension == '.csv' else '\t', candidate)
        candidate_data = read_bounded(candidate, MAX_FILE)
        doc = open_document(fmt, candidate_data, images)
        verified = verification(doc, fmt, [])
        if hashlib.sha256(read_bounded(plain_path(str(source)), MAX_SOURCE)).hexdigest() != source_hash:
            raise OfficeError('Source changed while rendering; existing output was preserved')
        output_hash = hashlib.sha256(candidate_data).hexdigest()
        result = {
            'ok': True,
            'files': [str(target)],
            'format': fmt,
            'verification': verified,
            'sourceSha256': source_hash,
            'outputSha256': output_hash,
            'provenance': {'source': str(source), 'sourceSha256': source_hash, 'operation': 'render_source'},
        }
        with candidate.open('r+b') as stream:
            os.fsync(stream.fileno())
        os.replace(candidate, output_path(str(target)))
        return result
    finally:
        candidate.unlink(missing_ok=True)


def handle(request):
    try:
        if not isinstance(request, dict) or request.get('schemaVersion', 1) != 1:
            raise OfficeError('Unsupported request schema')
        operation = request.get('operation')
        if operation == 'capabilities':
            return capabilities()
        if operation not in ('render_source', 'inspect_delivery'):
            raise OfficeError('Unsupported publishing operation')
        source = plain_path(request.get('source'))
        if operation == 'render_source':
            return render_source(source, output_path(request.get('output')))
        return inspect_delivery(source, request.get('checks', []))
    except (DependencyError, ModuleNotFoundError) as error:
        return {'ok': False, 'code': 'WORKER_UNAVAILABLE', 'output': str(error)[:2000], 'files': []}
    except (OfficeError, UnicodeError, csv.Error, ValueError, zipfile.BadZipFile, ET.ParseError) as error:
        return {'ok': False, 'code': 'OFFICE_UNSUPPORTED', 'output': str(error)[:2000], 'files': []}
    except Exception as error:
        return {'ok': False, 'code': 'OFFICE_FAILED', 'output': str(error)[:2000], 'files': []}


def main():
    raw = sys.stdin.buffer.read(MAX_JSON + 1)
    try:
        if len(raw) > MAX_JSON:
            raise OfficeError('Request exceeds JSON limit')
        result = handle(json.loads(raw.decode('utf-8')))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(encoded) > MAX_JSON:
            encoded = b'{"ok":false,"code":"SIZE_LIMIT","output":"Result exceeds protocol limit","files":[]}'
    except Exception as error:
        encoded = json.dumps({'ok': False, 'code': 'INVALID_REQUEST', 'output': str(error)[:1000], 'files': []}).encode('utf-8')
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    main()
