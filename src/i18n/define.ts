/**
 * One area's UI strings. `en` must provide exactly the keys of `es`, and error
 * codes map to [Spanish, English]. Keys are prefixed with the area name so
 * modules never collide (tests/i18n.test.ts enforces uniqueness).
 */
export function defineArea<const Es extends Record<string, string>>(area: {
  es: Es;
  en: { [K in keyof Es]: string };
  errors?: Record<string, readonly [string, string]>;
}) {
  return { errors: {}, ...area };
}
