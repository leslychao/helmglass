/** Public browser metadata used by both the input guard and observation filter. */
export function inspectPrivateInput(element: Element, accessibleName: string):
  { protectedInput: boolean; hiddenName: boolean } {
  const typeValue = element.getAttribute("type") ?? "";
  const values = ["autocomplete", "name", "id", "aria-label", "aria-labelledby", "aria-describedby"]
    .map(key => element.getAttribute(key) ?? "");
  if (typeValue.length > 100 || values.some(value => value.length > 1000))
    return { protectedInput: true, hiddenName: true };
  const root = element.getRootNode();
  const sourceLabel = (id: string) => root instanceof Document || root instanceof ShadowRoot
    ? root.getElementById(id) : null;
  const hiddenName = ["aria-labelledby", "aria-describedby"].some(attribute =>
    (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean).some(id => {
      const source = sourceLabel(id);
      return source !== null && (source.closest('[hidden], [aria-hidden="true"]') !== null
        || source.getClientRects().length === 0);
    }));
  const editable = element.matches('input, textarea, select, [contenteditable], [role="textbox"]');
  let labelText = accessibleName;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement) {
    for (const label of element.labels ?? []) {
      const text = label.textContent ?? "";
      if (labelText.length + text.length > 1000) return { protectedInput: true, hiddenName };
      labelText += " " + text;
    }
  }
  if (editable) {
    for (const id of (element.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
      const text = sourceLabel(id)?.textContent ?? "";
      if (labelText.length + text.length > 1000) return { protectedInput: true, hiddenName };
      labelText += " " + text;
    }
  }
  const hints = values.join(" ") + (editable ? " " + labelText : "");
  const protectedInput = ["password", "hidden"].includes(typeValue.toLowerCase())
    || /password|passwd|one.?time.?code|otp|verification.?code|security.?code|cc-|cc_?(?:number|exp|csc)|card.?number|cvc|cvv|payment|парол|однораз|код.подтверж|номер.карт/i.test(hints)
    || editable && hiddenName;
  return { protectedInput, hiddenName };
}

export function snapshotUrl(value: string): string | undefined {
  if (value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "about:"].includes(url.protocol)) return undefined;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return undefined; }
}
