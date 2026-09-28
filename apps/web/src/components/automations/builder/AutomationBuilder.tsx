import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Info, Loader2, Save, TriangleAlert } from 'lucide-react';
import type { Automation } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSettings } from '@/hooks/queries/useSettings';
import { useCreateAutomation, useUpdateAutomation } from '@/hooks/queries/useAutomations';
import { useDestinations } from '@/hooks/queries/useDestinations';
import { useAutomationFilterOptions } from '@/hooks/queries/useHistory';
import { useServer } from '@/hooks/useServer';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import {
  canEnforceAcrossServers,
  describeAutomation,
  scopeToPayload,
  visibleDestinations,
  type AutomationDraft,
  type DescribeRefs,
} from '@/lib/automations';
import {
  branchOf,
  builderReducer,
  builderStateFrom,
  emptyBuilderState,
  nodeDomId,
  toCreateInput,
  type BuilderAction,
} from './builderReducer';
import { ActionsSection } from './ActionsSection';
import { BuilderTitleBar } from './BuilderTitleBar';
import { ConditionsSection } from './ConditionsSection';
import { LiveCheckStrip } from './LiveCheckStrip';
import { Sentence } from './Sentence';
import { SummaryCard } from './SummaryCard';
import { TriggersSection } from './TriggersSection';
import type { BranchExpansion, BuilderRefs } from './builderRefs';
import {
  BUILDER_SECTIONS,
  builderIssues,
  issuesByNode,
  serverIssues,
  type BuilderIssue,
} from './validation';

interface AutomationBuilderProps {
  /** Absent while creating; the loaded row when editing. */
  automation?: Automation;
  /** Answers carried over from a ready-made automation the reader opened up. */
  draft?: AutomationDraft;
}

/** A draft lands dirty: the answers behind it are work the leave guard has to protect. */
function seedBuilderState(draft: AutomationDraft | undefined) {
  return draft ? { ...builderStateFrom(draft), dirty: true } : emptyBuilderState();
}

/** How long a node stays highlighted after the sentence or the error count jumps to it. */
const PULSE_MS = 1200;

/** Adding, dropping or skipping a node is what makes a section's own problems worth showing. */
const SECTION_ACTIONS = new Set<BuilderAction['type']>([
  'addTrigger',
  'addConditionGroup',
  'addCondition',
  'addAction',
  'moveAction',
  'toggleNode',
  'removeNode',
]);

/** What a change marks as touched, so an untouched field is never shown as wrong. */
function touchedKeys(action: BuilderAction, section: string): string[] {
  const keys = SECTION_ACTIONS.has(action.type) ? [section] : [];

  switch (action.type) {
    case 'setName':
      keys.push(BUILDER_SECTIONS.name);
      break;
    case 'setDescription':
      keys.push(BUILDER_SECTIONS.description);
      break;
    case 'setScope':
      keys.push(BUILDER_SECTIONS.scope);
      break;
    case 'setTriggerParam':
    case 'toggleNode':
    case 'removeNode':
    case 'setCondition':
    case 'setAction':
    case 'moveAction':
      keys.push(action.id);
      break;
    case 'addCondition':
    case 'setConditionMatch':
      keys.push(action.groupId);
      break;
    default:
      break;
  }
  return keys;
}

