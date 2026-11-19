import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from random import Random
import subprocess
import sys
import zipfile

from docx import Document
from openpyxl import Workbook, load_workbook
from PIL import Image
from pptx import Presentation
import pytest


MODULE = Path(__file__).parents[1] / 'worker.py'
SPEC = importlib.util.spec_from_file_location('astrisle_office_worker', MODULE)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


def render(source, target):
    return WORKER.handle({'operation': 'render_source', 'source': str(source), 'output': str(target)})


def inspect(source, checks=None):
    return WORKER.handle({'operation': 'inspect_delivery', 'source': str(source), 'checks': checks or []})


def test_editable_markdown_outputs_and_atomic_replacement(tmp_path):
    source = tmp_path / 'delivery.markdown'
    source.write_text(
        '# Summary\n\n## Findings\n\nA **verified** result with a [link](https://pandoc.org/).\n\n'
        '| Item | Total |\n| --- | --- |\n| Alpha | 15 |\n\n'
        '## Next steps\n\n- Review delivery\n',
        encoding='utf8',
    )
    word, slides = tmp_path / 'report.docx', tmp_path / 'deck.pptx'
    stable = source.read_bytes()
    for target in (word, slides):
        receipt = render(source, target)
        assert receipt['ok'], receipt
        assert receipt['sourceSha256'] == hashlib.sha256(stable).hexdigest()
        assert receipt['outputSha256'] == hashlib.sha256(target.read_bytes()).hexdigest()
        assert receipt['sourceSha256'] != receipt['outputSha256']
        assert receipt['verification']['structural']['status'] == 'passed'
    document = Document(word)
    assert 'Findings' in [paragraph.text for paragraph in document.paragraphs]
    assert document.tables[0].cell(1, 1).text == '15'
    assert any(run.bold for paragraph in document.paragraphs for run in paragraph.runs if run.text == 'verified')
    assert any(hyperlink.url == 'https://pandoc.org/' for paragraph in document.paragraphs
               for hyperlink in paragraph.hyperlinks)
    deck = Presentation(slides)
    titles = [slide.shapes.title.text for slide in deck.slides if slide.shapes.title]
    assert 'Findings' in titles and 'Next steps' in titles
    assert source.read_bytes() == stable

    source.write_text('# Refresh\n\nNew words', encoding='utf8')
    original = word.read_bytes()
    replacement = render(source, word)
    assert replacement['ok'], replacement
    assert word.read_bytes() != original
    assert 'Refresh' in inspect(word)['document']['paragraphs']


@pytest.mark.parametrize('text', [
    '![source image][picture]\n\n[picture]: file:///missing.png',
    '![network image](https://example.com/image.png)',
    '<img src="file:///missing.png" />',
    '[local resource](file:///missing.txt)',
    '[relative resource](./other.md)',
])
def test_unsupported_markdown_resources_preserve_existing_output(tmp_path, text):
    source, target = tmp_path / 'source.md', tmp_path / 'existing.docx'
    source.write_text(text, encoding='utf8')
    target.write_bytes(b'original')
    result = render(source, target)
    assert not result['ok'], result
    assert target.read_bytes() == b'original'
    assert sorted(path.name for path in tmp_path.iterdir()) == ['existing.docx', 'source.md']


def picture(format_name, size=(24, 12)):
    image = io.BytesIO()
    with Image.new('RGB', size, '#2c6a91') as graphic:
        graphic.save(image, format_name)
    return image.getvalue()


def image_markup(data, mime):
    return f'![Illustration](data:image/{mime};base64,{base64.b64encode(data).decode("ascii")})'


def test_embeds_exact_png_and_jpeg_media_in_both_native_formats(tmp_path):
    png, jpeg = picture('PNG'), picture('JPEG')
    source = tmp_path / 'illustrated.md'
    source.write_text(
        '\n\n'.join((
            '## Diagram',
            image_markup(png, 'png'),
            '## Photograph',
            image_markup(jpeg, 'jpeg'),
        )),
        encoding='utf8',
    )
    for suffix, folder in (('docx', 'word'), ('pptx', 'ppt')):
        target = tmp_path / f'illustrated.{suffix}'
        result = render(source, target)
        assert result['ok'], result
        assert inspect(target)['ok']
        with zipfile.ZipFile(target) as archive:
            media = {archive.read(path) for path in archive.namelist() if path.startswith(f'{folder}/media/')}
        assert {png, jpeg} <= media


@pytest.mark.parametrize('problem', ['mime', 'corrupt', 'dimensions', 'count'])
def test_rejects_invalid_and_unbounded_embedded_images(tmp_path, problem):
    if problem == 'mime':
        body = image_markup(picture('JPEG'), 'png')
    elif problem == 'corrupt':
        body = image_markup(b'\x89PNG\r\n\x1a\nInvalid payload', 'png')
    elif problem == 'dimensions':
        body = image_markup(picture('PNG', (2049, 1)), 'png')
    else:
        body = '\n\n'.join([image_markup(picture('PNG'), 'png')] * 9)
    source = tmp_path / 'invalid.md'
    source.write_text(body, encoding='utf8')
    target = tmp_path / 'existing.docx'
    target.write_bytes(b'prior bytes')
    result = render(source, target)
    assert not result['ok'], result
    assert target.read_bytes() == b'prior bytes'


