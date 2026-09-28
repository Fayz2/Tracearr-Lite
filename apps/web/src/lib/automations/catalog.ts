/**
 * What the node picker offers: the name a trigger or action goes by, the one line
 * that says what it does, and the words a search should find it under.
 */

import {
  ACTIONS,
  LEAF_ACTION_TYPES,
  TRIGGERS,
  TRIGGER_TYPES,
  type ActionType,
  type Destination,
  type TriggerType,
} from '@tracearr/shared';
import { actionDescription, actionLabel } from './actionDefinitions';
import { capitalize, TRIGGER_KEYS } from './describe';
import type { Translate } from './conditionFields';

/** One row of a picker: what it adds, what it is called, and what finds it. */
export interface NodePickerEntry {
  value: string;
  label: string;
  description: string;
  group: string;
  synonyms: string[];
}

type NodeGroup = (typeof TRIGGERS)[TriggerType]['group'] | (typeof ACTIONS)[ActionType]['group'];

function nodeGroupLabel(t: Translate, group: NodeGroup): string {
  return t(`automations.catalog.groups.${group}`);
}

/** Synonyms are one translated string so a translator can drop or add words per language. */
function splitSynonyms(value: string): string[] {
  return value
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/** A trigger a stored run names that this build still knows about. */
export const isKnownTrigger = (type: string): type is TriggerType => type in TRIGGERS;

/**
 * Triggers still recognized (existing automations keep working, `isKnownTrigger`
 * still passes) but no longer offered as a choice when starting a new one.
 */
const HIDDEN_FROM_PICKER: ReadonlySet<TriggerType> = new Set([
  'media.added',
  'media.upgraded',
  'newsletter.sent',
  'newsletter.failed',
  'tracearr.update_available',
]);

/**
 * Destination types suppressed everywhere in automations — the destination picker,
 * the "In plain words" sentence, and the summary card. A rule that already sends to
 * one of these keeps the id, but nothing resolves its name, so it renders nowhere.
 */
export const HIDDEN_DESTINATION_TYPES: ReadonlySet<Destination['type']> = new Set(['push']);

/** The destinations still eligible to be picked or named anywhere in automations. */
export function visibleDestinations(destinations: readonly Destination[]): Destination[] {
  return destinations.filter((destination) => !HIDDEN_DESTINATION_TYPES.has(destination.type));
}

/**
 * Most triggers read in a picker exactly as they read in the sentence, so the label
 * is that clause capitalised. The two that carry a threshold name themselves.
 */
export function triggerLabel(t: Translate, type: TriggerType): string {
  if (type === 'session.held_for' || type === 'account.inactive_for') {
    return t(`automations.catalog.triggers.${TRIGGER_KEYS[type]}.label`);
  }
  return capitalize(t(`automations.describe.triggers.${TRIGGER_KEYS[type]}`));
}

export function triggerPickerEntries(t: Translate): NodePickerEntry[] {
  return TRIGGER_TYPES.filter((type) => !HIDDEN_FROM_PICKER.has(type)).map((type) => ({
    value: type,
    label: triggerLabel(t, type),
    description: t(`automations.catalog.triggers.${TRIGGER_KEYS[type]}.description`),
    group: nodeGroupLabel(t, TRIGGERS[type].group),
    synonyms: splitSynonyms(t(`automations.catalog.triggers.${TRIGGER_KEYS[type]}.synonyms`)),
  }));
}

/** A branch holds effects only, so the picker inside one drops `if`. */
export function actionPickerEntries(
  t: Translate,
  options: { branch?: boolean } = {}
): NodePickerEntry[] {
  const leaves = LEAF_ACTION_TYPES.map((type) => ({
    value: type,
    label: actionLabel(t, type),
    description: actionDescription(t, type),
    group: nodeGroupLabel(t, ACTIONS[type].group),
    synonyms: splitSynonyms(t(`automations.catalog.actions.${type}.synonyms`)),
  }));
  if (options.branch) return leaves;

  return [
    ...leaves,
    {
      value: 'if',
      label: t('automations.catalog.actions.if.label'),
      description: t('automations.catalog.actions.if.description'),
      group: nodeGroupLabel(t, ACTIONS.if.group),
      synonyms: splitSynonyms(t('automations.catalog.actions.if.synonyms')),
    },
  ];
}

/** Once something is picked, the picker leads with the rest of that group. */
export function suggestedValues(
  entries: readonly NodePickerEntry[],
  chosen: readonly string[]
): string[] {
  const last = chosen[chosen.length - 1];
  if (last === undefined) return [];
  const group = entries.find((entry) => entry.value === last)?.group;
  if (group === undefined) return [];

  return entries
    .filter((entry) => entry.group === group && !chosen.includes(entry.value))
    .slice(0, 3)
    .map((entry) => entry.value);
}