export function AutomationBuilder({ automation, draft }: AutomationBuilderProps) {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const { servers } = useServer();
  const { data: settings } = useSettings();
  const { data: filterOptions } = useAutomationFilterOptions();
  const { data: destinations } = useDestinations();
  const createAutomation = useCreateAutomation();
  const updateAutomation = useUpdateAutomation();

  const [state, dispatch] = useReducer(builderReducer, draft, seedBuilderState);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  // An `if` body opens by default; this holds the ones the reader folded away.
  const [closedIfs, setClosedIfs] = useState<ReadonlySet<string>>(() => new Set());
  const [focusTarget, setFocusTarget] = useState<{ id: string; seq: number } | null>(null);
  const focusSeq = useRef(0);
  const [rejected, setRejected] = useState<BuilderIssue[]>([]);
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const blocker = useUnsavedChanges(state.dirty);

  // Every write goes through one place, so a row turns red only once it has been touched.
  const trackFor = useCallback(
    (section: string) => (action: BuilderAction) => {
      const keys = touchedKeys(action, section);
      if (keys.length > 0) {
        setTouched((current) => {
          if (keys.every((key) => current.has(key))) return current;
          const next = new Set(current);
          for (const key of keys) next.add(key);
          return next;
        });
      }
      dispatch(action);
    },
    []
  );

  const track = useMemo(
    () => ({
      header: trackFor(BUILDER_SECTIONS.name),
      triggers: trackFor(BUILDER_SECTIONS.triggers),
      conditions: trackFor(BUILDER_SECTIONS.conditions),
      actions: trackFor(BUILDER_SECTIONS.actions),
    }),
    [trackFor]
  );

  // A refetch must not overwrite edits, so the row seeds the form once per automation.
  useEffect(() => {
    if (!automation || loadedIdRef.current === automation.id) return;
    loadedIdRef.current = automation.id;
    dispatch({ type: 'load', automation });
  }, [automation]);

  // What the API rejected describes the definition it was sent, so any edit retires it
  // and Save is free to go again.
  useEffect(() => setRejected((held) => (held.length === 0 ? held : [])), [state]);

  useEffect(() => {
    if (pulseId === null) return;
    const timer = window.setTimeout(() => setPulseId(null), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [pulseId]);

  // Once the save has landed the guard is clean, and only then may the page leave.
  useEffect(() => {
    if (leavingTo !== null && !state.dirty) void navigate(leavingTo);
  }, [leavingTo, state.dirty, navigate]);

  const describeRefs = useMemo<DescribeRefs>(() => {
    const accounts: Record<string, string> = {};
    if (automation?.scopeRef?.kind === 'account') {
      accounts[automation.scopeRef.id] = automation.scopeRef.name;
    }
    return {
      servers: Object.fromEntries(servers.map((server) => [server.id, server.name])),
      users: Object.fromEntries(
        (filterOptions?.users ?? []).map((user) => [user.id, user.identityName || user.username])
      ),
      countries: Object.fromEntries(
        (filterOptions?.countries ?? []).map((country) => [country.code, country.name])
      ),
      accounts,
      destinations: Object.fromEntries(
        visibleDestinations(destinations ?? []).map((destination) => [
          destination.id,
          destination.name,
        ])
      ),
    };
  }, [servers, filterOptions, destinations, automation]);

  const refs = useMemo<BuilderRefs>(
    () => ({
      triggers: state.triggers,
      kind: state.kind,
      conditions: state.conditions,
      filterOptions,
      describe: describeRefs,
      unitSystem: settings?.unitSystem ?? 'metric',
    }),
    [state.triggers, state.kind, state.conditions, filterOptions, describeRefs, settings]
  );

  const fragments = useMemo(
    () =>
      describeAutomation(
        {
          kind: state.kind,
          triggers: state.triggers,
          conditions: state.conditions,
          actions: state.actions,
          ...scopeToPayload(state.scope),
        },
        describeRefs,
        t,
        settings?.unitSystem ?? 'metric',
        { placeholders: true }
      ),
    [state, describeRefs, t, settings]
  );

  const input = useMemo(() => toCreateInput(state), [state]);
  const localIssues = useMemo(() => builderIssues(state, t), [state, t]);
  const issues = useMemo(() => [...localIssues, ...rejected], [localIssues, rejected]);
  // The footer counts everything from the first paint; a row only turns red once its
  // own field has been touched, or once Save has asked for the whole form.
  // A warning is about what the rest of the definition did, so it never waits to be touched.
  const byNode = useMemo(
    () =>
      issuesByNode(
        submitted
          ? issues
          : issues.filter((issue) => issue.tone === 'warning' || touched.has(issue.nodeId))
      ),
    [issues, submitted, touched]
  );

  const expansion = useMemo<BranchExpansion>(
    () => ({
      isOpen: (ifId) => !closedIfs.has(ifId),
      toggle: (ifId) =>
        setClosedIfs((current) => {
          const next = new Set(current);
          if (!next.delete(ifId)) next.add(ifId);
          return next;
        }),
    }),
    [closedIfs]
  );

  // Radix unmounts a closed branch, so whatever holds the node is opened first and the
  // focus waits for that render.
  const focusNode = (nodeId: string) => {
    setPulseId(nodeId);
    const owner = branchOf(state.actions, nodeId);
    if (owner !== null) {
      setClosedIfs((current) => {
        if (!current.has(owner)) return current;
        const next = new Set(current);
        next.delete(owner);
        return next;
      });
    }
    focusSeq.current += 1;
    setFocusTarget({ id: nodeId, seq: focusSeq.current });
  };

  useEffect(() => {
    if (focusTarget === null) return;
    const node = document.getElementById(nodeDomId(focusTarget.id));
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node?.focus();
  }, [focusTarget]);

  const revealFirstIssue = () => {
    setSubmitted(true);
    const first = issues[0];
    if (first) focusNode(first.nodeId);
  };

  // `/` reaches the picker of whatever section the caret sits in, or the first one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      const pickers = [
        ...(pageRef.current?.querySelectorAll<HTMLElement>('[data-node-picker]') ?? []),
      ];
      const nearest =
        pickers.find((picker) => active !== null && picker.closest('section')?.contains(active)) ??
        pickers[0];
      if (!nearest) return;
      event.preventDefault();

      // Clicking an open picker's trigger would shut it, so an open one just takes the caret.
      if (nearest.getAttribute('aria-expanded') === 'true') {
        const contentId = nearest.getAttribute('aria-controls');
        const content = contentId === null ? null : document.getElementById(contentId);
        content?.querySelector('input')?.focus();
        return;
      }
      nearest.click();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const isPending = createAutomation.isPending || updateAutomation.isPending;
  const hasIssues = issues.length > 0;

  const handleSave = async () => {
    if (isPending) return;
    // A form the page itself can fault never reaches the API; Save shows what it found.
    if (localIssues.length > 0) {
      revealFirstIssue();
      return;
    }

    try {
      const saved = automation
        ? await updateAutomation.mutateAsync({ id: automation.id, data: input })
        : await createAutomation.mutateAsync(input);
      dispatch({ type: 'saved' });
      setLeavingTo(`/automations/${saved.id}`);
    } catch (error) {
      // The mutation hook has already toasted; what the API named goes back to its row.
      setSubmitted(true);
      setRejected(serverIssues(state, error, t));
    }
  };

  const saveButton = (
    <Button type="button" disabled={isPending} onClick={() => void handleSave()}>
      {isPending ? <Loader2 className="animate-spin" /> : <Save />}
      {isPending
        ? t('pages:automations.builder.saving')
        : automation
          ? t('pages:automations.updateAutomation')
          : t('pages:automations.createAutomation')}
    </Button>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div ref={pageRef} className="@container mx-auto w-full max-w-4xl">
        <BuilderTitleBar
          title={
            automation
              ? t('pages:automations.editAutomation')
              : t('pages:automations.newAutomation')
          }
          active={state.isActive}
          onActiveChange={(value) => track.header({ type: 'setActive', value })}
          onBack={() => void navigate('/automations')}
        />

        <SummaryCard
          name={state.name}
          description={state.description}
          issues={byNode}
          sentence={<Sentence fragments={fragments} onFocusNode={focusNode} />}
          liveCheck={
            <LiveCheckStrip
              definition={input}
              ready={localIssues.length === 0}
              paused={isPending}
            />
          }
          dispatch={track.header}
        />

        <ol className="mt-8">
          <TriggersSection
            triggers={state.triggers}
            scope={state.scope}
            enforceAcrossServers={state.enforceAcrossServers}
            canEnforceAcrossServers={canEnforceAcrossServers(state.scope, state.conditions)}
            issues={byNode}
            pulseId={pulseId}
            dispatch={track.triggers}
          />

          <ConditionsSection
            conditions={state.conditions}
            refs={refs}
            issues={byNode}
            pulseId={pulseId}
            dispatch={track.conditions}
          />

          <ActionsSection
            actions={state.actions}
            kind={state.kind}
            severity={state.severity}
            refs={refs}
            issues={byNode}
            pulseId={pulseId}
            expansion={expansion}
            dispatch={track.actions}
          />
        </ol>

        <div className="bg-background/95 sticky bottom-0 z-10 mt-7 flex flex-wrap items-center gap-3 border-t py-3 backdrop-blur">
          <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:flex">
            <Kbd>/</Kbd>
            {t('pages:automations.builder.footer.search')}
          </span>

          {/* Nothing is red until Save has asked for the whole form. */}
          {!hasIssues && (
            <span className="text-success flex items-center gap-1.5 text-sm">
              <Check className="size-4" />
              {t('pages:automations.builder.footer.ready')}
            </span>
          )}
          {hasIssues &&
            (submitted ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={revealFirstIssue}
              >
                <TriangleAlert />
                {t('pages:automations.builder.footer.problems', { count: issues.length })}
              </Button>
            ) : (
              <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Info className="size-4" />
                {t('pages:automations.builder.footer.remaining', { count: issues.length })}
              </span>
            ))}

          <div className="ml-auto flex items-center gap-3">
            <Button type="button" variant="outline" onClick={() => void navigate('/automations')}>
              {t('common:actions.cancel')}
            </Button>
            {hasIssues ? (
              <Tooltip>
                <TooltipTrigger asChild>{saveButton}</TooltipTrigger>
                <TooltipContent>{issues[0]?.message}</TooltipContent>
              </Tooltip>
            ) : (
              saveButton
            )}
          </div>
        </div>

        <ConfirmDialog
          open={blocker.state === 'blocked'}
          onOpenChange={(open) => {
            if (!open) blocker.reset?.();
          }}
          title={t('pages:automations.builder.leave.title')}
          description={t('common:confirmations.unsavedChanges')}
          confirmLabel={t('pages:automations.builder.leave.confirm')}
          cancelLabel={t('common:actions.cancel')}
          onConfirm={() => blocker.proceed?.()}
        />
      </div>
    </TooltipProvider>
  );
}
