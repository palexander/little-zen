import { DEFAULT_TIMEOUT_SEC, type Rule } from './rules';

export interface Preset {
  id: string;
  /** Bump when the patterns change so unmodified copies pick up the update. */
  version: number;
  name: string;
  include: string[];
  exclude: string[];
  enabledByDefault: boolean;
  /** `_locales` message keys. */
  descriptionKey: string;
  warningKey?: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'zoom',
    version: 1,
    name: 'Zoom',
    // Zoom appends #success only once the desktop client has launched.
    include: ['^https://([a-z0-9-]+\\.)?zoom(gov)?\\.us/[jsw]/[^/?#]+[^#]*#success$'],
    exclude: [],
    enabledByDefault: true,
    descriptionKey: 'presetZoom',
  },
  {
    id: 'slack',
    version: 1,
    name: 'Slack',
    include: ['^https://([a-z0-9-]+\\.)?(enterprise\\.)?slack\\.com/(archives/|app_redirect\\b|ssb/(signin_)?redirect)'],
    exclude: [],
    enabledByDefault: true,
    descriptionKey: 'presetSlack',
  },
  {
    id: 'teams',
    version: 1,
    name: 'Microsoft Teams',
    include: ['^https://teams\\.(microsoft\\.com|live\\.com|cloud\\.microsoft)/dl/launcher/launcher\\.html\\?'],
    exclude: [],
    enabledByDefault: true,
    descriptionKey: 'presetTeams',
  },
  {
    id: 'notion',
    version: 1,
    name: 'Notion',
    include: ['^https://(www\\.notion\\.so|app\\.notion\\.com)/native/.*[?&]deepLinkOpenNewTab=true'],
    exclude: [],
    enabledByDefault: true,
    descriptionKey: 'presetNotion',
  },
  {
    id: 'discord',
    version: 1,
    name: 'Discord',
    include: ['^https://(discord(app)?\\.com/invite|discord\\.gg)/[a-z0-9-]+/?(\\?.*)?$'],
    exclude: [],
    enabledByDefault: true,
    descriptionKey: 'presetDiscord',
  },
  {
    id: 'linear',
    version: 1,
    name: 'Linear',
    // Linear adds noRedirect=1 after handing the link to the desktop app.
    include: ['^https://linear\\.app/[^/]+/.*[?&]noRedirect=1(&|#|$)'],
    exclude: ['^https://linear\\.app/[^/]+/(settings|integrations)\\b'],
    enabledByDefault: true,
    descriptionKey: 'presetLinear',
  },
  {
    id: 'figma',
    version: 1,
    name: 'Figma',
    include: ['^https://(www\\.)?figma\\.com/(file|design|board|slides)/[a-z0-9]+'],
    exclude: [],
    enabledByDefault: false,
    descriptionKey: 'presetFigma',
    warningKey: 'presetWarningNoMarker',
  },
  {
    id: 'spotify',
    version: 1,
    name: 'Spotify',
    include: ['^https://open\\.spotify\\.com/(intl-[a-z-]+/)?(track|album|playlist|episode|show|artist)/[a-z0-9]+'],
    exclude: [],
    enabledByDefault: false,
    descriptionKey: 'presetSpotify',
    warningKey: 'presetWarningNoMarker',
  },
];

export function getPreset(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function presetToRule(preset: Preset, fields: Partial<Rule> = {}): Rule {
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    include: [...preset.include],
    exclude: [...preset.exclude],
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    enabled: preset.enabledByDefault,
    presetId: preset.id,
    presetVersion: preset.version,
    modified: false,
    ...fields,
  };
}

export function seedRules(): Rule[] {
  return PRESETS.map((p) => presetToRule(p));
}

/** Restores a preset rule's defaults in place, keeping its id, position and enabled state. */
export function resetToPreset(rule: Rule, preset: Preset): Rule {
  return presetToRule(preset, { id: rule.id, enabled: rule.enabled });
}

/** Brings unmodified preset rules up to the latest preset version; edited ones are left alone. */
export function applyPresetUpdates(rules: Rule[]): { rules: Rule[]; changed: boolean } {
  let changed = false;
  const updated = rules.map((rule) => {
    const preset = getPreset(rule.presetId);
    if (!preset || rule.modified || (rule.presetVersion ?? 0) >= preset.version) return rule;
    changed = true;
    return presetToRule(preset, { id: rule.id, enabled: rule.enabled, timeoutSec: rule.timeoutSec });
  });
  return { rules: updated, changed };
}

/**
 * Editing a preset rule's name or patterns takes it out of automatic updates. Timeout and
 * enabled are preserved across updates, so changing them doesn't count.
 */
export function markModified(before: Rule, after: Rule): Rule {
  if (!after.presetId || after.modified) return after;
  const same =
    before.name === after.name &&
    before.include.join('\n') === after.include.join('\n') &&
    before.exclude.join('\n') === after.exclude.join('\n');
  return same ? after : { ...after, modified: true };
}
