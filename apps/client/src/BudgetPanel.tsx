import { useState } from 'react';
import type { Budget, Commission } from '@astrisle/contracts';

export function BudgetPanel({
  commission,
  reworks,
  busy,
  onSave,
}: {
  commission: Commission;
  reworks: number;
  busy: boolean;
  onSave: (budget: Budget, revision: number) => Promise<unknown>;
}) {
  const [edit, setEdit] = useState<{ budget: Budget; revision: number }>();
  const minutes = (commission.activeMilliseconds ?? 0) / 60000;
  const exhausted =
    commission.stepsUsed >= commission.budget.maxSteps || minutes >= commission.budget.maxMinutes;
  const editable = commission.status === 'paused';
  return (
    <section aria-label="委托预算">
      <h4>工作预算</h4>
      <dl className="facts">
        <dt>模型调用</dt>
        <dd>
          {commission.stepsUsed} / {commission.budget.maxSteps} 步
        </dd>
        <dt>运行时间</dt>
        <dd>
          {minutes.toFixed(1)} / {commission.budget.maxMinutes} 分钟
        </dd>
        <dt>自动返工</dt>
        <dd>
          {reworks} / {commission.budget.maxRework} 轮
        </dd>
      </dl>
      <p className="field-hint">
        步数包含规划和执行请求。时间显示截至最近更新，暂停期间不计时；额度用尽后停止发起新请求。
      </p>
      {exhausted && (
        <p role="status" className="error-text">
          预算已用尽。提高总额度后可继续当前委托。
        </p>
      )}
      {edit && editable ? (
        <form
          className="revision-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const saved = await onSave(
              {
                maxSteps: Number(data.get('steps')),
                maxMinutes: Number(data.get('minutes')),
                maxRework: Number(data.get('rework')),
              },
              edit.revision,
            );
            if (saved) setEdit(undefined);
          }}
        >
          <p className="quiet">填写这份委托的总额度，已使用量会保留。保存后仍保持暂停。</p>
          <label htmlFor="budget-steps">总步数上限</label>
          <input
            id="budget-steps"
            name="steps"
            type="number"
            min={Math.max(1, commission.stepsUsed)}
            max={10000}
            step={1}
            required
            defaultValue={edit.budget.maxSteps}
          />
          <label htmlFor="budget-minutes">总运行分钟</label>
          <input
            id="budget-minutes"
            name="minutes"
            type="number"
            min={Math.max(1, Math.ceil(minutes))}
            max={1440}
            step={1}
            required
            defaultValue={edit.budget.maxMinutes}
          />
          <label htmlFor="budget-rework">自动返工上限</label>
          <input
            id="budget-rework"
            name="rework"
            type="number"
            min={reworks}
            max={20}
            step={1}
            required
            defaultValue={edit.budget.maxRework}
          />
          {(commission.budgetRevision ?? 0) !== edit.revision && (
            <p role="status" className="error-text">
              预算已在其他操作中更新，请收起后重新编辑。
            </p>
          )}
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || (commission.budgetRevision ?? 0) !== edit.revision}
            >
              保存预算
            </button>
            <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>
              收起编辑
            </button>
          </div>
        </form>
      ) : (
        <>
          <button
            disabled={busy || !editable}
            onClick={() =>
              setEdit({
                budget: { ...commission.budget },
                revision: commission.budgetRevision ?? 0,
              })
            }
          >
            调整预算
          </button>
          {commission.status === 'active' && (
            <p className="field-hint">先暂停委托，即可调整额度。</p>
          )}
        </>
      )}
    </section>
  );
}