def test_caps_single_and_total_decoded_image_bytes(tmp_path):
    def noisy_png(side):
        stream = io.BytesIO()
        data = Random(side).randbytes(side * side * 3)
        with Image.frombytes('RGB', (side, side), data) as image:
            image.save(stream, 'PNG')
        return stream.getvalue()

    source, target = tmp_path / 'large.md', tmp_path / 'existing.docx'
    target.write_bytes(b'prior bytes')
    source.write_text(image_markup(noisy_png(400), 'png'), encoding='utf8')
    result = render(source, target)
    assert not result['ok'] and '384 KiB' in result['output']

    medium = image_markup(noisy_png(300), 'png')
    source.write_text(f'{medium}\n\n{medium}', encoding='utf8')
    result = render(source, target)
    assert not result['ok'] and '512 KiB' in result['output']
    assert target.read_bytes() == b'prior bytes'


def test_tsv_numeric_identifiers_and_formula_strings(tmp_path):
    source, destination = tmp_path / 'data.tsv', tmp_path / 'data.xlsx'
    source.write_text(
        'Code\tAmount\tNotes\n001\t3.5\t=1+1\n002\t-4\t+SUM(B2)\n'
        '1234567890123456\t0\t@NAME\n000.5\t5\t-1+1\n',
        encoding='utf-8-sig',
    )
    rendered = render(source, destination)
    assert rendered['ok'], rendered
    workbook = load_workbook(destination)
    assert workbook.sheetnames == ['Data']
    sheet = workbook['Data']
    assert [sheet[f'A{i}'].value for i in range(2, 6)] == ['001', '002', '1234567890123456', '000.5']
    assert [sheet[f'B{i}'].value for i in range(2, 6)] == [3.5, -4, 0, 5]
    for row, value in enumerate(['=1+1', '+SUM(B2)', '@NAME', '-1+1'], 2):
        assert sheet[f'C{row}'].value == value
        assert sheet[f'C{row}'].data_type == 's'
    checked = inspect(destination, [{'sheet': 'Data', 'range': 'B2:B5', 'sum': 4.5}])
    assert checked['ok'], checked
    assert checked['verification']['numeric']['status'] == 'passed'
    assert checked['verification']['application']['status'] == 'not_run'


def test_reads_historical_xlsx_without_claiming_formula_recalculation(tmp_path):
    path = tmp_path / 'old.xlsx'
    workbook = Workbook()
    workbook.active.title = 'Budget'
    workbook.active.append([3])
    workbook.active.append([4])
    workbook.active.append(['=SUM(A1:A2)'])
    workbook.save(path)
    before = path.read_bytes()
    read = inspect(path, [{'sheet': 'Budget', 'range': 'A1:A2', 'sum': 7}])
    assert read['ok'], read
    assert read['document']['sheets'][0]['rows'][2][0] == '=SUM(A1:A2)'
    assert read['document']['formulaRecalculated'] is False
    assert not inspect(path, [{'sheet': 'Budget', 'range': 'A3', 'sum': 7}])['ok']
    assert path.read_bytes() == before


def test_unsafe_external_relationships_are_still_refused(tmp_path):
    source = tmp_path / 'unsafe.xlsx'
    Workbook().save(source)
    with zipfile.ZipFile(source, 'a') as archive:
        archive.writestr(
            'xl/_rels/unsafe.xml.rels',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId99" Type="test" TargetMode="External" '
            'Target="https://example.com/remote"/></Relationships>',
        )
    original = source.read_bytes()
    result = inspect(source)
    assert not result['ok'] and 'External relationships' in result['output']
    assert source.read_bytes() == original


def test_wrong_format_large_source_and_malformed_protocol_are_rejected(tmp_path):
    source, target = tmp_path / 'source.md', tmp_path / 'native.xlsx'
    source.write_text('Markdown', encoding='utf8')
    assert not render(source, target)['ok'] and not target.exists()
    source.write_bytes(b'a' * (WORKER.MAX_SOURCE + 1))
    target = tmp_path / 'native.docx'
    assert not render(source, target)['ok'] and not target.exists()
    receipt = subprocess.run([sys.executable, str(MODULE)], input=b'{broken', capture_output=True, timeout=10)
    response = json.loads(receipt.stdout)
    assert not response['ok'] and response['code'] == 'INVALID_REQUEST'
    assert not receipt.stderr


def test_worker_no_longer_accepts_binary_mutations(tmp_path):
    source = tmp_path / 'document.docx'
    document = Document()
    document.add_paragraph('Published before this upgrade')
    document.save(source)
    before = source.read_bytes()
    assert inspect(source)['document']['paragraphs'] == ['Published before this upgrade']
    for operation in ('create', 'edit', 'inspect', 'verify'):
        assert not WORKER.handle({'operation': operation, 'source': str(source)})['ok']
    assert source.read_bytes() == before
