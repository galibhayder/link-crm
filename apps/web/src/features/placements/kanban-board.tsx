import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  ExternalLink,
  GripVertical,
  Loader2,
  Lock,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  canMove,
  PLACEMENT_STAGES,
  type BoardPlacement,
  type BoardStage,
} from "./use-placements";

/**
 * KANBAN BOARD.
 *
 * Drag and drop uses the native HTML5 drag events rather than a library. Two
 * reasons: it adds no dependency to a workspace that is already large, and it
 * degrades to a keyboard/menu path (the "Move to" control) without extra work.
 *
 * ACCESSIBILITY: HTML5 drag is mouse-only. Every card therefore also has a
 * keyboard-reachable move control, and the drop target is a labelled region.
 * A board that only works with a mouse would exclude keyboard users entirely.
 */

const STAGE_TONE: Record<string, string> = {
  prospected: "border-t-slate-400",
  pitched: "border-t-violet-500",
  client_approved: "border-t-emerald-500",
  content_writing: "border-t-amber-500",
  submitted: "border-t-sky-500",
  live: "border-t-emerald-600",
};

function money(value: number | null) {
  if (value === null || value === undefined) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

function daysUntil(date: string | null) {
  if (!date) return null;
  const diff = Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
  return diff;
}

interface BoardCardProps {
  placement: BoardPlacement;
  onOpen: (p: BoardPlacement) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMoveRequest: (p: BoardPlacement) => void;
  dragging: boolean;
  canWrite: boolean;
}

function BoardCard({ placement, onOpen, onDragStart, onDragEnd, onMoveRequest, dragging, canWrite }: BoardCardProps) {
  const cost = money(placement.agreed_cost ?? null);
  const due = daysUntil(placement.content_due_date);
  const overdue = due !== null && due < 0 && placement.pipeline_stage !== "live";
  const soon = due !== null && due >= 0 && due <= 2 && placement.pipeline_stage !== "live";

  return (
    <article
      draggable={canWrite}
      onDragStart={(e) => {
        if (!canWrite) return;
        e.dataTransfer.setData("text/plain", placement.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(placement.id);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group rounded-lg border border-line bg-surface p-3 shadow-xs transition",
        canWrite && "cursor-grab active:cursor-grabbing",
        "hover:border-line-strong hover:shadow-sm",
        dragging && "opacity-40",
      )}
      data-placement-id={placement.id}
    >
      <div className="flex items-start gap-2">
        {canWrite && (
          <GripVertical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
        )}
        <button
          type="button"
          onClick={() => onOpen(placement)}
          className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <p className="truncate text-[13px] font-medium leading-5 text-foreground" title={placement.target_url}>
            {shortUrl(placement.target_url)}
          </p>
          {placement.anchor_text && (
            <p className="mt-0.5 truncate text-[12px] text-muted" title={placement.anchor_text}>
              “{placement.anchor_text}”
            </p>
          )}
        </button>
        {canWrite && (
          <button
            type="button"
            onClick={() => onMoveRequest(placement)}
            aria-label={`Move ${shortUrl(placement.target_url)} to another stage`}
            className="rounded p-1 text-muted opacity-60 transition hover:bg-surface-sunken hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {placement.live_url && (
          <Badge tone="success" dot>
            live link
          </Badge>
        )}
        {cost && <Badge tone="neutral">{cost}</Badge>}
        {placement.client_approved_at && !placement.anchor_text && <Badge tone="outline">approved</Badge>}
        {overdue && (
          <Badge tone="danger" dot>
            overdue {Math.abs(due)}d
          </Badge>
        )}
        {soon && (
          <Badge tone="warning" dot>
            due {due === 0 ? "today" : `in ${due}d`}
          </Badge>
        )}
      </div>

      {placement.content_due_date && !overdue && !soon && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          <CalendarClock className="size-3" aria-hidden />
          due {new Date(placement.content_due_date).toLocaleDateString()}
        </p>
      )}

      {placement.assigned_to && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          <UserRound className="size-3" aria-hidden />
          assigned
        </p>
      )}
    </article>
  );
}

export interface KanbanBoardProps {
  stages: BoardStage[];
  loading: boolean;
  canWrite: boolean;
  onOpen: (p: BoardPlacement) => void;
  onMove: (placement: BoardPlacement, toStage: string) => Promise<void>;
  onMoveRequest: (p: BoardPlacement) => void;
}

