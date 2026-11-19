import { useState } from 'react';
import { sourceExportFormats } from '@astrisle/contracts';
import type { Artifact, HostAPI, SourceExportFormat } from '@astrisle/contracts';

const formatLabels: Record<SourceExportFormat, string> = {
  docx: 'Word',
  pptx: 'PPTX',
  xlsx: 'XLSX',
};

export function ArtifactSourceExport({
  artifact,
  disabled,
  exportSource,
}: {
  artifact: Artifact;
  disabled: boolean;
  exportSource: HostAPI['exportSourceArtifact'];
}) {
  const [pending, setPending] = useState<SourceExportFormat>();
  const [feedback, setFeedback] = useState<{ message: string; failed: boolean }>();
  const formats = sourceExportFormats(artifact.relativePath);
  if (artifact.validity === 'missing' || formats.length === 0) return null;
  const generate = async (format: SourceExportFormat) => {
    if (pending || disabled) return;
    setPending(format);
    setFeedback(undefined);
    try {
      const response = await exportSource({
        commissionId: artifact.commissionId,
        versionId: artifact.versionId,
        format,
      });
      setFeedback({
        message:
          response.code === 'cancelled'
            ? '已取消保存'
            : response.message || (response.ok ? '已保存生成的文档' : '生成失败，请重试。'),
        failed: !response.ok && response.code !== 'cancelled',
      });
    } catch {
      setFeedback({ message: '无法生成文档。请检查此版本后重试。', failed: true });
    } finally {
      setPending(undefined);
    }
  };

  return (
    <section className="artifact-source-export" aria-label="从此版本生成文档">
      <h3>从此版本生成文档</h3>
      <div className="button-row" aria-busy={Boolean(pending)}>
        {formats.map((format) => (
          <button
            type="button"
            key={format}
            disabled={disabled || !!pending}
            onClick={() => void generate(format)}
          >
            {pending === format
              ? `正在生成 ${formatLabels[format]}…`
              : `生成 ${formatLabels[format]}`}
          </button>
        ))}
      </div>
      <div className={`version-feedback${feedback?.failed ? ' failed' : ''}`} aria-live="polite">
        {feedback?.message}
      </div>
    </section>
  );
}
