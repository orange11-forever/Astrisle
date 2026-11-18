import { useState } from 'react';
import type { ProjectSnapshot } from '@astrisle/contracts';

const eventLabels: Record<string, string> = {
  commission_created: '已创建委托',
  plan_created: '任务计划已就绪',
  plan_rejected: '计划需要修正',
  provider_required: '等待配置模型',
  model_step: '已发起模型调用',
  task_started: '伙伴开始工作',
  task_waiting: '任务正在等待',
  task_stopped: '任务已停止',
  task_failed: '任务执行失败',
  task_inputs: '已锁定输入版本',
  task_completed: '伙伴已提交任务结果',
  tool_started: '开始调用工具',
  tool_finished: '已收到工具回执',
  tool_outcome_unknown: '工具结果待核查',
  input_requested: '需要你的回复',
  request_answered: '已收到回复',
  artifact_available: '已发布成果版本',
  review_submitted: '已提交复核意见',
  rework_created: '已创建返工任务',
  delivery_ready: '成果等待验收',
  artifacts_accepted: '已接受所选成果',
  requirements_revised: '已修订委托目标',
  commission_pause: '已请求暂停',
  commission_resume: '已请求继续',
  commission_cancel: '已请求取消',
  commission_cancelled: '委托已取消',
  budget_paused: '已达到运行预算',
  budget_updated: '已调整运行预算',
  recovery: '重启后已暂停',
  runtime_error: '运行发生错误',
  runtime_closing: '运行时正在关闭',
  writeback_result: '写回或恢复已返回结果',
  writeback_inspected: '已核查写回记录',
};

const timestamp = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function CommissionActivity({
  snapshot,
  characterName,
  onTask,
}: {
  snapshot: ProjectSnapshot;
  characterName: (id: string) => string;
  onTask: (id: string) => void;
}) {
  const [limit, setLimit] = useState(4);
  const events = snapshot.events.slice(-limit).reverse();
  return (
    <section aria-label="委托动态" className="commission-activity">
      <h4>委托动态</h4>
      {events.length === 0 && <p className="quiet">还没有运行记录。</p>}
      <ol>
        {events.map((event) => {
          const task = event.taskId && snapshot.tasks.find((item) => item.id === event.taskId);
          const date = Date.parse(event.createdAt);
          return (
            <li key={event.id}>
              <details>
                <summary>
                  <strong>{eventLabels[event.type] ?? event.type}</strong>
                  <span>
                    {event.agentId && <>{characterName(event.agentId)} · </>}
                    {Number.isFinite(date) && (
                      <time dateTime={event.createdAt}>{timestamp.format(date)}</time>
                    )}
                  </span>
                </summary>
                <p>{event.message}</p>
                {task && (
                  <button type="button" onClick={() => onTask(task.id)}>
                    查看任务 · {task.title}
                  </button>
                )}
              </details>
            </li>
          );
        })}
      </ol>
      {events.length < snapshot.events.length && (
        <button type="button" onClick={() => setLimit((count) => count + 20)}>
          查看更早动态
        </button>
      )}
    </section>
  );
}