export function KanbanBoard({ stages, loading, canWrite, onOpen, onMove, onMoveRequest }: KanbanBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [illegalStage, setIllegalStage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dragDepth = useRef(0);

  const dragged = useMemo(() => {
    if (!draggingId) return null;
    for (const s of stages) {
      const found = s.placements.find((p) => p.id === draggingId);
      if (found) return found;
    }
    return null;
  }, [draggingId, stages]);

  const handleDrop = useCallback(
    async (targetStage: string, dataTransfer: DataTransfer) => {
      setOverStage(null);
      setIllegalStage(null);

      // Read the id from the drag payload rather than from `draggingId` state.
      //
      // The state set in onDragStart has not necessarily been committed when the
      // drop fires — React batches it, and a drop dispatched in the same tick (as
      // a fast drag or a synthetic event does) sees the previous value. Reading
      // dataTransfer is the source of truth the browser actually carries.
      const droppedId = dataTransfer.getData("text/plain") || draggingId;
      if (!droppedId) return;

      const placement = stages.flatMap((s) => s.placements).find((p) => p.id === droppedId);
      if (!placement) {
        setDraggingId(null);
        return;
      }

      if (placement.pipeline_stage === targetStage) {
        setDraggingId(null);
        return;
      }
      if (!canMove(placement.pipeline_stage, targetStage)) {
        setDraggingId(null);
        return;
      }
      if (busyId) return;

      setBusyId(placement.id);
      try {
        await onMove(placement, targetStage);
      } finally {
        setBusyId(null);
        setDraggingId(null);
      }
    },
    [stages, draggingId, busyId, onMove],
  );

  return (
    <div
      className="flex items-start gap-2.5 overflow-x-auto pb-3"
      role="list"
      aria-label="Placement pipeline board"
    >
      {stages.map((stage) => {
        const isOver = overStage === stage.key;
        const isIllegal = illegalStage === stage.key;
        const droppable = dragged ? canMove(dragged.pipeline_stage, stage.key) : false;

        return (
          <section
            key={stage.key}
            role="listitem"
            aria-label={`${stage.label}, ${stage.placements.length} placements`}
            className={cn(
              // Mobile: a fixed width so the board scrolls predictably.
              // Desktop: columns share the available width so all six are visible
              // without scrolling — the whole point of a board is seeing the shape
              // of the pipeline at once.
              "flex w-[264px] shrink-0 flex-col rounded-xl border border-t-[3px] border-line bg-surface-sunken/60",
              "sm:w-0 sm:min-w-[148px] sm:flex-1",
              STAGE_TONE[stage.key] ?? "border-t-line",
              isOver && droppable && "border-brand-400 bg-brand-50/60 dark:bg-brand-900/20",
              isIllegal && "border-[var(--color-danger)]/60 bg-[var(--color-danger-soft)]/30",
            )}
            onDragEnter={(e) => {
              if (!canWrite) return;
              e.preventDefault();
              dragDepth.current += 1;
              if (dragged) {
                setOverStage(stage.key);
                setIllegalStage(dragged.pipeline_stage !== stage.key && !droppable ? stage.key : null);
              }
            }}
            onDragOver={(e) => {
              if (!canWrite) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = droppable ? "move" : "none";
            }}
            onDragLeave={() => {
              dragDepth.current -= 1;
              if (dragDepth.current <= 0) {
                dragDepth.current = 0;
                setOverStage(null);
                setIllegalStage(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepth.current = 0;
              void handleDrop(stage.key, e.dataTransfer);
            }}
          >
            <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[12.5px] font-semibold tracking-wide text-foreground-soft">
                  {stage.label}
                </h2>
                <span
                  className="rounded-full bg-surface px-1.5 text-[11px] font-medium tabular-nums text-muted"
                  aria-hidden
                >
                  {stage.placements.length}
                </span>
              </div>
              {stage.key === "live" && <Lock className="size-3 text-muted" aria-label="Final stage" />}
            </header>

            <div className="flex min-h-[96px] flex-1 flex-col gap-2 px-2 pb-2">
              {loading && stage.placements.length === 0 && (
                <div className="space-y-2" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg border border-line bg-surface/70" />
                  ))}
                </div>
              )}

              {!loading && stage.placements.length === 0 && (
                <p className="rounded-lg border border-dashed border-line px-2 py-6 text-center text-[11.5px] leading-relaxed text-muted">
                  {dragged && droppable
                    ? `Drop here to move to ${stage.label}`
                    : dragged && !droppable
                      ? `Cannot move here from ${dragged.pipeline_stage.replace(/_/g, " ")}`
                      : "Nothing in this stage"}
                </p>
              )}

              {stage.placements.map((p) => (
                <div key={p.id} className="relative">
                  <BoardCard
                    placement={p}
                    onOpen={onOpen}
                    onDragStart={setDraggingId}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setOverStage(null);
                      setIllegalStage(null);
                      dragDepth.current = 0;
                    }}
                    onMoveRequest={onMoveRequest}
                    dragging={draggingId === p.id}
                    canWrite={canWrite}
                  />
                  {busyId === p.id && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-surface/80">
                      <Loader2 className="size-4 animate-spin text-brand-600" aria-label="Moving" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Rendered when a placement's stage is not one of the six configured columns. */
export function OrphanNotice({ orphans }: { orphans: BoardPlacement[] }) {
  if (orphans.length === 0) return null;
  return (
    <div
      role="status"
      className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warning)]"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        {orphans.length} placement{orphans.length === 1 ? "" : "s"} sit in a stage that is not part of this
        pipeline and are not shown on the board. Check Settings → Pipeline stages.
      </p>
    </div>
  );
}

export { PLACEMENT_STAGES, money, shortUrl };
