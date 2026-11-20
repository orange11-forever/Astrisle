import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import type { HostAPI, PartnerDialogueReference, PartnerDialogueReply } from '@astrisle/contracts';
import { PARTNER_DIALOGUE_ERRORS, PARTNER_DIALOGUE_LIMITS } from '@astrisle/contracts';

export interface DialogueTarget {
  commissionId: string;
  partnerId: string;
}

interface DialogueSession {
  draft: string;
  turns: (PartnerDialogueReply & { question: string })[];
  pending: boolean;
  error: string;
}

const emptySession: DialogueSession = { draft: '', turns: [], pending: false, error: '' };

export function usePartnerDialogue(target?: DialogueTarget, ask?: HostAPI['askPartner']) {
  const [sessions, setSessions] = useState(() => new Map<string, DialogueSession>());
  const pending = useRef(new Set<string>());
  const key = target ? JSON.stringify([target.commissionId, target.partnerId]) : '';
  const session = sessions.get(key) ?? emptySession;
  const update = (change: (previous: DialogueSession) => DialogueSession) => {
    if (key) {
      setSessions((previous) =>
        new Map(previous).set(key, change(previous.get(key) ?? emptySession)),
      );
    }
  };
  const submit = async () => {
    const question = session.draft.trim();
    if (
      !target ||
      !ask ||
      !question ||
      question.length > PARTNER_DIALOGUE_LIMITS.question ||
      pending.current.has(key)
    )
      return;
    pending.current.add(key);
    update((previous) => ({ ...previous, pending: true, error: '' }));
    const history = session.turns
      .slice(-PARTNER_DIALOGUE_LIMITS.history)
      .map(({ question, answer }) => ({ question, answer }));
    try {
      const reply = await ask({ ...target, question, history });
      update((previous) => ({
        ...previous,
        draft: '',
        pending: false,
        turns: [...previous.turns, { ...reply, question }],
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known = Object.values(PARTNER_DIALOGUE_ERRORS).find((text) => message.endsWith(text));
      update((previous) => ({
        ...previous,
        pending: false,
        error: known ?? '未能取得回答。你可以重新发送问题。',
      }));
    } finally {
      pending.current.delete(key);
    }
  };

  return {
    session,
    submit,
    setDraft: (draft: string) => update((previous) => ({ ...previous, draft, error: '' })),
  };
}

export function PartnerDialogue({
  name,
  commission,
  dialogue,
  supported,
  configured,
  onBack,
  onSettings,
  onReference,
}: {
  name: string;
  commission: string;
  dialogue: ReturnType<typeof usePartnerDialogue>;
  supported: boolean;
  configured: boolean;
  onBack: () => void;
  onSettings: () => void;
  onReference: (reference: PartnerDialogueReference) => void;
}) {
  const { session, setDraft, submit } = dialogue;
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const formAvailable = supported && configured;
  const canSend = formAvailable && !session.pending && Boolean(session.draft.trim());
  useEffect(() => {
    if (formAvailable && !session.pending) field.current?.focus();
  }, [formAvailable, session.pending]);

  return (
    <section className="partner-dialogue">
      <div className="dialogue-context">
        <button type="button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> 返回伙伴与任务
        </button>
        <p title={commission}>{commission}</p>
      </div>
      {session.turns.length === 0 && !session.pending && formAvailable && (
        <p className="dialogue-hint">可以询问这份委托的进度、分工或复核结果。</p>
      )}
      {session.turns.length > 0 && (
        <ol className="dialogue-transcript" aria-label="对话记录" aria-live="polite">
          {session.turns.map(({ question, answer, references }, index) => (
            <li key={index}>
              <p className="dialogue-question">
                <strong>你</strong>
                <span>{question}</span>
              </p>
              <div className="dialogue-answer">
                <p>
                  <strong>{name}</strong>
                  <span>{answer}</span>
                </p>
                {references.length > 0 && (
                  <ul className="dialogue-references" aria-label="引用资料">
                    {references.map((reference) => (
                      <li key={`${reference.kind}:${reference.id}`}>
                        <button type="button" onClick={() => onReference(reference)}>
                          {reference.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {session.pending && (
        <>
          <p className="dialogue-question">
            <strong>你</strong>
            <span>{session.draft.trim()}</span>
          </p>
          <p className="dialogue-hint" role="status">
            正在等待{name}回答…
          </p>
        </>
      )}
      {session.error && (
        <p className="error-text" role="alert">
          {session.error}
        </p>
      )}
      {!supported ? (
        <p className="dialogue-hint">当前工作室版本暂时无法发起伙伴对话。</p>
      ) : !configured ? (
        <div className="dialogue-unconfigured">
          <p className="dialogue-hint">配置模型后即可向伙伴提问。</p>
          <button type="button" onClick={onSettings}>
            配置模型
          </button>
        </div>
      ) : null}
      <form
        className="dialogue-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void submit();
        }}
      >
        <label htmlFor={fieldId}>向{name}提问</label>
        <textarea
          id={fieldId}
          ref={field}
          value={session.draft}
          disabled={!formAvailable || session.pending}
          rows={3}
          maxLength={PARTNER_DIALOGUE_LIMITS.question}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="dialogue-composer-actions">
          {formAvailable && <span className="quiet">Ctrl / ⌘ + Enter</span>}
          <button className="primary" type="submit" disabled={!canSend}>
            <Send size={14} aria-hidden="true" /> 发送问题
          </button>
        </div>
      </form>
    </section>
  );
}
