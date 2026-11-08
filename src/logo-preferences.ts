import { normalizeLogoDesign, type LogoDesign } from './logo-design.ts';
import { readMediaPreferences } from './media-preferences.ts';
import type { LayerSettings } from './media';

export const LOGO_PREFERENCES_KEY = 'vjsystem-logo-maker-v1';
export interface LogoPreferences {
  version: 1;
  draft: LogoDesign;
  /** Recipe last applied to the logo layer; editing a draft does not replace it. */
  applied: LogoDesign | null;
  layer: LayerSettings;
}

export function readLogoPreferences(raw: string | null): LogoPreferences {
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 1) saved = value as Record<string, unknown>;
  } catch { /* A damaged draft must not interrupt the show. */ }
  const applied = saved.applied && typeof saved.applied === 'object' && !Array.isArray(saved.applied)
    && typeof (saved.applied as Record<string, unknown>).text === 'string'
    ? normalizeLogoDesign(saved.applied) : null;
  const layer = readMediaPreferences(JSON.stringify({ logo: { fileName: 'generated.png', settings: saved.layer } })).logo!.settings;
  return { version: 1, draft: normalizeLogoDesign(saved.draft), applied: applied?.text.trim() ? applied : null, layer };
}

export function writeLogoPreferences(value: LogoPreferences): string {
  return JSON.stringify(readLogoPreferences(JSON.stringify(value)));
}
