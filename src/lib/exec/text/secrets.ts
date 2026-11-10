// C46's credential masker, a leaf module (no imports). P9 fixer security-5 moved it here from text/untrusted.ts unchanged:
// triage/email-text.ts masks message bodies with it now, and untrusted.ts imports email-text.ts, so the masker has to live
// where both can import it without a cycle. text/untrusted.ts re-exports it, so its earlier importers are unchanged.

const HIDDEN = "[hidden]";
// C46: a credential label, whole word, any case, then ":" or "=" and a value on the same line. The longer labels come
// first so "username/password" is not read as "username" + "/password".
const SECRET_LABEL =
  /(?<![A-Za-z0-9_])(username\/password|user\/pass|client[^\S\n]+secret|api[^\S\n]+key|apikey|password|passcode|secret|token|login|pwd|pass)(?![A-Za-z0-9_])[^\S\n]*[:=][^\S\n]*(?=\S)[^\n]*/gi;
// C46: a long run of key-like characters (an API key, a token) holding at least one letter and one digit.
const SECRET_RUN = /[A-Za-z0-9_-]{32,}/g;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;

/**
 * C46. A label (password, passcode, pwd, pass, login, user/pass, username/password, token, api key, apikey, secret,
 * client secret; any case, whole word) followed by ":" or "=" keeps the label and loses the value up to the end of the
 * line ("<label>: [hidden]"); a run of 32 or more characters of [A-Za-z0-9_-] holding a letter and a digit becomes
 * "[hidden]". masked = anything changed.
 */
export function maskSecrets(s: string): { text: string; masked: boolean } {
  if (typeof s !== "string" || s === "") return { text: "", masked: false };
  let masked = false;
  const labelled = s.replace(SECRET_LABEL, (_all, label: string) => {
    masked = true;
    return `${label}: ${HIDDEN}`;
  });
  const text = labelled.replace(SECRET_RUN, (run) => {
    if (!HAS_LETTER.test(run) || !HAS_DIGIT.test(run)) return run;
    masked = true;
    return HIDDEN;
  });
  return { text, masked };
}
