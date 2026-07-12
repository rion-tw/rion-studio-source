export function isKnownLoginUrl(value: string): boolean {
  const normalized = value.toLowerCase();

  return (
    normalized.includes("accounts.google.com") ||
    normalized.includes("facebook.com") ||
    normalized.includes("oauth") ||
    normalized.includes("signin") ||
    normalized.includes("login")
  );
}

export function containsLoginPromptText(bodyText: string): boolean {
  const normalized = bodyText.toLowerCase().replace(/\s+/g, " ");

  return LOGIN_PROMPT_PHRASES.some((phrase) => normalized.includes(phrase));
}

const LOGIN_PROMPT_PHRASES = [
  "log in with facebook",
  "login with facebook",
  "continue with facebook",
  "sign in with facebook",
  "facebook login",
  "log in with google",
  "login with google",
  "continue with google",
  "sign in with google",
  "google login",
  "使用 facebook 登入",
  "使用 google 登入",
  "facebook 登入",
  "google 登入",
  "以 facebook 登入",
  "以 google 登入",
  "透過 facebook 登入",
  "透過 google 登入"
];
