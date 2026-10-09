import type { Page } from "playwright";

export type SavedCredential = { origin: string; username: string; password: string };

/** Passwords only cross the private worker-to-renderer boundary, never an observation. */
export async function fillSavedCredential(page: Page, credential: SavedCredential): Promise<boolean> {
  const url = new URL(page.url());
  if (url.protocol !== "https:" || url.origin !== credential.origin) return false;
  return page.evaluate(({ origin, username, password }) => {
    if (location.origin !== origin || location.protocol !== "https:") return false;
    const visible = (input: HTMLInputElement) => !input.disabled
      && input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
    const passwords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
      .filter((input) => visible(input) && !input.readOnly && !/new-password|one-time-code/i.test(input.autocomplete));
    if (passwords.length > 1) return false;
    const passwordInput = passwords[0];
    const root = passwordInput?.form ?? document;
    const users = [...root.querySelectorAll<HTMLInputElement>('input[autocomplete="username"],input[type="email"],input[type="tel"],input[name="login"],input[name="username"]')].filter(visible);
    if (users.length > 1) return false;
    const user = users[0];
    const form = passwordInput?.form ?? user?.form;
    if (form && new URL(form.action || location.href, location.href).origin !== origin) return false;
    // A password-only step does not establish which account it authenticates.
    if (!user || (user.value && user.value !== username) || (user.readOnly && !user.value)) return false;
    const set = (input: HTMLInputElement | undefined, value: string) => {
      if (!input || input.readOnly || input.value) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const usernameFilled = set(user, username);
    const passwordFilled = set(passwordInput, password);
    return usernameFilled || passwordFilled;
  }, credential);
}
