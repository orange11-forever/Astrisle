import { useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { isValidCharacterName, type CharacterProfile, type HostAPI } from '@astrisle/contracts';

export function PartnerCreator({
  create,
  busy,
  onCreated,
}: {
  create: HostAPI['createCharacter'];
  busy: boolean;
  onCreated: (profile: CharacterProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const valid = isValidCharacterName(name);
  const close = () => {
    setOpen(false);
    setName('');
    setError('');
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!create || !valid || busy || saving) return;
    setSaving(true);
    setError('');
    try {
      const profile = await create(name.trim());
      close();
      onCreated(profile);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="partner-creator">
      <button
        type="button"
        ref={toggle}
        disabled={!create || busy || saving}
        aria-expanded={open}
        aria-controls={open ? 'create-partner-form' : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Plus size={15} aria-hidden="true" /> 添加伙伴
      </button>
      {open && (
        <form id="create-partner-form" onSubmit={submit} aria-label="添加伙伴" aria-busy={saving}>
          <label htmlFor="new-partner-name">伙伴名称</label>
          <input
            id="new-partner-name"
            value={name}
            autoFocus
            required
            maxLength={80}
            disabled={saving}
            aria-invalid={name.length > 0 && !valid}
            aria-describedby="new-partner-hint"
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
          />
          <p id="new-partner-hint" className="field-hint">
            {name.length > 0 && !valid
              ? '请输入 1–40 个可见字符。'
              : '伙伴将使用默认外观。创建后可以导入自己的模型。'}
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="button-row">
            <button className="primary" type="submit" disabled={!valid || busy || saving}>
              {saving ? '正在创建…' : '创建伙伴'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                close();
                toggle.current?.focus();
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
