import { useState } from "react";
import { ArrowRight, CalendarDays } from "lucide-react";
import type { AppState, Bot, Run } from "../shared/types";
import { Character } from "./Character";
import { BrowserAccessCard } from "./BrowserAccessCard";
import { ChoiceMenu } from "./ChoiceMenu";
import { LiveComputer } from "./LiveComputer";
import { contextRunState, contextRunTitle, orderContextRuns } from "./context-runs";
import { friendlyModelName } from "../shared/provider-config";

function ContextWork({ run, onRun }: { run: Run; onRun: (run: Run) => void }) {
  const title = contextRunTitle(run), { state, label } = contextRunState(run);
  return (
    <button className="context-work" title={title} aria-label={`Work: ${title}`} onClick={() => onRun(run)}>
      <strong>{title}</strong>
      <small className={`context-state ${state}`}><i aria-hidden="true" />{label}</small>
      <ArrowRight size={13} />
    </button>
  );
}

export function ConversationContext({
  state,
  bot,
  threadId,
  onRun,
  onSchedule,
  onTakeover,
  onEditGroup,
  yoloMode,
  safetyBusy,
  onToggleSafety,
}: {
  state: AppState;
  bot?: Bot;
  threadId: string;
  onRun: (run: Run) => void;
  onSchedule: () => void;
  onTakeover?: (bot: Bot) => void;
  onEditGroup?: () => void;
  yoloMode?: boolean;
  safetyBusy?: boolean;
  onToggleSafety?: () => void;
}) {
  const [chosen, setChosen] = useState(bot?.id || "");
  const selected = bot || state.bots.find((item) => item.id === chosen);
  const group = !selected ? state.threads.find((thread) => thread.id === threadId && thread.botIds?.length) : undefined;
  const runs = orderContextRuns(Array.from(new Map(
    [...state.studioRuns, ...state.runs]
      .filter((run) => !run.parentRunId && (selected ? run.botId === selected.id : run.threadId === threadId))
      .map((run) => [run.id, run] as const),
  ).values()));
  const activeRuns = runs.filter((run) => ["queued", "running", "awaiting_approval", "waiting_for_teammate"].includes(run.status));
  const currentRuns = activeRuns.length ? activeRuns : runs.slice(0, 1);
  const olderRuns = runs.filter((run) => !currentRuns.some((current) => current.id === run.id));
  const routines = state.routines.filter((routine) =>
    selected ? routine.botId === selected.id : routine.threadId === threadId,
  );
  return (
    <div className="conversation-context-content">
      {onToggleSafety && (
        <section className="safety-row" aria-label="Safety">
          <span className="safety-copy">
            <strong>Autopilot</strong>
            <small>
              {yoloMode
                ? "On. Sends, posts and purchases go ahead without asking. Sign-ins, access and extra AI spending still pause."
                : "Off. Work starts right away; sensitive actions wait for your approval."}
            </small>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={yoloMode === true}
            aria-label="Autopilot"
            className="switch"
            disabled={safetyBusy}
            onClick={onToggleSafety}
          ><i /></button>
        </section>
      )}
      {!bot && (
        <div className="context-picker"><span>Whose work?</span><ChoiceMenu label="Whose work?" value={chosen} onChange={setChosen}
          choices={[{value:"",label:"The whole conversation"},...state.bots.map((item) => ({value:item.id,label:item.name,detail:item.role,icon:<Character name={item.name} color={item.color} variant={item.mascot} size={26} />}))]}/></div>
      )}
      {group && onEditGroup && (
        <div className="context-group">
          <span>{group.botIds?.map((id) => state.bots.find((bot) => bot.id === id)?.name).filter(Boolean).join(" · ")}</span>
          <button className="text-action" onClick={onEditGroup}>
            Manage participants <ArrowRight size={13} />
          </button>
        </div>
      )}
      {selected && (
        <>
          <div className="context-person">
            <Character
              name={selected.name}
              variant={selected.mascot}
              color={selected.color}
              status={selected.status}
              size={45}
            />
            <div>
              <strong>{selected.name}</strong>
              <p>{selected.role}{selected.model ? ` · ${selected.aiMode === "automatic" ? "Auto · " : ""}${friendlyModelName(selected.model)}` : ""}</p>
            </div>
          </div>
          <LiveComputer bot={selected} threadId={selected.threadId} onTakeover={onTakeover} />
          <BrowserAccessCard bot={selected} onTakeover={onTakeover} />
        </>
      )}
      <section>
        <div className="section-heading">
          <h3>Work</h3>
        </div>
        {currentRuns.length ? (
          <>
          {currentRuns.map((run) => <ContextWork key={run.id} run={run} onRun={onRun} />)}
          {olderRuns.length > 0 && (
            <details className="context-work-history">
              <summary>Earlier work ({olderRuns.length})</summary>
              {olderRuns.map((run) => <ContextWork key={run.id} run={run} onRun={onRun} />)}
            </details>
          )}
          </>
        ) : (
          <p className="quiet-copy">Tasks and results will collect here.</p>
        )}
      </section>
      <section>
        <div className="section-heading">
          <h3>
            <CalendarDays size={15} /> Routines
          </h3>
          <button onClick={onSchedule}>
            Schedule <ArrowRight size={13} />
          </button>
        </div>
        {routines.length ? (
          routines.map((routine) => (
            <button
              key={routine.id}
              className="context-work"
              onClick={onSchedule}
            >
              <strong>{routine.name}</strong>
              <small>
                {!routine.enabled
                  ? "Paused"
                  : routine.nextRunAt
                    ? `Next: ${new Date(routine.nextRunAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
                    : "Waiting for its trigger"}
              </small>
            </button>
          ))
        ) : (
          <p className="quiet-copy">No routines for this conversation yet.</p>
        )}
      </section>
    </div>
  );
}
