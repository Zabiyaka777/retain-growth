import type { LeadIndicatorEntry } from '../hooks/useLeadIndicators'
import HoverTooltip from './HoverTooltip'
import { IconBan, IconChecklist, IconNote } from './icons'

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Capped so a genuinely long note doesn't turn the hover preview into a wall
// of text — this is a peek, not the note editor (that's LeadProfile's job).
const NOTES_PREVIEW_LIMIT = 240

function TaskTooltipContent({ tasks }: { tasks: LeadIndicatorEntry['tasks'] }) {
  const now = Date.now()
  return (
    <div className="hover-tooltip-tasks">
      <div className="hover-tooltip-label">
        <IconChecklist size={11} />
        Активні задачі
      </div>
      {tasks.map((task) => {
        const overdue = task.deadline !== null && new Date(task.deadline).getTime() < now
        return (
          <div className="hover-tooltip-task-row" key={task.id}>
            <span className="hover-tooltip-task-title">{task.title}</span>
            {task.deadline && (
              <span className={`hover-tooltip-task-deadline${overdue ? ' hover-tooltip-task-overdue' : ''}`}>
                {formatDeadline(task.deadline)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function NotesTooltipContent({ notes }: { notes: string }) {
  const truncated = notes.length > NOTES_PREVIEW_LIMIT ? `${notes.slice(0, NOTES_PREVIEW_LIMIT)}…` : notes
  return (
    <div className="hover-tooltip-notes-wrap">
      <div className="hover-tooltip-label">
        <IconNote size={11} />
        Нотатка менеджера
      </div>
      <p className="hover-tooltip-notes">{truncated}</p>
    </div>
  )
}

interface LeadIndicatorIconsProps {
  entry: LeadIndicatorEntry | undefined
}

export default function LeadIndicatorIcons({ entry }: LeadIndicatorIconsProps) {
  if (!entry || (entry.tasks.length === 0 && !entry.notes && !entry.blockedBot)) return null

  return (
    <span className="lead-indicators">
      {entry.blockedBot && (
        <span className="lead-indicator-icon lead-indicator-blocked-bot" aria-label="Заблокував бота" title="Заблокував бота">
          <IconBan size={12} />
        </span>
      )}
      {entry.tasks.length > 0 && (
        <HoverTooltip content={<TaskTooltipContent tasks={entry.tasks} />}>
          <span
            className={`lead-indicator-icon lead-indicator-task${entry.hasOverdueTask ? ' lead-indicator-overdue' : ''}`}
            aria-label={entry.hasOverdueTask ? 'Є прострочена задача' : 'Є активні задачі'}
          >
            <IconChecklist size={12} />
          </span>
        </HoverTooltip>
      )}
      {entry.notes && (
        <HoverTooltip content={<NotesTooltipContent notes={entry.notes} />}>
          <span className="lead-indicator-icon lead-indicator-notes" aria-label="Є нотатка менеджера">
            <IconNote size={12} />
          </span>
        </HoverTooltip>
      )}
    </span>
  )
}
