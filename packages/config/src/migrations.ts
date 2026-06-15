import { CONFIG_SCHEMA_VERSION } from './schema'

/** Raised when a config can't be brought to the current schema version (D17). */
export class ConfigVersionError extends Error {
  override name = 'ConfigVersionError'
}

/** Upgrades a raw config object from version N to N+1. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * Apply ordered migration steps to bring `raw` from `fromVersion` up to
 * `toVersion`, stamping `schemaVersion` after each step. Exported (and taking
 * `steps` explicitly) so the engine is unit-testable without real future
 * versions. Throws if any step in the path is missing.
 */
export function runMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  steps: Record<number, Migration>,
): Record<string, unknown> {
  let obj = raw
  for (let v = fromVersion; v < toVersion; v++) {
    const step = steps[v]
    if (!step) {
      throw new ConfigVersionError(`no migration path from config version ${v} to ${v + 1}`)
    }
    obj = { ...step(obj), schemaVersion: v + 1 }
  }
  return obj
}

/** Read the integer `schemaVersion` from a raw value; 0 means unversioned. */
export function detectVersion(raw: unknown): number {
  if (raw !== null && typeof raw === 'object' && 'schemaVersion' in raw) {
    const v = (raw as { schemaVersion: unknown }).schemaVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  }
  return 0
}

/** No historical versions yet — v1 is the first. Future: `{ 1: v1ToV2, ... }`. */
const MIGRATIONS: Record<number, Migration> = {}

/**
 * Bring a raw, parsed config value to the current schema version. A newer
 * version than this build supports is a hard error; an unversioned value is
 * returned as-is so the strict schema produces a clear "schemaVersion" error
 * rather than an opaque migration failure.
 */
export function migrate(raw: unknown): unknown {
  const version = detectVersion(raw)
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new ConfigVersionError(
      `config schemaVersion ${version} is newer than this build supports (${CONFIG_SCHEMA_VERSION}); upgrade open-consensus`,
    )
  }
  if (version < 1) return raw
  return runMigrations(raw as Record<string, unknown>, version, CONFIG_SCHEMA_VERSION, MIGRATIONS)
}
